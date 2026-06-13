/**
 * Shared internals for the consumer testing primitives.
 *
 * Builds a real RequestContext via the same createRequestContext the RSC
 * handler uses, with test-friendly defaults, so loaders and middleware run
 * with production-fidelity context (cookies, headers, get/set, use, reverse)
 * instead of a hand-rolled mock.
 */

import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { resolveLocationStateEntries } from "../../browser/react/location-state-shared.js";
import { createReverseFunction } from "../../router/handler-context.js";
import { normalizeBasename } from "../../router/basename.js";
import {
  seedVariables,
  resolveSeededStateCookieName,
  type VarsInit,
  type StateCookieSeed,
} from "./seed-vars.js";
import type { ThemeConfig } from "../../theme/types.js";
import { resolveThemeConfig } from "../../theme/constants.js";
import type { SegmentCacheStore } from "../../cache/types.js";
import type { CacheProfile } from "../../cache/profile-registry.js";

const DEFAULT_ORIGIN = "http://localhost/";

// VarsInit + seedVariables live in ./seed-vars.js (react-server-safe) so the
// Flight tier can seed vars too; re-exported here for existing importers.
export type { VarsInit, StateCookieSeed };
export { seedVariables };

/** Normalize a Request | string | undefined into a concrete Request. */
export function toRequest(
  request: Request | string | undefined,
  init?: RequestInit,
): Request {
  if (request instanceof Request) return request;
  if (typeof request === "string") {
    return new Request(new URL(request, DEFAULT_ORIGIN), init);
  }
  return new Request(DEFAULT_ORIGIN, init);
}

export interface CreateTestContextOptions<TEnv> {
  env?: TEnv;
  request?: Request | string;
  requestInit?: RequestInit;
  /** Backing store for ctx.get()/ctx.set(); pre-seeded from `vars`. */
  variables?: Record<string, unknown>;
  /** Variables a prior middleware would have set (object or [key, value] list). */
  vars?: VarsInit;
  /** Route name -> pattern map enabling ctx.reverse() without global state. */
  routeMap?: Record<string, string>;
  routeName?: string;
  params?: Record<string, string>;
  /**
   * Router basename for this request (what the RSC handler stores on the
   * context). Drives redirect() prefixing. Normalized exactly like
   * createRouter({ basename }) (leading slash forced, trailing stripped, bare
   * "/" -> undefined) so passing the same value your router takes yields the
   * same redirect Location. Defaults to undefined (no basename).
   */
  basename?: string;
  /**
   * Cache store backing `use cache` functions invoked during the test, the
   * same shape `createRouter({ cache })` resolves. Without it,
   * registerCachedFunction bypasses (it checks for a store FIRST), so a cached
   * function runs uncached and its taint/profile guards never fire. Wire one
   * (e.g. `new MemorySegmentCacheStore()`) to exercise real cache behavior.
   */
  cacheStore?: SegmentCacheStore;
  /**
   * Cache profiles in the `createRouter({ cacheProfiles })` shape. Required for
   * a `use cache: "profileName"` function to resolve its profile (an unknown
   * profile throws), once a `cacheStore` is wired.
   */
  cacheProfiles?: Record<string, CacheProfile>;
  /**
   * Theme config in the same shape `createRouter({ theme })` takes (resolved
   * internally). Without it `ctx.theme`/`ctx.setTheme` are inert (undefined),
   * mirroring an app with no theme configured. Pass one (e.g. `true`, or
   * `{ themes: [...] }`) to exercise a handler that reads them.
   */
  theme?: ThemeConfig | true;
  /**
   * Customize the rango state cookie that `invalidateClientCache()` rotates.
   * The name is ALWAYS seeded (default `rango-state_router_0`) so a call to
   * `invalidateClientCache()` rotates and emits the `Set-Cookie` exactly as in
   * production, rather than silently no-opping. Override `prefix`/`routerId` to
   * match your `createRouter({ stateCookiePrefix, id })` so the test asserts the
   * same name, or `version` (the build identifier prefixed to the rotated
   * `{version}:{timestamp}` value, default `"0"`). Assert
   * `response.headers.getSetCookie()` against the resolved `stateCookieName`
   * (returned by `runInRequestContext`).
   */
  stateCookie?: StateCookieSeed;
}

/**
 * The seeded RequestContext with its `reverse` RELAXED to accept any route NAME
 * from the `routeMap` you passed, rather than the global `Rango.GeneratedRouteMap`
 * union — so reversing a test-only route name is not a type error (it works at
 * runtime; the names come from your `routeMap`). Mirrors runLoader's
 * `TestLoaderContext.reverse`. Everything else is the real `RequestContext`.
 */
export type TestRequestContextObject<TEnv> = Omit<
  RequestContext<TEnv>,
  "reverse"
> & {
  reverse: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string;
};

export interface TestRequestContext<TEnv> {
  ctx: TestRequestContextObject<TEnv>;
  request: Request;
  url: URL;
  variables: Record<string, unknown>;
  /**
   * The resolved rango state cookie name seeded into the context (default
   * `rango-state_router_0`, or composed from `opts.stateCookie`). The name a
   * call to `invalidateClientCache()` rotates.
   */
  stateCookieName: string;
}

/**
 * Create a real RequestContext for unit-testing loaders/middleware.
 *
 * The returned `ctx` must be ENTERED before use — wrap your call in
 * `runWithRequestContext(ctx, fn)` (re-exported from `@rangojs/router/testing`)
 * so that cookie/header mutations and `getRequestContext()` resolve. For the
 * common case prefer {@link runInRequestContext}, which builds AND enters the
 * context in a single call.
 */
export function createTestRequestContext<TEnv>(
  opts: CreateTestContextOptions<TEnv> = {},
): TestRequestContext<TEnv> {
  const request = toRequest(opts.request, opts.requestInit);
  const url = new URL(request.url);
  const variables = seedVariables(opts.variables ?? {}, opts.vars);
  // Always seed a resolved name so invalidateClientCache() rotates (and emits
  // the Set-Cookie) like production instead of no-opping; opts.stateCookie
  // customizes the name/version. Surfaced on the result so a consumer asserts
  // the rotation against the same name without recomputing it.
  const stateCookieName = resolveSeededStateCookieName(opts.stateCookie);
  const ctx = createRequestContext<TEnv>({
    env: (opts.env ?? {}) as TEnv,
    request,
    url,
    variables,
    themeConfig:
      opts.theme === undefined ? undefined : resolveThemeConfig(opts.theme),
    cacheStore: opts.cacheStore,
    cacheProfiles: opts.cacheProfiles,
    stateCookieName,
    version: opts.stateCookie?.version,
  });
  if (opts.basename !== undefined)
    ctx._basename = normalizeBasename(opts.basename);
  if (opts.params) ctx.params = opts.params;
  if (opts.routeMap) {
    ctx._routeName = opts.routeName;
    ctx.reverse = createReverseFunction(
      opts.routeMap,
      opts.routeName,
      opts.params ?? {},
    ) as RequestContext<TEnv>["reverse"];
  }
  // ctx.reverse is assigned the routeMap-scoped reverse (string-accepting) above;
  // expose it through the relaxed type so a test reverses a local route name
  // without casting. The runtime value matches; RequestContext's reverse is
  // declared against the narrower global route-name union, hence the cast.
  return {
    ctx: ctx as unknown as TestRequestContextObject<TEnv>,
    request,
    url,
    variables,
    stateCookieName,
  };
}

/**
 * What a run accumulated on the request context, surfaced as PUBLIC values so a
 * test never has to cast through the `@internal` `ctx.res` / `ctx.cookies()` to
 * assert what an action produced.
 */
export interface RunInRequestContextResult<T> {
  /**
   * The value `fn` returned (awaited), or `undefined` if `fn` threw — in which
   * case the thrown value is on {@link thrown}. The snapshot below is captured
   * either way.
   */
  result: T | undefined;
  /**
   * The value `fn` threw, or `undefined` if it returned normally. Commonly a
   * `Response` from `throw redirect(...)` / `throw notFound()` — the dominant
   * cookie+flash case is an action that sets them then throws a redirect — so
   * this (and the snapshot below) is observable WITHOUT wrapping the action in
   * your own try/catch. NOTE: the value is captured, NOT re-thrown; assert on it
   * for a throwing action.
   */
  thrown: unknown;
  /**
   * A Response carrying the status, headers, and Set-Cookie the run set (via
   * `cookies().set()`, `ctx.header()`, etc.). Assert Set-Cookie with
   * `response.headers.getSetCookie()`. When `fn` threw a `Response` (a redirect),
   * THIS is that Response with the accumulated Set-Cookie/headers merged in
   * (mirroring how the framework merges them in production), so a redirect's
   * Location AND the cookies it set are both observable here.
   */
  response: Response;
  /**
   * The effective cookie view after the run: request cookies merged with
   * anything the run set or deleted (last-write-wins), as `{ name: value }`.
   */
  cookies: Record<string, string>;
  /**
   * The response headers the run set (via `ctx.header(...)`, plus a thrown
   * redirect's `Location`), as a plain `{ name: value }` object — the same view
   * as `response.headers`, but assertable like `cookies`/`locationState`.
   * EXCLUDES `set-cookie` (use `cookies`, or `response.headers.getSetCookie()`).
   * Header names are lowercased (HTTP headers are case-insensitive).
   */
  headers: Record<string, string>;
  /**
   * Location state the run set via `ctx.setLocationState()` / `redirect({ state })`,
   * resolved to the flat `{ key: value }` shape the client reads off
   * `history.state` (empty object when none) — so a post-action flash ("Saved!")
   * is assertable at the unit layer.
   */
  locationState: Record<string, unknown>;
  /**
   * The resolved rango state cookie name seeded into the run (default
   * `rango-state_router_0`, or composed from `opts.stateCookie`). Assert an
   * action's `invalidateClientCache()` rotation against it without recomputing:
   * `response.headers.getSetCookie().some((c) => c.startsWith(stateCookieName + "="))`.
   */
  stateCookieName: string;
}

/**
 * Snapshot the observable effects a run left on `ctx` (cookies + location
 * state). Reads the fields directly off the ctx object, so it works both inside
 * and outside the AsyncLocalStorage scope (no `getRequestContext()`). Headers are
 * snapshotted separately from the final {@link Response} (via
 * {@link headersToObject}) so a thrown redirect's `Location` is included.
 */
export function snapshotRunEffects<TEnv>(ctx: RequestContext<TEnv>): {
  cookies: Record<string, string>;
  locationState: Record<string, unknown>;
} {
  return {
    cookies: { ...ctx.cookies() },
    locationState: resolveLocationStateEntries(ctx._locationState ?? []),
  };
}

/**
 * The response headers as a plain `{ name: value }` object, EXCLUDING
 * `set-cookie` (surfaced parsed on `cookies`). Names are lowercased (HTTP header
 * names are case-insensitive). Read from the final response so a thrown
 * redirect's `Location` and any `ctx.header(...)` both appear.
 */
export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    out[name] = value;
  });
  return out;
}

/**
 * Build the observable response from what the run accumulated on `ctx.res`. When
 * `fn` threw a `Response` (a `redirect()`/`notFound()`), that Response IS the
 * response — merge the accumulated Set-Cookie/other headers into it (the
 * framework does this when it catches the thrown Response in production), with
 * its status/Location preserved. Otherwise snapshot the stub (status + headers).
 * The `Response`/`Headers` constructors copy, so the result is immutable.
 */
export function buildRunResponse<TEnv>(
  ctx: RequestContext<TEnv>,
  thrown: unknown,
): Response {
  const stub = ctx.res;
  if (thrown instanceof Response) {
    const headers = new Headers(thrown.headers);
    for (const cookie of stub.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
    stub.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") return;
      if (!headers.has(name)) headers.set(name, value);
    });
    return new Response(null, { status: thrown.status, headers });
  }
  return new Response(null, { status: stub.status, headers: stub.headers });
}

/**
 * Snapshot the shared run-result envelope fields (everything except the primary
 * value) from what a run left on `ctx`: the captured `thrown`, the merged
 * `response`, the effective `cookies`/`headers` views, the `locationState`, and
 * the resolved `stateCookieName`. Shared by `runInRequestContext` and
 * `runLoaderResult` so the snapshot sequence lives once; each spreads it next to
 * its own primary field (`result` / `data`).
 */
export function buildRunSnapshot<TEnv>(
  ctx: RequestContext<TEnv>,
  thrown: unknown,
  stateCookieName: string,
): {
  thrown: unknown;
  response: Response;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  locationState: Record<string, unknown>;
  stateCookieName: string;
} {
  const { cookies, locationState } = snapshotRunEffects(ctx);
  const response = buildRunResponse(ctx, thrown);
  const headers = headersToObject(response.headers);
  return { thrown, response, cookies, headers, locationState, stateCookieName };
}

/**
 * Build a seeded RequestContext (via {@link createTestRequestContext}) and run
 * `fn` inside it, so code under test that calls `getRequestContext()`,
 * `cookies()`, or reads/mutates request headers resolves exactly as in
 * production.
 *
 * This is the entry point for the advanced cases the unit wrappers
 * (`runLoader` / `runMiddleware`) do not model — most notably a server ACTION
 * that authenticates off the request cookie or sets a session cookie / flash:
 * an action has no loader context, so `runLoader` is the wrong shape, yet it
 * still needs a real request context to read the cookie and resolve
 * `getRequestContext()`.
 *
 * Returns `{ result, thrown, response, cookies, headers, locationState }` so the
 * action's OUTPUT (Set-Cookie, response headers, flash) is assertable without
 * casting through the `@internal` `ctx.res` / `ctx.cookies()`. `fn` may be async — the context stays
 * active across its awaits (AsyncLocalStorage), and the snapshot is captured
 * whether `fn` returns OR throws. The throw path matters: the most common
 * cookie+flash case is an auth action that sets a cookie + flash then
 * `throw redirect(...)` on success — the thrown redirect is on `thrown` (NOT
 * re-thrown) and its Location plus the cookies are on `response`/`cookies`.
 *
 * @example
 * ```ts
 * const { result, cookies, response, thrown } = await runInRequestContext(
 *   () => loginAction(input), // sets a session cookie, then `throw redirect("/app")`
 *   {
 *     env,
 *     request: new Request("https://app.test/", {
 *       headers: { Cookie: "sid=abc" },
 *     }),
 *   },
 * );
 * expect(cookies.session).toBe("new-token");
 * expect(headers.location).toBe("/app"); // response headers as a plain object
 * expect((thrown as Response).headers.get("Location")).toBe("/app");
 * expect(response.headers.getSetCookie()).toContainEqual(
 *   expect.stringContaining("session="),
 * );
 * ```
 */
export async function runInRequestContext<T, TEnv = unknown>(
  fn: (ctx: RequestContext<TEnv>) => T | Promise<T>,
  opts: CreateTestContextOptions<TEnv> = {},
): Promise<RunInRequestContextResult<T>> {
  const { ctx, stateCookieName } = createTestRequestContext<TEnv>(opts);
  let result: T | undefined;
  let thrown: unknown;
  try {
    result = (await runWithRequestContext(ctx, () => fn(ctx))) as T;
  } catch (error) {
    // Capture (do NOT re-throw): a redirect/notFound action throws its Response
    // on the SUCCESS path, and its cookie/flash output must stay observable.
    thrown = error;
  }
  return { result, ...buildRunSnapshot(ctx, thrown, stateCookieName) };
}
