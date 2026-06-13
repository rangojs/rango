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
   * or `{ themes: [...] }`). Without it `ctx.theme`/`ctx.setTheme` are inert.
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

/**
 * Merge `search` into a request's URL, returning a value `toRequest` can build.
 * Keeps the original method/headers/body when a Request was passed.
 */
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

/**
 * Resolve the function to run from either a raw body or a `createLoader()` handle.
 *
 * A handle carries no inline body (`createLoader` registers it in the fetchable
 * registry by `$$id`), so recover it from there — `def.fn` first (a hand-built
 * def), then the registry. This works when the handle resolves through the
 * SERVER build (the consumer's `@rangojs/router` under `rangoTestConfig`, which
 * registers the fn); the CLIENT stub drops the body, so a handle imported that
 * way is unrecoverable and we say so explicitly.
 */
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

/**
 * Run a loader and return its resolved data. Pass the RAW loader body, or a
 * registered `createLoader()` handle (its fn is recovered from the registry).
 *
 * @example
 * ```ts
 * // raw body
 * const a = await runLoader(
 *   async (ctx) => ({ id: ctx.params.id, user: ctx.get("user") }),
 *   { params: { id: "42" }, vars: { user: { name: "Ada" } } },
 * );
 * // registered createLoader() handle (recovered from the registry)
 * const b = await runLoader(ProductLoader, { params: { id: "42" } });
 * ```
 */
// Build the createTestRequestContext options from runLoader's options. Shared by
// runLoader (returns the loader data) and runLoaderResult (also snapshots effects).
function buildLoaderCtxOpts(
  opts: RunLoaderOptions,
): CreateTestContextOptions<any> {
  return {
    env: opts.env,
    // Bake opts.search into the request URL itself so ctx.request.url, ctx.url,
    // and ctx.searchParams all agree (production carries the query string on the
    // real request — a loader reading ctx.request.url must see it too).
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

// Enter `reqCtx` and run `fn` with a seeded TestLoaderContext (the same ctx shape
// a real loader receives). The single place the loader context is built, so
// runLoader and runLoaderResult share identical loader-context semantics.
function runWithLoaderContext<R>(
  reqCtx: RequestContext<any>,
  opts: RunLoaderOptions,
  fn: (ctx: TestLoaderContext) => R,
): R {
  // Seed values for ctx.use(SomeHandle), matched by handle reference (so a real
  // handle resolves regardless of its build-injected $$id).
  const handleSeeds = new Map<unknown, unknown>(opts.handles ?? []);

  // Seed values for ctx.use(OtherLoader), matched by loader reference (same model
  // as renderHandler/renderRoute). Checked before the `use` resolver.
  const loaderSeeds = new Map<unknown, unknown>(opts.loaders ?? []);

  // Tracks whether the mocked render barrier has settled. ctx.use(handle)
  // reads are gated on this, matching production (loader-resolution.ts).
  let renderedResolved = false;

  return runWithRequestContext(reqCtx, () => {
    const reverse = opts.routeMap
      ? createReverseFunction(opts.routeMap, opts.routeName, opts.params ?? {})
      : ((() => {
          // Documented contract: reverse requires routeMap. Do NOT fall back to
          // reqCtx.reverse (the global route map) — that leaks whichever routes
          // another test registered and contradicts the documented behavior.
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
      get: reqCtx.get as TestLoaderContext["get"],
      use: ((dep: LoaderDefinition<any, any> | Handle<any, any>) => {
        // Match production (loader-resolution.ts): reading a handle in a loader
        // requires the render barrier to have settled. Gate BEFORE returning a
        // seed, so a loader that forgets `await ctx.rendered()` fails in the
        // test exactly as it would at runtime.
        if (isHandle(dep) && !renderedResolved) {
          throw new Error(
            `ctx.use(handle) in a loader requires "await ctx.rendered()" first. ` +
              `Handle "${(dep as Handle<any, any>).$$id}" cannot be read until ` +
              `the render tree has settled.`,
          );
        }
        // Handle reads (ctx.use(SomeHandle)) resolve from the seeded map first.
        if (handleSeeds.has(dep)) return handleSeeds.get(dep);
        // Post-barrier, an UNSEEDED handle must match production
        // (loader-resolution.ts -> collectHandleData), which runs the handle's
        // registered collect over empty segments (collect([])) rather than
        // throwing or leaking into the loader resolver. Resolve it via
        // collectHandle, which recovers and runs that same collect.
        if (isHandle(dep)) return collectHandle(dep, []);
        // Loader reads (ctx.use(OtherLoader)) resolve from the seeded map next,
        // then the dynamic `use` resolver, then the real request-context use().
        if (loaderSeeds.has(dep)) return loaderSeeds.get(dep);
        if (opts.use) return opts.use(dep as LoaderDefinition<any, any>);
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
              // Barrier has settled: subsequent ctx.use(handle) reads resolve.
              renderedResolved = true;
            }
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

    return fn(loaderCtx);
  });
}

/**
 * Run a loader and return its resolved data.
 *
 * Effects the loader sets (cookies, response headers, a thrown redirect) are NOT
 * observable here — use {@link runLoaderResult} for an auth-style loader that
 * sets a `Set-Cookie` and/or `throw redirect(...)`.
 */
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

/**
 * What a loader run accumulated: its data PLUS the response effects it produced,
 * surfaced as PUBLIC values (parity with `runMiddleware`/`runInRequestContext`)
 * so an effect-setting loader is assertable without casting through the
 * `@internal` request context.
 */
export interface RunLoaderResult<T> {
  /** The loader's resolved data, or `undefined` if it threw (see {@link thrown}). */
  data: T | undefined;
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
}

/**
 * Run a loader AND surface the response effects it produced. The richer sibling
 * of {@link runLoader} (which returns the bare data): use this when the loader
 * sets a cookie / response header / location-state, or `throw redirect(...)`, and
 * the test must assert that output.
 *
 * @example
 * ```ts
 * // AuthLoader: validates, sets a `session` cookie, then `throw redirect("/")`.
 * const { thrown, response, cookies } = await runLoaderResult(AuthLoader, {
 *   request: new Request("https://app.test/login?token=ok"),
 * });
 * expect((thrown as Response).headers.get("Location")).toBe("/");
 * expect(cookies.session).toBeDefined();
 * expect(
 *   response.headers.getSetCookie().some((c) => c.startsWith("session=")),
 * ).toBe(true);
 * ```
 */
export async function runLoaderResult<T>(
  loader: RunnableLoader<T>,
  opts: RunLoaderOptions = {},
): Promise<RunLoaderResult<T>> {
  const loaderFn = resolveLoaderFn(loader);
  const { ctx, stateCookieName } = createTestRequestContext(
    buildLoaderCtxOpts(opts),
  );
  const reqCtx = ctx as RequestContext<any>;
  let data: T | undefined;
  let thrown: unknown;
  try {
    data = await runWithLoaderContext(reqCtx, opts, (loaderCtx) =>
      Promise.resolve(loaderFn(loaderCtx)),
    );
  } catch (error) {
    // Capture (do NOT re-throw): a loader's success path is often
    // `throw redirect(...)`, and the cookie/flash it set before the throw must
    // stay observable (parity with runInRequestContext).
    thrown = error;
  }
  return { data, ...buildRunSnapshot(reqCtx, thrown, stateCookieName) };
}
