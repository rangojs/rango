/**
 * runMiddleware — unit-test one or more middleware functions in isolation.
 *
 * Executes the middleware chain via the SAME executeLoaderMiddleware the router
 * uses, so ordering, `next()`, short-circuit (return OR throw Response),
 * double-next guards, and header/cookie merging behave identically to
 * production. The chain runs inside runWithRequestContext, so cookie/header
 * mutations and getRequestContext() resolve.
 *
 * The returned `ctx` is the underlying RequestContext (not the per-middleware
 * MiddlewareContext), exposing `ctx.cookies()`, `ctx.get()`, and
 * `ctx.res.headers` for assertions on what the chain produced.
 *
 * `nextCalled` counts how many times the terminal `next()` (the finalHandler)
 * ran: 0 when the chain short-circuited, 1 when it ran to completion.
 */

import {
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { executeLoaderMiddleware } from "../router/middleware.js";
import { createReverseFunction } from "../router/handler-context.js";
import type { MiddlewareFn } from "../router/middleware-types.js";
import {
  createTestRequestContext,
  headersToObject,
  snapshotRunEffects,
  type CreateTestContextOptions,
  type VarsInit,
  type StateCookieSeed,
} from "./internal/context.js";
import type { ThemeConfig } from "../theme/types.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { CacheProfile } from "../cache/profile-registry.js";

/**
 * Options for runMiddleware.
 */
export interface RunMiddlewareOptions<TEnv = any> {
  /**
   * The request the chain runs under: a `Request`, or a URL string (absolute or
   * path). Optional for parity with `runLoader`/`runInRequestContext` — when
   * omitted it defaults to `http://localhost/`. Pass it for path-, header-, or
   * cookie-driven middleware.
   */
  request?: Request | string;
  /** Environment bindings surfaced as `ctx.env`. */
  env?: TEnv;
  /** Route params surfaced as `ctx.params`. */
  params?: Record<string, string>;
  /** Variables a prior middleware would have set (object or [key, value] list). */
  vars?: VarsInit;
  /** Route name -> pattern map enabling `ctx.reverse()`. */
  routeMap?: Record<string, string>;
  /**
   * Matched route name surfaced as `ctx.routeName`. Does NOT scope `.name`
   * reverse: the chain receives a map-only `reverse` (built from `routeMap`
   * alone), matching production app/response middleware — see the reverse
   * construction below.
   */
  routeName?: string;
  /** Router basename surfaced on the context (drives redirect() prefixing). */
  basename?: string;
  /** Theme config in the `createRouter({ theme })` shape (enables ctx.theme). */
  theme?: ThemeConfig | true;
  /**
   * Terminal handler invoked when the chain calls `next()` all the way through.
   * Defaults to a 200 empty Response. Use this to model the downstream
   * route/handler response.
   */
  next?: () => Promise<Response>;
  /**
   * Cache store backing any `use cache` function a middleware invokes. Without
   * it, registerCachedFunction bypasses (it checks for a store first), so the
   * cached function runs uncached and its taint/profile guards never fire.
   */
  cacheStore?: SegmentCacheStore;
  /** Cache profiles (the `createRouter({ cacheProfiles })` shape). */
  cacheProfiles?: Record<string, CacheProfile>;
  /**
   * Customize the rango state cookie a middleware that calls
   * `invalidateClientCache()` rotates (the name is always seeded — default
   * `rango-state_router_0` — so it rotates like production). Assert via the
   * `Set-Cookie` on `result.response` / `result.cookies`.
   */
  stateCookie?: StateCookieSeed;
}

/**
 * Result of runMiddleware.
 */
export interface RunMiddlewareResult<TEnv = any> {
  /** The final Response (downstream response, or a middleware short-circuit). */
  response: Response;
  /**
   * The underlying RequestContext. Read `ctx.cookies()`, `ctx.get(...)`, and
   * `ctx.res.headers` to assert on the chain's effects. (This is always the
   * RequestContext the chain ran under — not a per-middleware MiddlewareContext —
   * so `ctx.cookies()` and the other RequestContext accessors are available.)
   */
  ctx: RequestContext<TEnv>;
  /** Number of times the terminal handler ran (0 = short-circuited, 1 = passed through). */
  nextCalled: number;
  /**
   * The effective cookie view after the chain ran: request cookies merged with
   * anything the chain set or deleted (last-write-wins), as `{ name: value }`.
   * The public way to assert a cookie a middleware set, without casting through
   * the `@internal` `ctx.cookies()`. Set-Cookie headers are also on `response`.
   */
  cookies: Record<string, string>;
  /**
   * The final response's headers as a plain `{ name: value }` object (the same
   * view as `response.headers`), EXCLUDING `set-cookie` (use `cookies`). The
   * public way to assert a header a middleware set (e.g. a security header)
   * without reading `ctx.res.headers`. Header names are lowercased.
   */
  headers: Record<string, string>;
  /**
   * Location state the chain set via `ctx.setLocationState()` / `redirect({ state })`,
   * resolved to the flat `{ key: value }` shape the client reads off
   * `history.state` (empty object when none) — parity with `runInRequestContext`
   * and `renderHandler`.
   */
  locationState: Record<string, unknown>;
  /**
   * The resolved rango state cookie name seeded for the run (default
   * `rango-state_router_0`, or composed from `opts.stateCookie`). Assert a
   * middleware's `invalidateClientCache()` rotation against it without
   * recomputing — parity with `runInRequestContext` / `runLoaderResult` /
   * `renderHandler`.
   */
  stateCookieName: string;
}

/**
 * Run a middleware chain and return the response plus observable context.
 *
 * @example
 * ```ts
 * const { response, ctx, nextCalled } = await runMiddleware(
 *   async (ctx, next) => {
 *     if (!ctx.get("user")) return new Response(null, { status: 401 });
 *     return next();
 *   },
 *   { request: "/dashboard", vars: [["user", { id: 1 }]] },
 * );
 * // nextCalled === 1, response.status === 200
 * ```
 */
export async function runMiddleware<TEnv = any>(
  mw: MiddlewareFn<TEnv> | MiddlewareFn<TEnv>[],
  opts: RunMiddlewareOptions<TEnv>,
): Promise<RunMiddlewareResult<TEnv>> {
  const mwArray = Array.isArray(mw) ? mw : [mw];

  const ctxOpts: CreateTestContextOptions<TEnv> = {
    env: opts.env,
    request: opts.request,
    vars: opts.vars,
    routeMap: opts.routeMap,
    routeName: opts.routeName,
    params: opts.params,
    basename: opts.basename,
    theme: opts.theme,
    cacheStore: opts.cacheStore,
    cacheProfiles: opts.cacheProfiles,
    stateCookie: opts.stateCookie,
  };

  const {
    ctx,
    request: builtRequest,
    variables,
    stateCookieName,
  } = createTestRequestContext<TEnv>(ctxOpts);

  let nextCalled = 0;
  const finalHandler = async (): Promise<Response> => {
    nextCalled++;
    return opts.next?.() ?? new Response(null, { status: 200 });
  };

  // Match production: app/response middleware receive ctx.reverse built from the
  // route map ALONE (no matched route name or current params), so reversing a
  // parameterized route without explicit params does NOT auto-fill from the
  // current request. Passing routeName/params here would recreate the
  // false-confidence class fixed in dispatch.
  const reverse = opts.routeMap
    ? (createReverseFunction(opts.routeMap) as (
        name: string,
        params?: Record<string, string>,
        search?: Record<string, unknown>,
      ) => string)
    : undefined;

  // Keep the RETURNED ctx.reverse consistent with the map-only reverse the
  // chain receives. createTestRequestContext installs an auto-fill reverse
  // (correct for the loader phase) when routeName/params are passed, but
  // production app/response middleware see a map-only reverse. Without this,
  // a middleware reading getRequestContext().reverse — or a consumer asserting
  // on result.ctx.reverse — would observe auto-fill that production never does.
  if (reverse) {
    (ctx as RequestContext<TEnv>).reverse =
      reverse as RequestContext<TEnv>["reverse"];
  }

  const response = await runWithRequestContext(ctx, () =>
    executeLoaderMiddleware<TEnv>(
      mwArray,
      builtRequest,
      (opts.env ?? {}) as TEnv,
      opts.params ?? {},
      variables,
      finalHandler,
      reverse,
    ),
  );

  const { cookies, locationState } = snapshotRunEffects(ctx);
  const headers = headersToObject(response.headers);
  return {
    response,
    ctx,
    nextCalled,
    cookies,
    headers,
    locationState,
    stateCookieName,
  };
}
