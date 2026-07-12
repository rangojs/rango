/**
 * Cache Store Middleware
 *
 * Stores resolved segments in cache for future requests.
 * Implements proactive caching for partial navigation scenarios.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from intercept-resolution)
 *         |
 *         v
 *   +---------------------------+
 *   | Collect + yield all      |  Observer pattern: pass through
 *   | allSegments[]            |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | Should skip cache?  |
 *   | - !cacheScope       |──yes──> return
 *   | - isAction          |
 *   | - cacheHit          |
 *   | - method !== GET    |
 *   +---------------------+
 *         | no
 *         v
 *   +-------------------------------+
 *   | Any null components?          |
 *   | (client already has segment)  |
 *   +-------------------------------+
 *         |
 *   +-----+-----+
 *   |           |
 *  yes          no
 *   |           |
 *   v           v
 * PROACTIVE   DIRECT
 * CACHE       CACHE
 *   |           |
 *   v           v
 * waitUntil()  cacheRoute()
 * re-render    immediately
 * fresh        |
 *   |           |
 *   +-----------+
 *         |
 *         v
 *      next middleware
 *
 *
 * CACHING STRATEGIES
 * ==================
 *
 * 1. Direct Cache (all components present):
 *    - Immediate cacheRoute() call
 *    - All segments have valid components
 *    - Used for fresh full-page renders
 *
 * 2. Proactive Cache (null components present):
 *    - Background re-render via waitUntil()
 *    - Creates fresh context to avoid polluting response
 *    - Re-resolves ALL segments without revalidation
 *    - Ensures cache has complete components for future requests
 *
 *
 * WHY PROACTIVE CACHING?
 * ======================
 *
 * During partial navigation, some segments have null components:
 *
 *   Request: /products/123 -> /products/456
 *   Segments: [ProductLayout(null), ProductPage(component)]
 *
 * The null means "client already has this, don't re-send."
 * But if we cache these null components, future document requests
 * would fail (no component to render).
 *
 * Solution: Background re-render all segments fresh, then cache.
 * This ensures the cache always has complete, renderable segments.
 *
 *
 * PROACTIVE CACHE FLOW
 * ====================
 *
 *   1. Current request returns (fast, with nulls)
 *   2. waitUntil() triggers background work
 *   3. Create fresh handler context (silent, no stream pollution)
 *   4. Re-resolve all entries without revalidation logic
 *   5. Also resolve intercept segments if applicable
 *   6. Store complete segments in cache
 *
 *
 * SKIP CONDITIONS
 * ===============
 *
 * Caching is skipped when:
 *   - Cache scope disabled (no caching configured)
 *   - This is an action request (mutations shouldn't cache)
 *   - Cache was already hit (no need to re-cache same data)
 *   - Non-GET request (only GET requests are cacheable)
 */
import type { ResolvedSegment } from "../../types.js";
import {
  getRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { createShellImplicitDocScope } from "../../cache/cache-scope.js";
import { getRouterContext } from "../router-context.js";
import { debugLog, debugWarn, getOrCreateRequestId } from "../logging.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";

/**
 * Creates cache store middleware
 *
 * Observes all segments passing through and stores them in cache after pipeline completes.
 * Handles proactive caching for null-component segments.
 */
export function withCacheStore<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>,
  ): AsyncGenerator<ResolvedSegment> {
    const ms = ctx.metricsStore;

    const allSegments: ResolvedSegment[] = [];
    for await (const segment of source) {
      allSegments.push(segment);
      yield segment;
    }

    const ownStart = performance.now();

    // Shell capture composition (capture side): a route-derived cache() scope
    // keeps its normal store write below, but the capture's shell entry still
    // needs the CANONICAL doc segment record for navigation replay. Recorded
    // before the skip check because it must run on the explicit tier's hit
    // path too (state.cacheHit skips the normal write, yet the served
    // segments were collected into allSegments either way).
    recordShellCaptureDocRecord(ctx, state, allSegments);

    if (
      !ctx.cacheScope?.enabled ||
      ctx.isAction ||
      state.cacheHit ||
      ctx.request.method !== "GET"
    ) {
      if (ms) {
        ms.metrics.push({
          label: "pipeline:cache-store",
          duration: performance.now() - ownStart,
          startTime: ownStart - ms.requestStart,
        });
      }
      return;
    }

    const {
      createHandlerContext,
      setupLoaderAccess,
      resolveAllSegments,
      resolveInterceptEntry,
      createHandleStore,
    } = getRouterContext<TEnv>();

    // On a fresh intercept miss the intercept slot segments flow through
    // `source` into allSegments AND are also recorded on state.interceptSegments.
    // Dedup by id so each segment is cached once — cacheRoute serializes the
    // array verbatim (no id-dedup), so an un-deduped append doubles the intercept
    // segment in the cached entry, re-rendering the slot twice on the next hit.
    const seenSegmentIds = new Set(allSegments.map((s) => s.id));
    const allSegmentsToCache = [
      ...allSegments,
      ...state.interceptSegments.filter((s) => !seenSegmentIds.has(s.id)),
    ];

    const hasNullComponents = allSegmentsToCache.some(
      (s) =>
        s.component === null &&
        s.type !== "loader" &&
        ctx.clientSegmentSet.has(s.id),
    );

    const requestCtx = getRequestContext();
    if (!requestCtx) return;

    const cacheScope = ctx.cacheScope;

    // Record the route's segment-DSL cache tags into the request tag union NOW,
    // synchronously in the pipeline. The actual store write (cacheRoute) runs in
    // requestCtx.waitUntil() below — and the proactive path re-resolves the whole
    // tree first — so cacheRoute's own tag recording races the document cache's
    // post-body-drain snapshot of _requestTags. On a first-write miss the document
    // tag union could miss these tags and revalidateTag()/updateTag() would not
    // invalidate the cached document. Recording here (before the snapshot) closes
    // the window for both the direct and proactive write paths; the duplicate
    // record inside cacheRoute is idempotent.
    cacheScope.recordTags(requestCtx);

    const reqId = INTERNAL_RANGO_DEBUG
      ? getOrCreateRequestId(ctx.request)
      : undefined;

    requestCtx.onResponse((response) => {
      if (response.status !== 200) {
        debugLog("cacheStore", "skipping cache for non-200 response", {
          status: response.status,
          pathname: ctx.pathname,
        });
        return response;
      }

      if (hasNullComponents) {
        requestCtx.waitUntil(async () => {
          const savedMetrics = ctx.Store.metrics;
          ctx.Store.metrics = undefined;

          const start = performance.now();
          debugLog("cacheStore", "proactive caching started", {
            pathname: ctx.pathname,
          });
          const originalHandleStore = requestCtx._handleStore;
          requestCtx._handleStore = createHandleStore();
          try {
            const proactiveHandlerContext = createHandlerContext(
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
            const proactiveLoaderPromises = new Map<string, Promise<any>>();

            setupLoaderAccess(proactiveHandlerContext, proactiveLoaderPromises);

            const Store = ctx.Store;
            // Re-establish the request-context ALS around the re-render. Store
            // is a different ALS (DSL build context); on workerd a waitUntil
            // task runs detached from the request's I/O context, so a handler/
            // component that reads the ambient getRequestContext() during this
            // background re-render would otherwise throw "called outside of a
            // request context".
            const freshSegments = await runWithRequestContext(requestCtx, () =>
              Store.run(() =>
                resolveAllSegments(
                  ctx.entries,
                  ctx.routeKey,
                  ctx.matched.params,
                  proactiveHandlerContext,
                  proactiveLoaderPromises,
                  { skipLoaders: true },
                ),
              ),
            );

            let freshInterceptSegments: ResolvedSegment[] = [];
            if (ctx.interceptResult) {
              freshInterceptSegments = await runWithRequestContext(
                requestCtx,
                () =>
                  Store.run(() =>
                    resolveInterceptEntry(
                      ctx.interceptResult!.intercept,
                      ctx.interceptResult!.entry,
                      ctx.matched.params,
                      proactiveHandlerContext,
                      true, // belongsToRoute
                      // No revalidationContext = render fresh
                      undefined,
                      // Skip intercept middleware: the foreground already ran it
                      // before the response was sent. Re-running here (post-
                      // response, background) would fire side effects twice and a
                      // short-circuit Response would silently abort this write.
                      { skipMiddleware: true },
                    ),
                  ),
              );
            }

            const completeSegments = [
              ...freshSegments,
              ...freshInterceptSegments,
            ];
            requestCtx._handleStore.seal();
            await cacheScope.cacheRoute(
              ctx.pathname,
              ctx.matched.params,
              completeSegments,
              ctx.isIntercept,
            );
            if (INTERNAL_RANGO_DEBUG) {
              const dur = performance.now() - start;
              console.log(
                `[RSC Background][req:${reqId}] Proactive cache ${ctx.pathname} (${dur.toFixed(2)}ms) segments=${completeSegments.length}`,
              );
            }
            debugLog("cacheStore", "proactive caching complete", {
              pathname: ctx.pathname,
            });
          } catch (error) {
            if (INTERNAL_RANGO_DEBUG) {
              const dur = performance.now() - start;
              console.log(
                `[RSC Background][req:${reqId}] Proactive cache ${ctx.pathname} FAILED (${dur.toFixed(2)}ms) error=${String(error)}`,
              );
            }
            debugWarn("cacheStore", "proactive caching failed", {
              pathname: ctx.pathname,
              error: String(error),
            });
          } finally {
            requestCtx._handleStore = originalHandleStore;
            ctx.Store.metrics = savedMetrics;
          }
        });
      } else {
        if (INTERNAL_RANGO_DEBUG) {
          console.log(
            `[RSC CacheStore][req:${reqId}] Direct cache path: scheduling cacheRoute for ${ctx.pathname} (${allSegmentsToCache.length} segments, hasNullComponents=${hasNullComponents})`,
          );
        }
        requestCtx.waitUntil(async () => {
          const start = performance.now();
          await cacheScope.cacheRoute(
            ctx.pathname,
            ctx.matched.params,
            allSegmentsToCache,
            ctx.isIntercept,
          );
          if (INTERNAL_RANGO_DEBUG) {
            const dur = performance.now() - start;
            console.log(
              `[RSC Background][req:${reqId}] Cache store ${ctx.pathname} (${dur.toFixed(2)}ms) segments=${allSegmentsToCache.length}`,
            );
          }
        });
      }

      return response;
    });

    if (ms) {
      ms.metrics.push({
        label: "pipeline:cache-store",
        duration: performance.now() - ownStart,
        startTime: ownStart - ms.requestStart,
      });
    }
  };
}

/**
 * During a SHELL CAPTURE of a route with a route-derived cache() scope, write
 * the matched non-loader segments as the canonical doc segment record through
 * the capture marker's SnapshotOnlySegmentStore — IN ADDITION to the explicit
 * scope's normal real-store write. The record rides only inside the shell
 * entry (a real doc-keyed write would poison the next capture's lookup; see
 * RecordingShellStore.recordSegmentWrite), so no real-store behavior changes.
 * Without it, navigation replay was structurally dead for any ppr route under
 * a cache() scope (including an app-wide one): the snapshot held only
 * explicit-tier-keyed records a partial lookup can never resolve.
 *
 * Records nothing when:
 * - not a capture render, or the route derived no scope (the implicit doc
 *   scope's own cacheRoute below already records the doc record);
 * - the scope is STATICALLY disabled (cache(false)) — the replay gate
 *   pre-decides that shape as `cache-disabled` before any shell read, so a
 *   record would be dead weight;
 * - the prerender store supplied the match: those partials are served from
 *   build-time segments and report `prerender-store`.
 *
 * A false condition() suppresses the record too — the consumer's write
 * refusal is absolute. The prelude-already-bakes-it argument does NOT excuse
 * recording: a NAVIGATION-ONLY capture's prelude is never served as a
 * document, so for those entries the segment record would be the sole
 * persisted copy of a render the consumer refused to cache — and a later
 * request where condition() flips true could consume it through the seeded
 * fallback. The lookup-time `cache-disabled` report stays reachable without
 * the record: matchPartialWithPprReplay installs a REPORT-ONLY marker (no
 * store) on the no-eligible-snapshot path, so the lookup's own refusal is
 * still surfaced while the fallback has nothing to serve.
 *
 * Wrapped in requestCtx.waitUntil — during a capture that is the tracked-write
 * override, so captureAndStoreShell's settleWrites awaits the record before
 * draining the snapshot.
 */
function recordShellCaptureDocRecord<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  segments: ResolvedSegment[],
): void {
  const requestCtx = getRequestContext();
  if (!requestCtx?._shellCaptureRun) return;
  const marker = requestCtx._shellImplicitCache;
  if (!marker?.store) return;
  const scope = ctx.cacheScope;
  if (!scope || scope.isShellImplicitDocScope) return;
  if (ctx.isAction || ctx.isIntercept || ctx.request.method !== "GET") return;
  if (state.cacheSource === "prerender") return;
  if (!scope.allowsCache("write")) return;

  const docScope = createShellImplicitDocScope(marker);
  requestCtx.waitUntil(() =>
    docScope.cacheRoute(
      ctx.pathname,
      ctx.matched.params,
      segments,
      ctx.isIntercept,
    ),
  );
}
