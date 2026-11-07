/**
 * Intercept Resolution Middleware
 *
 * Resolves intercept (modal slot) segments for soft navigation.
 * Yields intercept segments after main route segments.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from segment-resolution)
 *         |
 *         v
 *   +---------------------------+
 *   | Collect + yield source   |  Pass through main segments
 *   | segments[]               |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | isFullMatch?        |──yes──> return (no intercepts on doc requests)
 *   +---------------------+
 *         | no
 *         v
 *   +---------------------+
 *   | Has interceptResult |──no───> return
 *   | AND not cached?     |
 *   +---------------------+
 *         | yes
 *         v
 *   +----------------------+    +----------------------------+
 *   | Fresh intercept?     |yes>| resolveInterceptEntry()    |
 *   | (!cacheHit or        |    | - loaders, UI              |
 *   |  no intercept segs)  |    +----------------------------+
 *   +----------------------+              |
 *         | no                            v
 *         v                    yield intercept segments
 *   +----------------------------+        |
 *   | Cache hit with intercept   |        |
 *   | handleCacheHitIntercept()  |        |
 *   | - Extract from cache       |        |
 *   | - Re-resolve loaders only  |        |
 *   +----------------------------+        |
 *         |                               |
 *         +-------------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | Update state:             |
 *   |  - interceptSegments      |
 *   |  - slots[slotName]        |
 *   +---------------------------+
 *         |
 *         v
 *      next middleware
 *
 *
 * INTERCEPT SCENARIOS
 * ===================
 *
 * 1. Fresh intercept (no cache):
 *    - Full resolution of intercept entry
 *    - Resolves loaders and component
 *    - Yields all intercept segments
 *
 * 2. Cache hit with intercept:
 *    - Extracts intercept segments from cached data
 *    - Re-resolves ONLY loaders for fresh data
 *    - Keeps cached component/layout
 *
 * 3. No intercept:
 *    - Passes through unchanged
 *    - No intercept segments yielded
 *
 *
 * WHAT ARE INTERCEPTS?
 * ====================
 *
 * Intercepts enable "soft navigation" patterns like modals:
 *
 *   1. User clicks a link (e.g., /photos/123)
 *   2. Instead of full navigation, content renders in a modal slot
 *   3. Background page remains visible and interactive
 *   4. Hard navigation (direct URL) shows full page
 *
 * Configuration:
 *   intercept("@modal", "photos", <PhotoModal />, () => [...])
 *
 * The intercept resolves to segments that render in the named slot
 * instead of replacing the main content.
 *
 *
 * SLOT STRUCTURE
 * ==============
 *
 * state.slots[slotName] = {
 *   active: true,
 *   segments: [...intercept segments]
 * }
 *
 * The client uses this to:
 *   1. Keep current page segments
 *   2. Render intercept segments in named <Outlet name="@modal" />
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { interceptPassInput } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";
import { debugLog } from "../logging.js";
import { isInterceptSegment } from "../../browser/intercept-utils.js";
import {
  interceptFillSkips,
  isInterceptFill,
} from "../segment-resolution/prefetch-deferral.js";

/**
 * A fill that resolves an intercept sends only what the client lacks of the
 * intercept (interceptFillSkips): a segment outside the slot that the client
 * does not hold is outside the intercept's `matched`, and the browser merges
 * a fill's loader segments into the held tree (fillHoles), so one outside
 * `matched` would land there. The match pipeline's last step, so it holds for
 * every segment source, a new one included. Any other request gets the
 * source itself, with no generator in between.
 */
export function withInterceptFill<TEnv>(
  ctx: MatchContext<TEnv>,
): GeneratorMiddleware<ResolvedSegment> {
  if (!isInterceptFill(ctx)) return (source) => source;
  return async function* (source) {
    for await (const segment of source) {
      if (!interceptFillSkips(ctx, segment)) yield segment;
    }
  };
}

/**
 * Creates intercept resolution middleware
 *
 * If ctx.interceptResult exists and we're not in a cache-hit-with-intercept scenario:
 * - Resolves intercept segments
 * - Updates state.interceptSegments and state.interceptMatchedIds
 * - Updates state.slots with the intercept slot
 * - Yields intercept segments after main segments
 */
export function withInterceptResolution<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>,
  ): AsyncGenerator<ResolvedSegment> {
    const ms = ctx.metricsStore;

    const segments: ResolvedSegment[] = [];
    for await (const segment of source) {
      segments.push(segment);
      yield segment;
    }

    const ownStart = performance.now();

    if (ctx.isFullMatch) {
      if (ms) {
        ms.metrics.push({
          label: "pipeline:intercept",
          duration: performance.now() - ownStart,
          startTime: ownStart - ms.requestStart,
        });
      }
      return;
    }

    const skipInterceptResolution =
      !ctx.interceptResult ||
      state.interceptSegments.length > 0 ||
      (state.cacheHit && ctx.isIntercept);

    if (skipInterceptResolution) {
      if (ctx.interceptResult && state.cacheHit && ctx.isIntercept) {
        yield* await handleCacheHitIntercept(ctx, state, segments);
      }
      if (ms) {
        ms.metrics.push({
          label: "pipeline:intercept",
          duration: performance.now() - ownStart,
          startTime: ownStart - ms.requestStart,
        });
      }
      return;
    }

    const { resolveInterceptEntry } = getRouterContext<TEnv>();

    const slotName = ctx.interceptResult!.intercept.slotName;
    debugLog("matchPartial.intercept", "intercept resolved", {
      routeName: ctx.localRouteName,
      slotName,
    });

    const Store = ctx.Store;
    const { segments: interceptSegments, matchedIds } = await Store.run(() =>
      resolveInterceptEntry(
        interceptPassInput(ctx),
        ctx.interceptResult!.intercept,
        ctx.interceptResult!.entry,
        true, // belongsToRoute
      ),
    );

    state.interceptSegments = interceptSegments;
    state.interceptMatchedIds = matchedIds;
    state.slots[slotName] = {
      active: true,
      segments: interceptSegments,
    };

    for (const segment of interceptSegments) {
      yield segment;
    }

    if (ms) {
      ms.metrics.push({
        label: "pipeline:intercept",
        duration: performance.now() - ownStart,
        startTime: ownStart - ms.requestStart,
      });
    }
  };
}

/**
 * A cache or prerender hit that carries the intercept's slot: the slot keeps
 * its stored component and layout, and its loaders, never stored, resolve as
 * loader segments of it. Returns those segments for the caller to yield.
 */
async function handleCacheHitIntercept<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
  segments: ResolvedSegment[],
): Promise<ResolvedSegment[]> {
  if (!ctx.interceptResult) return [];

  const { resolveInterceptLoadersOnly } = getRouterContext<TEnv>();

  const slotName = ctx.interceptResult.intercept.slotName;

  const cachedSlot = segments.filter(isInterceptSegment);
  // A record stored before 0.25.0 carries the loaders' aggregate on the slot;
  // the loader segments below replace it. Build versions hash the router's
  // code, so an upgrade does not read one; a custom store that ignores
  // versions can.
  for (const slot of cachedSlot) {
    delete slot.loaderDataPromise;
    delete slot.loaderIds;
  }

  const { segments: loaderSegments, matchedIds } = resolveInterceptLoadersOnly
    ? await ctx.Store.run(() =>
        resolveInterceptLoadersOnly(
          interceptPassInput(ctx),
          ctx.interceptResult!.intercept,
          ctx.interceptResult!.entry,
          true, // belongsToRoute
        ),
      )
    : { segments: [], matchedIds: cachedSlot.map((s) => s.id) };
  const interceptSegments = [...cachedSlot, ...loaderSegments];
  state.interceptSegments = interceptSegments;
  state.interceptMatchedIds = matchedIds;
  state.slots[slotName] = {
    active: true,
    segments: interceptSegments,
  };
  return loaderSegments;
}
