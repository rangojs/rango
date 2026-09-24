/**
 * Background Revalidation Middleware
 *
 * Implements SWR (stale-while-revalidate) pattern.
 * Triggers background refresh when cached data is stale.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from cache-store)
 *         |
 *         v
 *   +---------------------------+
 *   | yield* source            |  Pure pass-through
 *   | (no modifications)       |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | Should revalidate?  |
 *   | - shouldRevalidate  |──no───> return
 *   | - cacheHit          |
 *   | - cacheScope        |
 *   +---------------------+
 *         | yes
 *         v
 *   +---------------------------+
 *   | requestCtx.waitUntil()   |  Non-blocking background task
 *   +---------------------------+
 *         |
 *         v (async, doesn't block response)
 *   +---------------------------+
 *   | Create fresh context     |  Fresh handleStore, handlerContext,
 *   | (full isolation)         |  and loaderPromises map
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | resolveAllSegments()    |  Fresh resolution (no revalidation)
 *   | + resolveIntercepts()   |  Ensures complete components
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | cacheScope.cacheRoute()  |  Update cache with fresh data
 *   +---------------------------+
 *
 *
 * SWR PATTERN
 * ===========
 *
 * Stale-While-Revalidate provides fast responses with eventual consistency:
 *
 *   Timeline:
 *   ---------
 *   T0: Request arrives
 *   T1: Cache lookup finds stale entry
 *   T2: Return stale data immediately (fast!)
 *   T3: Response sent to client
 *   T4: waitUntil() triggers background revalidation
 *   T5: Fresh data resolved
 *   T6: Cache updated with fresh data
 *   T7: Next request gets fresh data from cache
 *
 * Benefits:
 *   - Fast initial response (cached data)
 *   - Eventually consistent (background refresh)
 *   - No blocking on revalidation
 *
 *
 * WHEN IS CACHE STALE?
 * ====================
 *
 * The cache-lookup middleware sets state.shouldRevalidate based on:
 *   - TTL (time-to-live) expiration
 *   - Cache entry metadata
 *   - Configured staleness rules
 *
 * This middleware only acts on the flag, it doesn't determine staleness.
 *
 *
 * ISOLATION FROM RESPONSE
 * =======================
 *
 * Background revalidation re-renders through rerenderAndCacheRoute (shared
 * with proactive caching in cache-store.ts):
 *   - Derived request context with its own handleStore, transition({ when })
 *     predicates and no perf metrics (the shared fields are never touched;
 *     the foreground is still producing the page)
 *   - Fresh handlerContext + loaderPromises (prevents reusing memoized
 *     loader results from the foreground pass)
 *
 *
 * FRESH RESOLUTION (NO REVALIDATION)
 * ===================================
 *
 * Both full and partial requests use resolveAllSegments() (without
 * revalidation logic) to ensure all segments have complete components.
 * Using revalidation-aware resolution would produce null components
 * for skipped segments, which would corrupt the cache entry.
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext, type RouterContext } from "../router-context.js";
import type { CacheScope } from "../../cache/cache-scope.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";
import { debugLog, debugWarn, getOrCreateRequestId } from "../logging.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
import { getContext } from "../../server/context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

/**
 * Re-render a cached route in the background and write it with
 * cacheScope.cacheRoute: the stale-hit refresh below and proactive caching
 * (cache-store.ts). Returns the number of segments written.
 *
 * A render whose status is not 200 (an error or notFound boundary resolved)
 * is not written and returns 0, as a non-200 MISS is not cached
 * (cache-store.ts): the entry it would replace keeps serving until a later
 * refresh succeeds or it expires. Nothing is held in process; a store's own
 * revalidation marker (CFCacheStore's REVALIDATING) re-arms after
 * MAX_REVALIDATION_INTERVAL, as after a refresh that throws.
 *
 * Runs on a DERIVED request context that owns the per-render state the
 * foreground reads while it is still producing the page (a stale HIT re-runs
 * its loaders; a proactive render starts once the Response exists, while its
 * body streams):
 *   - _handleStore: read late (loader pushes and aux-lane tracking in
 *     loader-resolution.ts, nested cache restores and captures in
 *     cache-scope.ts), so a swap sent live pushes into this render.
 *     setupLoaderAccess binds the store at setup, so it runs inside the
 *     derived context too.
 *   - _transitionWhen: fresh resolution appends transition({ when })
 *     predicates; the foreground's gateTransitions reads the array after the
 *     match, and a stale HIT (which replays the stored transition) must not
 *     evaluate this render's predicates.
 *   - _metricsStore: undefined, and the DSL store below has `metrics` unset
 *     (track() reads that one), so nothing lands on the foreground's perf
 *     timeline. ctx.Store.run closes over ctx.Store, so the derived store
 *     needs its own run.
 *   - response writes (headers, cookies, status, onResponse callbacks) go to
 *     a throwaway context (whose status gates the write, above) and are
 *     dropped: a layout above the cache() boundary is outside the header
 *     guard and an error boundary sets a status, so they would otherwise
 *     reach the live response.
 * runWithRequestContext also re-establishes the request ALS, which a waitUntil
 * task on workerd loses; the DSL store is a different ALS (build context).
 */
export async function rerenderAndCacheRoute<TEnv>(
  ctx: MatchContext<TEnv>,
  requestCtx: RequestContext<TEnv>,
  cacheScope: CacheScope,
  routerCtx: RouterContext<TEnv>,
): Promise<number> {
  const handleStore = routerCtx.createHandleStore();
  // Response writes land in a throwaway context nothing merges or drains. Its
  // mutators are closures over its own stub, and they keep the same guards.
  const sink = createRequestContext({
    env: ctx.env,
    request: ctx.request,
    url: ctx.url,
    variables: {},
    themeConfig: requestCtx._themeConfig,
  });
  const renderCtx: RequestContext<TEnv> = Object.assign(
    Object.create(requestCtx, {
      res: Object.getOwnPropertyDescriptor(sink, "res")!,
    }),
    {
      _handleStore: handleStore,
      _transitionWhen: [],
      _metricsStore: undefined,
      _onResponseCallbacks: [],
      header: sink.header,
      setCookie: sink.setCookie,
      deleteCookie: sink.deleteCookie,
      setStatus: sink.setStatus,
      _setStatus: sink._setStatus,
      setTheme: sink.setTheme,
      _rotateStateCookie: sink._rotateStateCookie,
      _setKeepCacheDirective: sink._setKeepCacheDirective,
    },
  );
  const store = Object.assign(Object.create(ctx.Store), { metrics: undefined });
  const runInStore = <T>(fn: () => T): T =>
    getContext().runWithStore(
      store,
      store.namespace || "#router",
      store.parent,
      fn,
    );
  return runWithRequestContext(renderCtx, async () => {
    const handlerContext = routerCtx.createHandlerContext(
      ctx.matched.params,
      ctx.request,
      ctx.url.searchParams,
      ctx.pathname,
      ctx.url,
      ctx.env,
      ctx.routeMap,
      ctx.matched.routeKey,
      ctx.matched.responseType,
      ctx.matched.pt === true,
    );
    const loaderPromises = new Map<string, Promise<any>>();
    routerCtx.setupLoaderAccess(handlerContext, loaderPromises);

    const segments = await runInStore(() =>
      routerCtx.resolveAllSegments(
        ctx.entries,
        ctx.routeKey,
        ctx.matched.params,
        handlerContext,
        loaderPromises,
        { skipLoaders: true },
      ),
    );
    if (ctx.interceptResult) {
      segments.push(
        ...(await runInStore(() =>
          routerCtx.resolveInterceptEntry(
            ctx.interceptResult!.intercept,
            ctx.interceptResult!.entry,
            ctx.matched.params,
            handlerContext,
            true, // belongsToRoute
            undefined, // no revalidationContext: render fresh
            // Skip intercept middleware: the foreground already ran it.
            // Re-running it here would double its side effects, and a
            // short-circuit Response would abort the write.
            { skipMiddleware: true },
          ),
        )),
      );
    }

    handleStore.seal();
    // Boundaries set 500/404 through _setStatus (catchSegmentError), which
    // lands on the sink.
    if (sink.res.status !== 200) {
      debugLog("backgroundRevalidation", "skipping cache for non-200 render", {
        status: sink.res.status,
        pathname: ctx.pathname,
      });
      return 0;
    }
    await cacheScope.cacheRoute(
      ctx.pathname,
      ctx.matched.params,
      segments,
      ctx.isIntercept,
    );
    return segments.length;
  });
}

/**
 * Creates background revalidation middleware
 *
 * If cache was stale (state.shouldRevalidate === true):
 * - Triggers background resolution via waitUntil
 * - Observes segments but doesn't modify them
 * - Updates cache with fresh segments after revalidation completes
 */
export function withBackgroundRevalidation<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>,
  ): AsyncGenerator<ResolvedSegment> {
    // Pass through all segments unchanged
    for await (const segment of source) {
      yield segment;
    }

    // Only trigger background revalidation if:
    // 1. Cache was hit and stale
    // 2. Cache scope exists
    if (!state.shouldRevalidate || !state.cacheHit || !ctx.cacheScope) {
      return;
    }

    const routerCtx = getRouterContext<TEnv>();
    const requestCtx = routerCtx.getRequestContext();
    const cacheScope = ctx.cacheScope;
    const reqId = INTERNAL_RANGO_DEBUG
      ? getOrCreateRequestId(ctx.request)
      : undefined;

    requestCtx?.waitUntil(async () => {
      const start = performance.now();
      debugLog("backgroundRevalidation", "revalidating stale route", {
        pathname: ctx.pathname,
        fullMatch: ctx.isFullMatch,
      });

      try {
        const count = await rerenderAndCacheRoute(
          ctx,
          requestCtx as RequestContext<TEnv>,
          cacheScope,
          routerCtx,
        );
        if (INTERNAL_RANGO_DEBUG) {
          const dur = performance.now() - start;
          console.log(
            `[RSC Background][req:${reqId}] SWR revalidation ${ctx.pathname} (${dur.toFixed(2)}ms) segments=${count}`,
          );
        }
        debugLog("backgroundRevalidation", "revalidation complete", {
          pathname: ctx.pathname,
        });
      } catch (error) {
        if (INTERNAL_RANGO_DEBUG) {
          const dur = performance.now() - start;
          console.log(
            `[RSC Background][req:${reqId}] SWR revalidation ${ctx.pathname} FAILED (${dur.toFixed(2)}ms) error=${String(error)}`,
          );
        }
        debugWarn("backgroundRevalidation", "revalidation failed", {
          pathname: ctx.pathname,
          error: String(error),
        });
      }
    });
  };
}
