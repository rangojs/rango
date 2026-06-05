/**
 * runLoader — unit-test a raw loader function in isolation.
 *
 * Consumers pass the RAW async loader body `(ctx) => ...`, NOT a createLoader()
 * handle. This sidesteps the Vite `$$id` injection that createLoader() relies on
 * for RSC registration: the function is invoked directly with a constructed
 * LoaderContext, so no build step is required.
 *
 * The LoaderContext mirrors the canonical shape the router builds at runtime
 * (see createUseFunction in server/request-context.ts). The loader runs inside
 * runWithRequestContext so getRequestContext(), cookie reads, and header
 * mutations resolve exactly as in production.
 *
 * Limitations (v1):
 * - `ctx.rendered()` is not available — it requires the DSL render barrier,
 *   which only exists inside a full match. Calling it throws.
 * - `ctx.reverse()` throws unless `routeMap` is provided.
 * - `formData` is exposed verbatim; no multipart parsing is performed.
 */

import {
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { createReverseFunction } from "../router/handler-context.js";
import type { LoaderContext, LoaderDefinition } from "../types.js";
import type { ContextVar } from "../context-var.js";
import {
  createTestRequestContext,
  type CreateTestContextOptions,
} from "./internal/context.js";

/**
 * A resolver for `ctx.use(OtherLoader)` composition. Receives the dependency
 * loader definition and returns its data (or a promise of it). When omitted,
 * `ctx.use` delegates to the real request-context use(), which executes the
 * dependency's own `fn` if present.
 */
export type UseResolver = <T>(
  loader: LoaderDefinition<T, any>,
) => Promise<T> | T;

/**
 * Options for runLoader.
 */
export interface RunLoaderOptions<TEnv = any> {
  /** Route params surfaced as `ctx.params` and `ctx.routeParams`. */
  params?: Record<string, string>;
  /** Search params; merged into the request URL so `ctx.searchParams` reflects them. */
  search?: Record<string, string>;
  /** Environment bindings surfaced as `ctx.env`. */
  env?: TEnv;
  /** Override the backing Request (string or Request). Defaults to a localhost GET. */
  request?: Request | string;
  /** Variables a prior middleware would have set, as [key, value] entries. */
  vars?: Iterable<readonly [ContextVar<unknown> | string, unknown]>;
  /** Route name -> pattern map enabling `ctx.reverse()`. */
  routeMap?: Record<string, string>;
  /** Matched route name for scoped `.name` reverse resolution. */
  routeName?: string;
  /** HTTP method surfaced as `ctx.method`. Defaults to "GET". */
  method?: string;
  /** Request body surfaced as `ctx.body`. */
  body?: unknown;
  /** Form data surfaced as `ctx.formData`. */
  formData?: FormData;
  /** Resolver for `ctx.use(OtherLoader)` composition. */
  use?: UseResolver;
}

/**
 * Run a raw loader body and return its resolved data.
 *
 * @example
 * ```ts
 * const data = await runLoader(
 *   async (ctx) => ({ id: ctx.params.id, user: ctx.get("user") }),
 *   { params: { id: "42" }, vars: [["user", { name: "Ada" }]] },
 * );
 * ```
 */
export async function runLoader<T>(
  loaderFn: (ctx: LoaderContext<any, any>) => Promise<T> | T,
  opts: RunLoaderOptions = {},
): Promise<T> {
  const ctxOpts: CreateTestContextOptions<any> = {
    env: opts.env,
    request: opts.request,
    requestInit: opts.method ? { method: opts.method } : undefined,
    vars: opts.vars,
    routeMap: opts.routeMap,
    routeName: opts.routeName,
    params: opts.params,
  };

  const { ctx } = createTestRequestContext(ctxOpts);

  // Apply search params onto the URL-derived searchParams so the loader sees them.
  if (opts.search) {
    for (const [key, value] of Object.entries(opts.search)) {
      ctx.searchParams.set(key, value);
    }
  }

  const reqCtx = ctx as RequestContext<any>;

  return runWithRequestContext(reqCtx, () => {
    const reverse = opts.routeMap
      ? createReverseFunction(opts.routeMap, opts.routeName, opts.params ?? {})
      : reqCtx.reverse;

    const loaderCtx: LoaderContext<any, any> = {
      params: opts.params ?? {},
      routeParams: (opts.params ?? {}) as Record<string, string>,
      request: reqCtx.request,
      searchParams: ctx.searchParams,
      search: {},
      pathname: reqCtx.pathname,
      url: reqCtx.url,
      originalUrl: reqCtx.originalUrl,
      env: reqCtx.env,
      waitUntil: reqCtx.waitUntil.bind(reqCtx),
      executionContext: reqCtx.executionContext,
      get: reqCtx.get as LoaderContext<any, any>["get"],
      use: ((dep: LoaderDefinition<any, any>) => {
        if (opts.use) return opts.use(dep);
        return reqCtx.use(dep);
      }) as LoaderContext<any, any>["use"],
      method: opts.method ?? "GET",
      body: opts.body,
      formData: opts.formData,
      reverse: reverse as LoaderContext<any, any>["reverse"],
      rendered: () => {
        throw new Error(
          "ctx.rendered() is not available in runLoader(). It requires the DSL " +
            "render barrier, which only exists during a full route match. Test " +
            "rendered() behavior with renderServer() or an e2e test.",
        );
      },
    };

    return Promise.resolve(loaderFn(loaderCtx));
  });
}
