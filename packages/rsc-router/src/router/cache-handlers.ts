/**
 * Router Cache Handlers
 *
 * Extracted cache hit and cache miss handling for matchPartial.
 * These functions handle the two main branches of partial matching:
 * - Cache hit: Use cached segments + resolve fresh loaders
 * - Cache miss: Resolve all segments from scratch
 */

import type { ResolvedSegment, HandlerContext, ShouldRevalidateFn } from "../types";
import type { EntryData, InterceptEntry, MetricsStore } from "../server/context";
import type {
  ActionContext,
  InterceptResult,
  SegmentResolutionResult,
  SlotState,
} from "./types";
import type { EntryRevalidateMap } from "./cache-revalidation";
import { applyCacheRevalidation } from "./cache-revalidation.js";

/**
 * Parameters shared between cache hit and cache miss handlers
 */
export interface CacheHandlerParams<TEnv = any> {
  // Route info
  entries: EntryData[];
  matched: { routeKey: string; params: Record<string, string> };
  localRouteName: string;
  pathname: string;

  // Request context
  request: Request;
  url: URL;
  prevUrl: URL;
  stale: boolean;

  // Client state
  clientSegmentSet: Set<string>;
  prevParams: Record<string, string>;

  // Handler context
  handlerContext: HandlerContext<any, TEnv>;
  actionContext?: ActionContext;
  bindings: TEnv;

  // Intercept info
  interceptResult: InterceptResult | null;

  // Store for running with context
  Store: any;

  // Helper functions (passed from router)
  getContext: () => any;
  buildEntryRevalidateMap: (entries: EntryData[]) => EntryRevalidateMap;
  resolveLoadersOnlyWithRevalidation: (...args: any[]) => Promise<SegmentResolutionResult>;
  resolveAllSegmentsWithRevalidation: (...args: any[]) => Promise<SegmentResolutionResult>;
  resolveInterceptEntry: (...args: any[]) => Promise<ResolvedSegment[]>;
  resolveInterceptLoadersOnly: (...args: any[]) => Promise<any>;
  loaderPromises: Map<string, Promise<any>>;

  // Metrics
  metricsStore: MetricsStore | null;
}

/**
 * Cache hit result with segments and metadata
 */
export interface CacheHitResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
  interceptSegments: ResolvedSegment[];
  slots: Record<string, SlotState>;
}

/**
 * Cache miss result with segments and metadata
 */
export interface CacheMissResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
  interceptSegments: ResolvedSegment[];
  slots: Record<string, SlotState>;
}

/**
 * Handle cache hit path in matchPartial
 *
 * Uses cached non-loader segments and resolves loaders fresh.
 * Applies revalidation to cached segments to skip unchanged ones.
 *
 * @param params - Common handler parameters
 * @param cacheResult - Cache lookup result with segments
 * @returns Resolved segments and intercept data
 */
export async function handleCacheHit<TEnv>(
  params: CacheHandlerParams<TEnv>,
  cacheResult: { segments: ResolvedSegment[]; shouldRevalidate: boolean }
): Promise<CacheHitResult> {
  const {
    entries,
    matched,
    localRouteName,
    pathname,
    request,
    url,
    prevUrl,
    stale,
    clientSegmentSet,
    prevParams,
    handlerContext,
    actionContext,
    Store,
    getContext,
    buildEntryRevalidateMap,
    resolveLoadersOnlyWithRevalidation,
    resolveInterceptLoadersOnly,
    interceptResult,
  } = params;

  // Cache HIT - use cached non-loader segments
  const cachedSegments = cacheResult.segments;
  const cachedMatchedIds = cacheResult.segments.map((s) => s.id);

  // Apply revalidation to cached segments
  const entryRevalidateMap = buildEntryRevalidateMap(entries);
  await applyCacheRevalidation({
    cachedSegments,
    clientSegmentSet,
    entryRevalidateMap,
    prevParams,
    request,
    prevUrl,
    nextUrl: url,
    routeKey: matched.routeKey,
    handlerContext,
    actionContext,
  });

  // Resolve loaders fresh with revalidation logic
  const loaderResult = await getContext().runWithStore(
    Store,
    Store.namespace || "#router",
    Store.parent,
    () =>
      resolveLoadersOnlyWithRevalidation(
        entries,
        handlerContext,
        clientSegmentSet,
        prevParams,
        request,
        prevUrl,
        url,
        matched.routeKey,
        actionContext
      )
  );

  // Combine cached segments + fresh loaders
  const segments = [...cachedSegments, ...loaderResult.segments];
  const matchedIds = [...cachedMatchedIds, ...loaderResult.matchedIds];

  // Handle intercepts for cache hit
  const slots: Record<string, SlotState> = {};
  let interceptSegments: ResolvedSegment[] = [];

  if (interceptResult) {
    const slotName = interceptResult.intercept.slotName;

    // Check if we have cached intercept segments
    const cachedInterceptSegments = cachedSegments.filter(
      (s) => s.namespace?.startsWith("intercept:")
    );

    if (cachedInterceptSegments.length > 0) {
      interceptSegments = cachedInterceptSegments;

      // Resolve fresh loaders for intercept if needed
      const freshLoaderResult = await getContext().runWithStore(
        Store,
        Store.namespace || "#router",
        Store.parent,
        () =>
          resolveInterceptLoadersOnly(
            interceptResult.intercept,
            interceptResult.entry,
            matched.params,
            handlerContext,
            true,
            {
              clientSegmentIds: clientSegmentSet,
              prevParams,
              request,
              prevUrl,
              nextUrl: url,
              routeKey: matched.routeKey,
              actionContext,
              stale,
            }
          )
      );

      // Update intercept segment's loaderDataPromise
      if (freshLoaderResult) {
        const interceptMainSegment = interceptSegments.find(
          (s) => s.type === "parallel" && s.slot
        );
        if (interceptMainSegment) {
          interceptMainSegment.loaderDataPromise = freshLoaderResult.loaderDataPromise;
          interceptMainSegment.loaderIds = freshLoaderResult.loaderIds;
          console.log(
            `[Router.matchPartial] Cache HIT + fresh loaders for intercept "${localRouteName}" -> slot "${slotName}"`
          );
        }
      } else {
        console.log(
          `[Router.matchPartial] Cache HIT for intercept "${localRouteName}" -> slot "${slotName}" (no loader revalidation)`
        );
      }

      slots[slotName] = {
        active: true,
        segments: interceptSegments,
      };
    }
  }

  return {
    segments,
    matchedIds,
    interceptSegments,
    slots,
  };
}
