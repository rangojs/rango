/**
 * Router Cache Revalidation
 *
 * Functions for applying revalidation logic to cached segments.
 */

import type { ResolvedSegment, HandlerContext, ShouldRevalidateFn } from "../types";
import type { EntryData } from "../server/context";
import type { ActionContext } from "./types";
import { evaluateRevalidation } from "./revalidation.js";

/**
 * Map of segment ID to entry info for revalidation lookup
 */
export type EntryRevalidateMap = Map<
  string,
  { entry: EntryData; revalidate: ShouldRevalidateFn<any, any>[] }
>;

/**
 * Parameters for applying revalidation to cached segments
 */
export interface ApplyCacheRevalidationParams<TEnv = any> {
  /** Cached segments to process */
  cachedSegments: ResolvedSegment[];
  /** Set of segment IDs the client already has */
  clientSegmentSet: Set<string>;
  /** Map of segment ID to revalidation rules */
  entryRevalidateMap: EntryRevalidateMap;
  /** Previous route params for comparison */
  prevParams: Record<string, string>;
  /** Request object */
  request: Request;
  /** Previous URL */
  prevUrl: URL;
  /** Current/next URL */
  nextUrl: URL;
  /** Route key for context */
  routeKey: string;
  /** Handler context */
  handlerContext: HandlerContext<any, TEnv>;
  /** Action context if action request */
  actionContext?: ActionContext;
}

/**
 * Apply revalidation logic to cached segments.
 *
 * For each cached segment that the client already has:
 * 1. If no revalidation rules exist, set component=null (skip re-render)
 * 2. If revalidation rules exist, evaluate them
 * 3. If evaluation returns false, set component=null (skip re-render)
 *
 * This mutates the cachedSegments array in place, setting component=null
 * and loading=undefined for segments that don't need to be re-rendered.
 *
 * Intercept segments (namespace starts with "intercept:") are skipped
 * as they're handled separately.
 *
 * @param params - Revalidation parameters
 */
export async function applyCacheRevalidation<TEnv = any>(
  params: ApplyCacheRevalidationParams<TEnv>
): Promise<void> {
  const {
    cachedSegments,
    clientSegmentSet,
    entryRevalidateMap,
    prevParams,
    request,
    prevUrl,
    nextUrl,
    routeKey,
    handlerContext,
    actionContext,
  } = params;

  for (const segment of cachedSegments) {
    // Skip segments client doesn't have - they need their component
    if (!clientSegmentSet.has(segment.id)) continue;

    // Skip intercept segments - they're handled separately
    if (segment.namespace?.startsWith("intercept:")) continue;

    // Look up revalidation rules for this segment
    const entryInfo = entryRevalidateMap.get(segment.id);
    if (!entryInfo || entryInfo.revalidate.length === 0) {
      // No revalidation rules, use default behavior (skip if client has)
      segment.component = null;
      segment.loading = undefined;
      continue;
    }

    const shouldRevalidate = await evaluateRevalidation({
      segment,
      prevParams,
      getPrevSegment: null,
      request,
      prevUrl,
      nextUrl,
      revalidations: entryInfo.revalidate.map((fn, i) => ({
        name: `revalidate${i}`,
        fn,
      })),
      routeKey,
      context: handlerContext,
      actionContext,
    });

    if (!shouldRevalidate) {
      segment.component = null; // Client has it, no revalidation needed
      segment.loading = undefined; // Clear loading to prevent Suspense
    }
  }
}
