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
import type { Handle } from "../handle.js";
import {
  createTestRequestContext,
  type CreateTestContextOptions,
  type VarsInit,
} from "./internal/context.js";

/**
 * The loader context surfaced to a `runLoader` body. It mirrors the runtime
 * LoaderContext but RELAXES the two members that are otherwise bound to the
 * app's global route/var augmentation, because in a unit test they are driven by
 * the `routeMap` / `vars` options instead:
 * - `reverse` accepts any route name (the names come from `routeMap`, not the
 *   registered route map), and
 * - `get` accepts any string key or ContextVar (keys come from `vars`).
 */
export type TestLoaderContext<TEnv = any> = Omit<
  LoaderContext<any, TEnv>,
  "reverse" | "get"
> & {
  reverse: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string;
  get: {
    <T>(contextVar: ContextVar<T>): T | undefined;
    <T = unknown>(key: string): T | undefined;
  };
};

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
  /** Variables a prior middleware would have set (object or [key, value] list). */
  vars?: VarsInit;
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
  /**
   * Mock the `ctx.rendered()` render barrier so a loader that does
   * `await ctx.rendered()` (to read handle data pushed during render) can be
   * unit-tested. By default `ctx.rendered()` throws, because the real barrier
   * only exists during a full route match. Pass `true` to resolve it
   * immediately, or a function to control its timing/side effects.
   *
   * This tests the loader's POST-barrier compute logic against the seeded
   * `handles` below — it does NOT exercise the real push -> accumulate -> barrier
   * wiring (that stays e2e). Pair with `handles` to feed `ctx.use(SomeHandle)`.
   */
  rendered?: boolean | (() => void | Promise<void>);
  /**
   * Seed the values `ctx.use(SomeHandle)` returns — the ACCUMULATED handle data a
   * loader reads after `await ctx.rendered()`. Matched by handle reference, so a
   * real handle works regardless of its (build-injected) `$$id`.
   *
   * @example
   * await runLoader(livePricesBody, {
   *   rendered: true,
   *   handles: [[RenderedProducts, ["widget-a", "widget-b"]]],
   * });
   */
  handles?: ReadonlyArray<readonly [Handle<any, any>, unknown]>;
}

/**
 * Run a raw loader body and return its resolved data.
 *
 * @example
 * ```ts
 * const data = await runLoader(
 *   async (ctx) => ({ id: ctx.params.id, user: ctx.get("user") }),
 *   { params: { id: "42" }, vars: { user: { name: "Ada" } } },
 * );
 * ```
 */
export async function runLoader<T>(
  loaderFn: (ctx: TestLoaderContext) => Promise<T> | T,
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

  // Seed values for ctx.use(SomeHandle), matched by handle reference (so a real
  // handle resolves regardless of its build-injected $$id).
  const handleSeeds = new Map<unknown, unknown>(opts.handles ?? []);

  return runWithRequestContext(reqCtx, () => {
    const reverse = opts.routeMap
      ? createReverseFunction(opts.routeMap, opts.routeName, opts.params ?? {})
      : reqCtx.reverse;

    const loaderCtx: TestLoaderContext = {
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
      get: reqCtx.get as TestLoaderContext["get"],
      use: ((dep: LoaderDefinition<any, any>) => {
        // Handle reads (ctx.use(SomeHandle)) resolve from the seeded map first.
        if (handleSeeds.has(dep)) return handleSeeds.get(dep);
        if (opts.use) return opts.use(dep);
        return reqCtx.use(dep);
      }) as LoaderContext<any, any>["use"],
      method: opts.method ?? "GET",
      body: opts.body,
      formData: opts.formData,
      reverse: reverse as TestLoaderContext["reverse"],
      rendered:
        opts.rendered !== undefined && opts.rendered !== false
          ? () =>
              Promise.resolve(
                typeof opts.rendered === "function"
                  ? opts.rendered()
                  : undefined,
              )
          : () => {
              throw new Error(
                "ctx.rendered() is not available in runLoader() by default. It " +
                  "requires the DSL render barrier, which only exists during a " +
                  "full route match. To unit-test a loader's post-barrier logic, " +
                  "pass { rendered: true } to mock the barrier and { handles: " +
                  "[[SomeHandle, accumulatedData]] } to seed ctx.use(SomeHandle). " +
                  "For the real push/accumulate/barrier wiring, use an e2e test.",
              );
            },
    };

    return Promise.resolve(loaderFn(loaderCtx));
  });
}
