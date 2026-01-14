/**
 * Router Cache Handlers
 *
 * Extracted cache hit and cache miss handling for matchPartial.
 * These functions handle the two main branches of partial matching:
 * - Cache hit: Use cached segments + resolve fresh loaders
 * - Cache miss: Resolve all segments from scratch
 */

import type { ResolvedSegment, SlotState } from "../types";
import type { EntryData } from "../server/context";
import type {
  InterceptResult,
  SegmentResolutionResult,
  ResolutionContext,
} from "./types";
import type { EntryRevalidateMap } from "./cache-revalidation";
import { applyCacheRevalidation } from "./cache-revalidation.js";
import { getInterceptParams } from "./resolution-context.js";

/**
 * Dependencies needed by cache handlers
 * These are functions defined in the router closure
 */
export interface CacheHandlerDeps {
  Store: any;
  getContext: () => any;
  buildEntryRevalidateMap: (entries: EntryData[]) => EntryRevalidateMap;
  resolveLoadersOnlyWithRevalidation: (
    entries: EntryData[],
    handlerContext: any,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    url: URL,
    routeKey: string,
    actionContext?: any
  ) => Promise<SegmentResolutionResult>;
  resolveAllSegmentsWithRevalidation: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: any,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    url: URL,
    loaderPromises: Map<string, Promise<any>>,
    actionContext: any,
    interceptResult: InterceptResult | null,
    localRouteName: string,
    pathname: string
  ) => Promise<SegmentResolutionResult>;
  resolveInterceptEntry: (
    intercept: any,
    entry: any,
    params: Record<string, string>,
    handlerContext: any,
    belongsToRoute: boolean,
    revalidationContext?: any
  ) => Promise<ResolvedSegment[]>;
  resolveInterceptLoadersOnly: (
    intercept: any,
    entry: any,
    params: Record<string, string>,
    handlerContext: any,
    belongsToRoute: boolean,
    revalidationContext?: any
  ) => Promise<any>;
}

/**
 * Cache result from lookup
 */
export interface CacheResult {
  segments: ResolvedSegment[];
  shouldRevalidate: boolean;
}

/**
 * Result from cache hit/miss handlers
 */
export interface CacheHandlerResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

/**
 * Handle cache hit path in matchPartial
 *
 * Uses cached non-loader segments and resolves loaders fresh.
 * Applies revalidation to cached segments to skip unchanged ones.
 * Does NOT handle SWR background revalidation - that's done by the caller.
 *
 * @param ctx - Resolution context with all request/route info
 * @param deps - Router closure dependencies
 * @param cacheResult - Cache lookup result with segments
 * @returns Resolved segments and matched IDs
 */
export async function handleCacheHit<TEnv>(
  ctx: ResolutionContext<TEnv>,
  deps: CacheHandlerDeps,
  cacheResult: CacheResult
): Promise<CacheHandlerResult> {
  const {
    Store,
    getContext,
    buildEntryRevalidateMap,
    resolveLoadersOnlyWithRevalidation,
  } = deps;

  // Cache HIT - use cached non-loader segments
  const cachedSegments = cacheResult.segments;
  const cachedMatchedIds = cacheResult.segments.map((s) => s.id);

  // Apply revalidation to cached segments - set component=null for segments
  // client already has and doesn't need to update
  const entryRevalidateMap = buildEntryRevalidateMap(ctx.entries);
  await applyCacheRevalidation({
    cachedSegments,
    clientSegmentSet: ctx.clientSegmentSet,
    entryRevalidateMap,
    prevParams: ctx.prevParams,
    request: ctx.request,
    prevUrl: ctx.prevUrl,
    nextUrl: ctx.url,
    routeKey: ctx.matched.routeKey,
    handlerContext: ctx.handlerContext,
    actionContext: ctx.actionContext,
  });

  // Resolve loaders fresh with revalidation logic (loaders are NOT cached)
  const loaderResult = await getContext().runWithStore(
    Store,
    Store.namespace || "#router",
    Store.parent,
    () =>
      resolveLoadersOnlyWithRevalidation(
        ctx.entries,
        ctx.handlerContext,
        ctx.clientSegmentSet,
        ctx.prevParams,
        ctx.request,
        ctx.prevUrl,
        ctx.url,
        ctx.matched.routeKey,
        ctx.actionContext
      )
  );

  // Combine cached segments + fresh loaders
  return {
    segments: [...cachedSegments, ...loaderResult.segments],
    matchedIds: [...cachedMatchedIds, ...loaderResult.matchedIds],
  };
}

/**
 * Handle cache miss path in matchPartial
 *
 * Resolves all segments from scratch with revalidation logic.
 * Also resolves intercept segments if intercepting.
 *
 * @param ctx - Resolution context with all request/route info
 * @param deps - Router closure dependencies
 * @param interceptResult - Intercept detection result (if any)
 * @param slots - Slots object to populate with intercept data
 * @returns Resolved segments, matched IDs, and intercept segments
 */
export async function handleCacheMiss<TEnv>(
  ctx: ResolutionContext<TEnv>,
  deps: CacheHandlerDeps,
  interceptResult: InterceptResult | null,
  slots: Record<string, SlotState>
): Promise<CacheHandlerResult & { interceptSegments: ResolvedSegment[] }> {
  const {
    Store,
    getContext,
    resolveAllSegmentsWithRevalidation,
    resolveInterceptEntry,
  } = deps;

  // Resolve all segments with revalidation logic
  const result = await getContext().runWithStore(
    Store,
    Store.namespace || "#router",
    Store.parent,
    async () => {
      return resolveAllSegmentsWithRevalidation(
        ctx.entries,
        ctx.matched.routeKey,
        ctx.matched.params,
        ctx.handlerContext,
        ctx.clientSegmentSet,
        ctx.prevParams,
        ctx.request,
        ctx.prevUrl,
        ctx.url,
        ctx.loaderPromises,
        ctx.actionContext,
        interceptResult,
        ctx.localRouteName,
        ctx.pathname
      );
    }
  );

  let interceptSegments: ResolvedSegment[] = [];

  // For intercept navigations, resolve intercept segments
  if (interceptResult) {
    const slotName = interceptResult.intercept.slotName;
    console.log(
      `[Router.handleCacheMiss] Found intercept for "${ctx.localRouteName}" -> slot "${slotName}"`
    );

    // Resolve intercept entry (middleware, loaders, handler)
    interceptSegments = await getContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      () =>
        resolveInterceptEntry(
          interceptResult.intercept,
          interceptResult.entry,
          ctx.matched.params,
          ctx.handlerContext,
          true, // belongsToRoute
          getInterceptParams(ctx)
        )
    );

    // Add to slots metadata
    slots[slotName] = {
      active: true,
      segments: interceptSegments,
    };
  }

  return {
    segments: result.segments,
    matchedIds: result.matchedIds,
    interceptSegments,
  };
}

/**
 * Handle intercept resolution for cache hits
 *
 * For cache hits with intercept, extracts intercept segments from cached data
 * and re-resolves loaders to get fresh data.
 *
 * @param ctx - Resolution context
 * @param deps - Router closure dependencies
 * @param interceptResult - Intercept detection result
 * @param cachedSegments - All cached segments
 * @param slots - Slots object to populate
 * @returns Intercept segments
 */
export async function handleCacheHitIntercept<TEnv>(
  ctx: ResolutionContext<TEnv>,
  deps: CacheHandlerDeps,
  interceptResult: InterceptResult,
  cachedSegments: ResolvedSegment[],
  slots: Record<string, SlotState>
): Promise<ResolvedSegment[]> {
  const { Store, getContext, resolveInterceptLoadersOnly } = deps;

  const slotName = interceptResult.intercept.slotName;

  // Find intercept segments from cached segments (have namespace starting with "intercept:")
  const interceptSegments = cachedSegments.filter((s) =>
    s.namespace?.startsWith("intercept:")
  );

  // Re-resolve intercept loaders for fresh data on cache hit
  const freshLoaderResult = await getContext().runWithStore(
    Store,
    Store.namespace || "#router",
    Store.parent,
    () =>
      resolveInterceptLoadersOnly(
        interceptResult.intercept,
        interceptResult.entry,
        ctx.matched.params,
        ctx.handlerContext,
        true, // belongsToRoute
        getInterceptParams(ctx)
      )
  );

  // Update intercept segment's loaderDataPromise with fresh data
  if (freshLoaderResult) {
    const interceptMainSegment = interceptSegments.find(
      (s) => s.type === "parallel" && s.slot
    );
    if (interceptMainSegment) {
      interceptMainSegment.loaderDataPromise = freshLoaderResult.loaderDataPromise;
      interceptMainSegment.loaderIds = freshLoaderResult.loaderIds;
      console.log(
        `[Router.handleCacheHitIntercept] Cache HIT + fresh loaders for intercept "${ctx.localRouteName}" -> slot "${slotName}"`
      );
    }
  } else {
    console.log(
      `[Router.handleCacheHitIntercept] Cache HIT for intercept "${ctx.localRouteName}" -> slot "${slotName}" (no loader revalidation)`
    );
  }

  slots[slotName] = {
    active: true,
    segments: interceptSegments,
  };

  return interceptSegments;
}
