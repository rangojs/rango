/**
 * Cookie Store — Next.js-style cookie facade backed by the response-derived model.
 *
 * `cookies()` returns a CookieStore scoped to the current request.
 * Reads merge the original Cookie header with Set-Cookie mutations
 * already queued on the response stub (last-write-wins).
 * Writes append Set-Cookie to the response stub.
 */

import type { CookieOptions } from "../router/middleware-types.js";
import { getRequestContext } from "./request-context.js";
import { isInsideCacheScope } from "./context.js";
import { INSIDE_CACHE_EXEC } from "../cache/taint.js";

/**
 * A single cookie entry returned by get() and getAll().
 */
export interface Cookie {
  name: string;
  value: string;
}

/**
 * Request-scoped cookie store.
 *
 * Reads see the effective merged view (original request + same-request mutations).
 * Writes append Set-Cookie headers to the shared response stub.
 */
export interface CookieStore {
  /** Get a single cookie by name. Returns undefined if not set or deleted. */
  get(name: string): Cookie | undefined;

  /** Get all effective cookies, or all cookies with a given name. */
  getAll(name?: string): Cookie[];

  /** Check whether a cookie exists in the effective view. */
  has(name: string): boolean;

  /** Set a cookie (appends Set-Cookie to the response stub). */
  set(name: string, value: string, options?: CookieOptions): void;

  /** Delete a cookie (appends Set-Cookie with maxAge=0 to the response stub). */
  delete(name: string, options?: Pick<CookieOptions, "domain" | "path">): void;
}

/**
 * Get the request-scoped cookie store.
 *
 * Must be called inside a request context (middleware, handler, loader, action).
 * Throws if called outside request scope.
 *
 * @example
 * ```typescript
 * import { cookies } from "@rangojs/router";
 *
 * // In a handler, loader, or action:
 * const session = cookies().get("session")?.value;
 * cookies().set("session", "new-token", { httpOnly: true });
 * cookies().delete("session");
 * ```
 */
export function cookies(): CookieStore {
  const ctx = getRequestContext();
  assertNotInsideCacheContext(ctx, "cookies");
  return createCookieStore(ctx);
}

/**
 * Read-only view of HTTP headers.
 * Exposes only the read methods of the Headers API.
 */
export interface ReadonlyHeaders {
  get(name: string): string | null;
  has(name: string): boolean;
  entries(): HeadersIterator<[string, string]>;
  keys(): HeadersIterator<string>;
  values(): HeadersIterator<string>;
  forEach(
    callback: (value: string, name: string, parent: ReadonlyHeaders) => void,
  ): void;
  [Symbol.iterator](): HeadersIterator<[string, string]>;
}

// Minimal iterator interface (avoids pulling IterableIterator from lib.dom)
type HeadersIterator<T> = IterableIterator<T>;

/**
 * Throw if called inside a cache boundary — either a "use cache" function
 * (`INSIDE_CACHE_EXEC` stamped on ctx by the cache runtime) or a `cache()`
 * DSL boundary (`isInsideCacheScope()` — the render-store flag set while
 * resolving a `type: "cache"` route entry).
 *
 * Reading request-scoped data (cookies, headers) inside a cached scope
 * produces per-request values that are NOT reflected in the cache key, so
 * they would be frozen into the shared cache entry and served to the wrong
 * users. This is the same hazard for both scopes: a `cache()` boundary caches
 * everything except loaders (it is the document-level "PPR shell"), so a read
 * here is baked into the shell exactly like a `"use cache"` return value is
 * baked into its cache entry.
 *
 * `isInsideCacheScope()` returns false inside loaders (loaders always run
 * fresh on every request, even on a cache hit), so reading cookies()/headers()
 * from a loader is allowed — loaders are the dynamic "holes" of a cached
 * document.
 */
function assertNotInsideCacheContext(ctx: unknown, fnName: string): void {
  if (
    ctx !== null &&
    ctx !== undefined &&
    typeof ctx === "object" &&
    (INSIDE_CACHE_EXEC as symbol) in (ctx as Record<symbol, unknown>)
  ) {
    throw new Error(
      `${fnName}() cannot be called inside a "use cache" function. ` +
        `Request-scoped data (cookies, headers) varies per request but is not ` +
        `reflected in the cache key, so cached results would be served to the ` +
        `wrong users. Extract the value before the cached function and pass it ` +
        `as an argument:\n\n` +
        `  const locale = cookies().get("locale")?.value ?? "en";\n` +
        `  const data = await getCachedData(locale); // locale is now in the cache key`,
    );
  }
  if (isInsideCacheScope()) {
    throw new Error(
      `${fnName}() cannot be called inside a cache() boundary. ` +
        `A cache() scope caches everything except loaders, so request-scoped ` +
        `data (cookies, headers) read here would be frozen into the shared ` +
        `cached shell and served to other users. Read it inside a loader ` +
        `instead — loaders always run fresh on every request, even on a cache hit:\n\n` +
        `  loader("user", () => getUser(cookies().get("session")?.value));`,
    );
  }
}

const HEADERS_MUTATION_METHODS = new Set(["set", "append", "delete"]);

/**
 * Get the original request headers (read-only).
 *
 * Must be called inside a request context.
 * Returns a read-only view of the incoming request's headers.
 * Mutation methods (set, append, delete) throw at runtime.
 *
 * @example
 * ```typescript
 * import { headers } from "@rangojs/router";
 *
 * const auth = headers().get("authorization");
 * const contentType = headers().get("content-type");
 * ```
 */
export function headers(): ReadonlyHeaders {
  const ctx = getRequestContext();
  assertNotInsideCacheContext(ctx, "headers");
  return new Proxy(ctx.request.headers, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && HEADERS_MUTATION_METHODS.has(prop)) {
        return () => {
          throw new Error(
            `headers().${prop}() is not allowed. headers() returns a read-only view of request headers. ` +
              `Use ctx.header() to set response headers.`,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as ReadonlyHeaders;
}

/**
 * Create a CookieStore backed by a RequestContext.
 * @internal Shared between cookies() shorthand and context methods.
 */
function createCookieStore(ctx: {
  cookie(name: string): string | undefined;
  cookies(): Record<string, string>;
  setCookie(name: string, value: string, options?: CookieOptions): void;
  deleteCookie(
    name: string,
    options?: Pick<CookieOptions, "domain" | "path">,
  ): void;
}): CookieStore {
  return {
    get(name: string): Cookie | undefined {
      const value = ctx.cookie(name);
      return value !== undefined ? { name, value } : undefined;
    },

    getAll(name?: string): Cookie[] {
      const all = ctx.cookies();
      if (name !== undefined) {
        const value = all[name];
        return value !== undefined ? [{ name, value }] : [];
      }
      return Object.entries(all).map(([n, v]) => ({ name: n, value: v }));
    },

    has(name: string): boolean {
      return ctx.cookie(name) !== undefined;
    },

    set(name: string, value: string, options?: CookieOptions): void {
      ctx.setCookie(name, value, options);
    },

    delete(
      name: string,
      options?: Pick<CookieOptions, "domain" | "path">,
    ): void {
      ctx.deleteCookie(name, options);
    },
  };
}
