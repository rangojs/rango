/**
 * Cookie Store — Next.js-style cookie facade backed by the response-derived model.
 *
 * `cookies()` returns a CookieStore scoped to the current request.
 * Reads merge the original Cookie header with Set-Cookie mutations
 * already queued on the response stub (last-write-wins).
 * Writes append Set-Cookie to the response stub.
 */

import type { CookieOptions } from "../router/middleware-types.js";
import { getRequestContext, _getRequestContext } from "./request-context.js";
import {
  isInsideCacheScope,
  assertNotInsideShellCapture,
  tripShellCaptureGuard,
  recordLoaderIdentityRead,
} from "./context.js";
import { isInsideCacheExecScope } from "../cache/cache-exec-scope.js";

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
  assertNotInsideCacheContext("cookies");
  assertNotInsideShellCapture(ctx, "cookies");
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
 * (`isInsideCacheExecScope()` — the AsyncLocalStorage scope the cache runtime
 * enters around the cached body) or a `cache()` DSL boundary
 * (`isInsideCacheScope()` — the render-store flag set while resolving a
 * `type: "cache"` route entry).
 *
 * Reading request-scoped data (cookies, headers) inside a cached scope
 * produces per-request values that are NOT reflected in the cache key, so
 * they would be frozen into the shared cache entry and served to the wrong
 * users. This is the same hazard for both scopes: a `cache()` boundary caches
 * everything except loaders (it is the document-level "PPR shell"), so a read
 * here is baked into the shell exactly like a `"use cache"` return value is
 * baked into its cache entry.
 *
 * Both checks are scoped so loaders stay exempt — loaders are the dynamic
 * "holes" of a cached document and always run fresh. `isInsideCacheScope()`
 * returns false inside loaders by construction; `isInsideCacheExecScope()`
 * follows the cached body's own async chain, so a loader running in PARALLEL
 * with a slow "use cache" fetch on the same request reads cookies() freely.
 * (Scar: the previous INSIDE_CACHE_EXEC stamp on the shared RequestContext
 * made exactly that parallel read throw for the cached fetch's whole
 * execution window — see cache-exec-scope.ts.)
 *
 * The loader cache() identity reads (#972) are recorded by the read methods
 * instead (createCookieStore, the headers() view), so a write alone is not one.
 */
function assertNotInsideCacheContext(fnName: string): void {
  const scope = refusingCacheScope();
  if (scope === "use cache") {
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
  if (scope === "cache()") {
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

/**
 * The cache scope that refuses a request-scoped read here, or undefined. One
 * owner of the predicates and their order (assertNotInsideCacheContext above),
 * so cookies()/headers() and the theme reads refuse in the same places.
 */
function refusingCacheScope(): "use cache" | "cache()" | undefined {
  if (isInsideCacheExecScope()) return "use cache";
  if (isInsideCacheScope()) return "cache()";
  return undefined;
}

/** The fix for a theme read that a cache() boundary or a ppr capture refuses. */
const THEME_READ_FIX =
  "On ppr and cache() routes, read the theme with useTheme() in a client " +
  "component, or in a live loader (no ssr: false) with cookies().get(<storageKey>). " +
  "The <html> theme class needs neither: the theme script sets it before paint. " +
  "See the /theme skill (node_modules/@rangojs/router/skills/theme/SKILL.md).";

/** The public reads of the visitor's theme cookie that assertThemeReadAllowed guards. */
export type ThemeReadSurface = "ctx.theme" | "getRequestContext().theme";

/**
 * Guard for a read of the visitor's theme: the handler and middleware
 * `ctx.theme` (handler-context.ts, middleware.ts) and `getRequestContext().theme`
 * (request-context.ts). The theme is the visitor's theme cookie, so it is an
 * identity read like cookies(): it refuses in the same scopes, in the same
 * order (refusingCacheScope, then tripShellCaptureGuard in context.ts), with
 * the same exemption (a loader body under cache(); at capture there is none).
 * Before #971 each read was a plain cookie read, so a ppr shell, a cache()
 * entry or a "use cache" entry stored the first visitor's theme and served it
 * to every later visitor.
 *
 * A read the guards allow is recorded on the current loader execution, as a
 * cookies() read method records it (#972, recordLoaderIdentityRead).
 *
 * `ctx` is the request context at read time, as cookies() reads it. The
 * router's own payload read (payloadInitialTheme, rsc/full-payload.ts) goes
 * through the unguarded `_readTheme()`.
 */
export function assertThemeReadAllowed(
  ctx: unknown,
  surface: ThemeReadSurface,
): void {
  const scope = refusingCacheScope();
  if (scope === "use cache") {
    throw new Error(
      `${surface} cannot be read inside a "use cache" function. The theme ` +
        `comes from the visitor's cookie and is not in the cache key, so the ` +
        `first caller's theme would be served to later callers. Read it ` +
        `before the cached function and pass it in as an argument.`,
    );
  }
  if (scope === "cache()") {
    throw new Error(
      `${surface} cannot be read inside a cache() boundary. The theme comes ` +
        `from the visitor's cookie, so the first visitor's theme would be ` +
        `stored in the shared entry and served to everyone. ${THEME_READ_FIX}`,
    );
  }
  if (tripShellCaptureGuard(ctx, surface, THEME_READ_FIX)) {
    throw new Error(
      `${surface} cannot be read while capturing a shared shell (ppr shell ` +
        `capture). The captured shell is served to every visitor of this URL, ` +
        `so the capturing visitor's theme would reach everyone. ${THEME_READ_FIX}`,
    );
  }
  // An identity read like a cookies() read method: a loader cache() fill with
  // no key() refuses an execution that made one (#972).
  recordLoaderIdentityRead(surface, "read");
}

const HEADERS_MUTATION_METHODS = new Set(["set", "append", "delete"]);
// Reading one records the read (#972), like the cookies() read methods: a
// headers() view taken outside a loader and read inside one still counts.
const HEADERS_READ_PROPS = new Set<string | symbol>([
  "get",
  "has",
  "entries",
  "keys",
  "values",
  "forEach",
  "getSetCookie",
  Symbol.iterator,
]);

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
  assertNotInsideCacheContext("headers");
  assertNotInsideShellCapture(ctx, "headers");
  return new Proxy(ctx.request.headers, {
    get(target, prop, receiver) {
      if (HEADERS_READ_PROPS.has(prop)) recordLoaderIdentityRead("headers()");
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
 * Force the calling client's caches to miss from now on, from the server seat:
 * write a rotated `Set-Cookie` for the rango state. The responding client
 * applies it on receipt, and its history cache is marked stale by the
 * jar-divergence observer at its next read. Per-client and lazy — it rotates
 * only the client that receives this response, not every client.
 *
 * Idempotent within a request (one `Set-Cookie`). Inert (a dev warning) when
 * called outside a request context. Like `cookies()`, it throws inside a
 * `"use cache"` / `cache()` boundary, but is allowed from a loader (loaders are
 * the dynamic holes of a cached document).
 */
export function invalidateClientCache(): void {
  const ctx = _getRequestContext();
  if (!ctx) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[rango] invalidateClientCache() was called outside a request context; ignored.",
      );
    }
    return;
  }
  assertNotInsideCacheContext("invalidateClientCache");
  ctx._rotateStateCookie();
}

/**
 * Suppress a server action's automatic client-cache invalidation: tell the
 * action bridge this action changed nothing a route renders, so it should leave
 * the client's state and caches alone (no rotation, no prefetch wipe, no
 * broadcast, no revalidation refetch). Per-response, not per-action-definition —
 * only the execution knows whether anything changed.
 *
 * Sets an internal response header the bridge reads. Idempotent within a
 * request. Inert (a dev warning) outside a request context — there is no
 * automatic invalidation to suppress.
 */
export function keepClientCache(): void {
  const ctx = _getRequestContext();
  if (!ctx) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[rango] keepClientCache() was called outside a request context; ignored.",
      );
    }
    return;
  }
  assertNotInsideCacheContext("keepClientCache");
  ctx._setKeepCacheDirective();
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
      recordLoaderIdentityRead("cookies()");
      const value = ctx.cookie(name);
      return value !== undefined ? { name, value } : undefined;
    },

    getAll(name?: string): Cookie[] {
      recordLoaderIdentityRead("cookies()");
      const all = ctx.cookies();
      if (name !== undefined) {
        const value = all[name];
        return value !== undefined ? [{ name, value }] : [];
      }
      return Object.entries(all).map(([n, v]) => ({ name: n, value: v }));
    },

    has(name: string): boolean {
      recordLoaderIdentityRead("cookies()");
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
