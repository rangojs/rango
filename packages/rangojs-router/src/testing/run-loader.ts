/**
 * runLoader — unit-test a loader function in isolation.
 *
 * Pass the RAW async loader body `(ctx) => ...`, or a registered `createLoader()`
 * handle (its fn is recovered from the fetchable registry by `$$id`). The raw
 * body needs no build step; the handle works because `createLoader` assigns a
 * runtime-fallback `$$id` and registers its fn even without the Vite plugin (when
 * imported through the server build — the consumer's `@rangojs/router` under the
 * `rangoTestConfig()` preset). Either way the function is invoked directly with a
 * constructed LoaderContext.
 *
 * The LoaderContext mirrors the canonical shape the router builds at runtime
 * (see createUseFunction in server/request-context.ts). The loader runs inside
 * runWithRequestContext so getRequestContext(), cookie reads, and header
 * mutations resolve exactly as in production.
 *
 * Limitations (v1):
 * - `ctx.rendered()` is not available — it requires the DSL render barrier,
 *   which only exists inside a full match. Calling it throws.
 * - `ctx.reverse()` throws unless `routeMap` is provided (it does NOT fall back
 *   to the global route map — that would leak whichever routes another test
 *   registered).
 * - `ctx.use(handle)` follows the production rule: reading a handle before
 *   `await ctx.rendered()` throws (pass `rendered` to mock the barrier).
 * - `use cache` functions only cache (and only fire their taint/profile guards)
 *   when a `cacheStore` is provided — without one, registerCachedFunction
 *   bypasses (it checks for a store first). Pass `cacheStore`/`cacheProfiles`
 *   to exercise cached loaders; otherwise such a call runs uncached, like an
 *   app with no cache configured.
 * - `formData` is exposed verbatim; no multipart parsing is performed.
 * - Scoped dot-local reverse (`.sibling`) uses only the supplied `routeMap`;
 *   the production root-scoping signal (derived from the global registry) is
 *   not modeled, so a dotted name resolves against `routeMap` as given.
 */

import {
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { createReverseFunction } from "../router/handler-context.js";
import { getFetchableLoader } from "../server/fetchable-loader-store.js";
import type { LoaderContext, LoaderDefinition } from "../types.js";
import type { ContextVar } from "../context-var.js";
import { isHandle, type Handle } from "../handle.js";
import { withDefer } from "../defer.js";
import { collectHandle } from "./collect-handle.js";
import type { ThemeConfig } from "../theme/types.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { CacheProfile } from "../cache/profile-registry.js";
import {
  createTestRequestContext,
  buildRunSnapshot,
  type CreateTestContextOptions,
  type VarsInit,
  type StateCookieSeed,
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
    <TData, TAccumulated = TData[]>(
      handle: Handle<TData, TAccumulated>,
    ): TAccumulated;
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
  /**
   * The TYPED `ctx.search` object a route's search schema would produce. Distinct
   * from `search` (which sets the raw `ctx.searchParams`): a loader on a typed
   * search route reads `ctx.search`, which is otherwise `{}` in a test.
   */
  searchData?: Record<string, unknown>;
  /** Router basename surfaced on the context (drives redirect() prefixing). */
  basename?: string;
  /**
   * Theme config in the same shape `createRouter({ theme })` takes (e.g. `true`
   * or `{ themes: [...] }`). Seeds the request's theme config so nested handler
   * or cache contexts created from this loader observe it. Loaders themselves do
   * not expose `ctx.theme`/`ctx.setTheme` (those are handler/middleware-only).
   */
  theme?: ThemeConfig | true;
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
  /**
   * Seed the data `ctx.use(OtherLoader)` returns, by loader REFERENCE — the same
   * tuple form `renderHandler` / `renderRoute` use (`[[OtherLoader, data]]`).
   * Matched by reference, so a real `createLoader()` handle resolves regardless
   * of its build-injected `$$id`. For dynamic resolution (compute per dependency)
   * use `use` instead; `loaders` is checked first.
   */
  loaders?: ReadonlyArray<readonly [LoaderDefinition<any, any>, unknown]>;
  /** Resolver for `ctx.use(OtherLoader)` composition (dynamic; `loaders` wins if both match). */
  use?: UseResolver;
  /**
   * Cache store backing `use cache` functions the loader invokes. Without it,
   * a cached function bypasses (registerCachedFunction checks for a store
   * first) and runs uncached — its taint/profile guards never fire. Pass one
   * (e.g. `new MemorySegmentCacheStore()`) to test a cached loader.
   */
  cacheStore?: SegmentCacheStore;
  /** Cache profiles (the `createRouter({ cacheProfiles })` shape). */
  cacheProfiles?: Record<string, CacheProfile>;
  /**
   * Customize the rango state cookie a loader that calls
   * `invalidateClientCache()` rotates (the name is always seeded — default
   * `rango-state_router_0` — so it rotates like production). Assert via the
   * `Set-Cookie` on the request context's response.
   */
  stateCookie?: StateCookieSeed;
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

function withSearch(
  request: Request | string | undefined,
  search: Record<string, string> | undefined,
): Request | string | undefined {
  if (!search) return request;
  const DEFAULT_ORIGIN = "http://localhost/";
  if (request instanceof Request) {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(search)) {
      url.searchParams.set(key, value);
    }
    return new Request(url, request);
  }
  const url = new URL(request ?? DEFAULT_ORIGIN, DEFAULT_ORIGIN);
  for (const [key, value] of Object.entries(search)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A raw loader body, or a registered `createLoader()` handle (its fn is recovered). */
export type RunnableLoader<T> =
  | ((ctx: TestLoaderContext) => Promise<T> | T)
  | LoaderDefinition<T, any>;

function resolveLoaderFn<T>(
  loader: RunnableLoader<T>,
): (ctx: TestLoaderContext) => Promise<T> | T {
  if (typeof loader === "function") {
    return loader as (ctx: TestLoaderContext) => Promise<T> | T;
  }
  const def = loader as LoaderDefinition<T, any>;
  const fn = def.fn ?? getFetchableLoader(def.$$id)?.fn;
  if (!fn) {
    throw new Error(
      `runLoader() received a createLoader() handle whose function could not be ` +
        `recovered (id "${def.$$id || "<empty>"}"). The loader was likely imported ` +
        `through the CLIENT build, which drops the body. Either import it through ` +
        `@rangojs/router with the rangoTestConfig() preset (resolves to the server ` +
        `build that registers the fn), or pass the raw loader body directly: ` +
        `runLoader((ctx) => ...).`,
    );
  }
  return fn as (ctx: TestLoaderContext) => Promise<T> | T;
}

function buildLoaderCtxOpts(
  opts: RunLoaderOptions,
): CreateTestContextOptions<any> {
  return {
    env: opts.env,
    request: withSearch(opts.request, opts.search),
    requestInit: opts.method ? { method: opts.method } : undefined,
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
}

function runWithLoaderContext<R>(
  reqCtx: RequestContext<any>,
  opts: RunLoaderOptions,
  fn: (ctx: TestLoaderContext) => R,
  pushRecorder?: Array<{ handle: Handle<any, any>; value: unknown }>,
): R {
  const handleSeeds = new Map<unknown, unknown>(opts.handles ?? []);
  const loaderSeeds = new Map<unknown, unknown>(opts.loaders ?? []);
  let renderedResolved = false;

  return runWithRequestContext(reqCtx, () => {
    const reverse = opts.routeMap
      ? createReverseFunction(opts.routeMap, opts.routeName, opts.params ?? {})
      : ((() => {
          throw new Error(
            "ctx.reverse() requires the `routeMap` option in runLoader(). " +
              "Pass { routeMap: { name: pattern, ... } } to enable reverse().",
          );
        }) as TestLoaderContext["reverse"]);

    const loaderCtx: TestLoaderContext = {
      params: opts.params ?? {},
      routeParams: (opts.params ?? {}) as Record<string, string>,
      request: reqCtx.request,
      searchParams: reqCtx.searchParams,
      search: opts.searchData ?? {},
      pathname: reqCtx.pathname,
      url: reqCtx.url,
      originalUrl: reqCtx.originalUrl,
      env: reqCtx.env,
      waitUntil: reqCtx.waitUntil.bind(reqCtx),
      executionContext: reqCtx.executionContext,
      get: ((keyOrVar: any) => {
        // Handle READ (mirrors production's ctx.get(handle)): rendered-gated,
        // seeded via the `handles` option.
        if (isHandle(keyOrVar)) {
          if (!renderedResolved) {
            throw new Error(
              `ctx.get(handle) in a loader requires "await ctx.rendered()" first. ` +
                `Handle "${(keyOrVar as Handle<any, any>).$$id}" cannot be read until ` +
                `the render tree has settled.`,
            );
          }
          if (handleSeeds.has(keyOrVar)) return handleSeeds.get(keyOrVar);
          return collectHandle(keyOrVar, []);
        }
        return (reqCtx.get as any)(keyOrVar);
      }) as TestLoaderContext["get"],
      use: ((dep: LoaderDefinition<any, any> | Handle<any, any>) => {
        // Handle WRITE (mirrors production's ctx.use(Meta)({...}) push): the
        // same withDefer wrapper shape, recording into the result envelope's
        // `handlePushes` so tests assert what the loader wrote. Deferred
        // resolvers record their resolved value when called.
        if (isHandle(dep)) {
          const handleDef = dep as Handle<any, any>;
          return withDefer((dataOrFn: unknown) => {
            const value =
              typeof dataOrFn === "function"
                ? (dataOrFn as () => unknown)()
                : dataOrFn;
            pushRecorder?.push({ handle: handleDef, value });
          });
        }
        // Production ctx.use(Loader) ALWAYS returns a Promise (the cached loader
        // promise). The seeded path must match, so a consumer composing on the
        // result (ctx.use(Dep).then(...), Promise.race, etc.) works the same as
        // production and the real-fn delegate path below.
        if (loaderSeeds.has(dep)) return Promise.resolve(loaderSeeds.get(dep));
        if (opts.use)
          return Promise.resolve(opts.use(dep as LoaderDefinition<any, any>));
        return reqCtx.use(dep as LoaderDefinition<any, any>);
      }) as LoaderContext<any, any>["use"],
      method: opts.method ?? "GET",
      body: opts.body,
      formData: opts.formData,
      reverse: reverse as TestLoaderContext["reverse"],
      rendered:
        opts.rendered !== undefined && opts.rendered !== false
          ? async () => {
              if (typeof opts.rendered === "function") {
                await opts.rendered();
              }
              renderedResolved = true;
            }
          : () => {
              throw new Error(
                "ctx.rendered() is not available in runLoader() by default. It " +
                  "requires the DSL render barrier, which only exists during a " +
                  "full route match. To unit-test a loader's post-barrier logic, " +
                  "pass { rendered: true } to mock the barrier and { handles: " +
                  "[[SomeHandle, accumulatedData]] } to seed ctx.get(SomeHandle). " +
                  "For the real push/accumulate/barrier wiring, use an e2e test.",
              );
            },
    };

    return fn(loaderCtx);
  });
}

export async function runLoader<T>(
  loader: RunnableLoader<T>,
  opts: RunLoaderOptions = {},
): Promise<T> {
  const loaderFn = resolveLoaderFn(loader);
  const { ctx } = createTestRequestContext(buildLoaderCtxOpts(opts));
  return runWithLoaderContext(ctx as RequestContext<any>, opts, (loaderCtx) =>
    Promise.resolve(loaderFn(loaderCtx)),
  );
}

export interface RunLoaderResult<T> {
  /**
   * The loader's resolved data (the value bare `runLoader` returns), or
   * `undefined` if it threw (see {@link thrown}). Named `result` for parity with
   * `runInRequestContext`'s envelope.
   */
  result: T | undefined;
  /**
   * What the loader threw (commonly a `Response` from `throw redirect(...)` on a
   * success path) — captured, NOT re-thrown; assert on it. `undefined` if the
   * loader returned normally.
   */
  thrown: unknown;
  /**
   * The merged `Response` (status + headers + Set-Cookie). On a thrown redirect,
   * that redirect's `Location` merged with the accumulated cookies/headers — so a
   * loader that sets a session cookie then `throw redirect("/")` exposes BOTH.
   */
  response: Response;
  /** Effective cookie view: request cookies + the loader's mutations, last-write-wins. */
  cookies: Record<string, string>;
  /** Response headers as `{ name: value }`, EXCLUDING set-cookie (use `cookies`). Lowercased. */
  headers: Record<string, string>;
  /** Location state the loader set (`ctx.setLocationState()` / `redirect({ state })`). */
  locationState: Record<string, unknown>;
  /** The resolved rango state cookie name seeded for the run (default `rango-state_router_0`). */
  stateCookieName: string;
  /**
   * Handle writes the loader made via `ctx.use(SomeHandle)({...})`, in push
   * order. A `.defer()` resolver's value is recorded when the resolver runs.
   */
  handlePushes: Array<{ handle: Handle<any, any>; value: unknown }>;
}

export async function runLoaderResult<T>(
  loader: RunnableLoader<T>,
  opts: RunLoaderOptions = {},
): Promise<RunLoaderResult<T>> {
  const loaderFn = resolveLoaderFn(loader);
  const { ctx, stateCookieName } = createTestRequestContext(
    buildLoaderCtxOpts(opts),
  );
  const reqCtx = ctx as RequestContext<any>;
  const handlePushes: Array<{ handle: Handle<any, any>; value: unknown }> = [];
  let result: T | undefined;
  let thrown: unknown;
  try {
    result = await runWithLoaderContext(
      reqCtx,
      opts,
      (loaderCtx) => Promise.resolve(loaderFn(loaderCtx)),
      handlePushes,
    );
  } catch (error) {
    thrown = error;
  }
  return {
    result,
    handlePushes,
    ...buildRunSnapshot(reqCtx, thrown, stateCookieName),
  };
}
