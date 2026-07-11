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
  getCurrentLoaderBodyId,
  isInsideHandlerInvokedLoaderBody,
} from "./context.js";
import { INSIDE_CACHE_EXEC } from "../cache/taint.js";
import { assertNotInsidePrerenderProducer } from "../prerender/producer-guard.js";

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
  assertNotInsidePrerenderProducer(ctx, "cookies()");
  assertNotInsideCacheContext(ctx, "cookies");
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

/**
 * Throw if called during the ACTIVE background shell-capture render
 * (`_shellCaptureRun` true on the derived request context built by
 * shell-capture.ts). The captured shell prelude is shared across every user
 * hitting the URL, so a request-scoped read here would bake one user's
 * cookies/headers into markup served to others — same hazard as the cache
 * scopes above, at the document tier. DSL segment loaders need no exemption:
 * the live lane is masked (never executed) during capture, and the bake lane
 * is exactly what this guard exists for.
 *
 * HANDLER-INVOKED loader bodies (`await ctx.use(Loader)` from a handler) are
 * EXEMPT — the consumption-lane rule: handler consumption yields a BAKED
 * shared copy in every artifact tier, and the cache-purity guards above
 * already permit identity reads there (cache()/"use cache" bake the same
 * reads today). Guarding only the PPR tier made the same code legal under
 * cache() but capture-refusing under ppr (issue #672 / #674). The trade is
 * documented: an identity read in a handler-consumed loader bakes the CAPTURE
 * request's value into the shared shell; client-side consumption (useLoader)
 * is the live lane.
 *
 * Keys off `_shellCaptureRun`, NOT the `_shellCapture` descriptor: the descriptor
 * is also present during the FOREGROUND render (it means "a capture is wanted"),
 * and the foreground must read cookies/headers normally to serve the real user.
 * Only the derived capture context sets `_shellCaptureRun`.
 *
 * Applies only to the READ surfaces (cookies(), headers()) whose values
 * become markup. Response directives (invalidateClientCache(),
 * keepClientCache()) stay callable: during capture they are header effects on
 * a discarded response, and on the live HIT path the full pipeline runs so their
 * headers flow to the client normally.
 *
 * The throw makes such a route PPR-ineligible by construction: the capture
 * render errors, nothing is stored, and every request keeps getting the
 * normal axis-1 render.
 */
function assertNotInsideShellCapture(ctx: unknown, fnName: string): void {
  if (
    ctx !== null &&
    typeof ctx === "object" &&
    (ctx as { _shellCaptureRun?: unknown })._shellCaptureRun === true
  ) {
    if (isInsideHandlerInvokedLoaderBody()) return;
    // Flag the capture context BEFORE throwing: inside an executing bake-lane
    // loader this throw is swallowed by wrapLoaderPromise into per-loader error
    // UI, which would bake silently into the shared shell. The capture checks
    // the flag after the render and refuses (shell-capture.ts). Also record
    // WHICH loader body (if any) made the read, so the refusal warning can
    // name the real source instead of hardcoding a lane — the read may come
    // from a bake-lane loader OR from handler/render code (issue #672).
    (ctx as { _shellCaptureGuardTripped?: string })._shellCaptureGuardTripped =
      fnName;
    (
      ctx as { _shellCaptureGuardTrippedLoaderId?: string }
    )._shellCaptureGuardTrippedLoaderId = getCurrentLoaderBodyId();
    throw new Error(
      `${fnName}() cannot be called while capturing a shared shell ` +
        `(shell-cache middleware). The captured shell is served to every user ` +
        `of this URL, so request-scoped data read here would leak one user's ` +
        `${fnName === "cookies" ? "cookies" : "headers"} to others. Read it ` +
        `inside a loader instead — loaders are never captured and always run ` +
        `fresh per request:\n\n` +
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
  assertNotInsidePrerenderProducer(ctx, "headers()");
  assertNotInsideCacheContext(ctx, "headers");
  assertNotInsideShellCapture(ctx, "headers");
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
  assertNotInsidePrerenderProducer(ctx, "invalidateClientCache()");
  assertNotInsideCacheContext(ctx, "invalidateClientCache");
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
  assertNotInsidePrerenderProducer(ctx, "keepClientCache()");
  assertNotInsideCacheContext(ctx, "keepClientCache");
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
