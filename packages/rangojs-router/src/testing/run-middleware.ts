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
  type CreateTestContextOptions,
  type VarsInit,
} from "./internal/context.js";
import type { ResolvedThemeConfig } from "../theme/types.js";

/**
 * Options for runMiddleware.
 */
export interface RunMiddlewareOptions<TEnv = any> {
  /** Environment bindings surfaced as `ctx.env`. */
  env?: TEnv;
  /** Route params surfaced as `ctx.params`. */
  params?: Record<string, string>;
  /** Variables a prior middleware would have set (object or [key, value] list). */
  vars?: VarsInit;
  /** Route name -> pattern map enabling `ctx.reverse()`. */
  routeMap?: Record<string, string>;
  /** Matched route name for scoped `.name` reverse resolution. */
  routeName?: string;
  /** Router basename surfaced on the context (drives redirect() prefixing). */
  basename?: string;
  /** Theme config the real handler would inject (enables ctx.theme/ctx.setTheme). */
  themeConfig?: ResolvedThemeConfig | null;
  /**
   * Terminal handler invoked when the chain calls `next()` all the way through.
   * Defaults to a 200 empty Response. Use this to model the downstream
   * route/handler response.
   */
  next?: () => Promise<Response>;
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
 *   "/dashboard",
 *   { vars: [["user", { id: 1 }]] },
 * );
 * // nextCalled === 1, response.status === 200
 * ```
 */
export async function runMiddleware<TEnv = any>(
  mw: MiddlewareFn<TEnv> | MiddlewareFn<TEnv>[],
  request: Request | string,
  opts: RunMiddlewareOptions<TEnv> = {},
): Promise<RunMiddlewareResult<TEnv>> {
  const mwArray = Array.isArray(mw) ? mw : [mw];

  const ctxOpts: CreateTestContextOptions<TEnv> = {
    env: opts.env,
    request,
    vars: opts.vars,
    routeMap: opts.routeMap,
    routeName: opts.routeName,
    params: opts.params,
    basename: opts.basename,
    themeConfig: opts.themeConfig,
  };

  const {
    ctx,
    request: builtRequest,
    variables,
  } = createTestRequestContext<TEnv>(ctxOpts);

  let nextCalled = 0;
  const finalHandler = async (): Promise<Response> => {
    nextCalled++;
    return opts.next?.() ?? new Response(null, { status: 200 });
  };

  const reverse = opts.routeMap
    ? (createReverseFunction(
        opts.routeMap,
        opts.routeName,
        opts.params ?? {},
      ) as (
        name: string,
        params?: Record<string, string>,
        search?: Record<string, unknown>,
      ) => string)
    : undefined;

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

  return { response, ctx, nextCalled };
}
