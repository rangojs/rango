/**
 * Resolution Context Builder
 *
 * Builds a ResolutionContext from the various parameters in matchPartial.
 * This reduces the number of parameters passed between functions and
 * provides a single source of truth for the resolution state.
 */

import type { EntryData, MetricsStore } from "../server/context";
import type { HandlerContext } from "../types";
import type { ActionContext, ResolutionContext, RouteMatch } from "./types";

/**
 * Parameters for building a ResolutionContext
 */
export interface BuildContextParams<TEnv = any> {
  // Request info
  request: Request;
  url: URL;
  prevUrl: URL;
  previousUrlRaw: string;
  interceptSourceUrl: string | null;
  stale: boolean;

  // Route matching
  matched: RouteMatch;
  prevMatch: RouteMatch | null;
  interceptContextMatch: RouteMatch | null;
  manifestEntry: EntryData;
  entries: EntryData[];

  // Client state
  clientSegmentIds: string[];
  prevParams: Record<string, string>;

  // Platform
  bindings: TEnv;
  handlerContext: HandlerContext<any, TEnv>;
  actionContext?: ActionContext;

  // Runtime state
  loaderPromises: Map<string, Promise<any>>;
  metricsStore: MetricsStore | null;
}

/**
 * Build a ResolutionContext from matchPartial parameters
 *
 * This function bundles all the scattered parameters into a single
 * context object that can be passed to helper functions.
 *
 * @param params - Build parameters
 * @returns Fully initialized ResolutionContext
 *
 * @example
 * ```typescript
 * // In matchPartial, after setup:
 * const ctx = buildResolutionContext({
 *   request,
 *   url,
 *   prevUrl,
 *   // ... other params
 * });
 *
 * // Then pass ctx to helpers:
 * const shouldLookup = shouldLookupIntercept({
 *   isSameRouteNavigation: ctx.isSameRouteNavigation,
 *   isAction: ctx.isAction,
 *   clientSegmentSet: ctx.clientSegmentSet,
 * });
 * ```
 */
export function buildResolutionContext<TEnv = any>(
  params: BuildContextParams<TEnv>
): ResolutionContext<TEnv> {
  const {
    request,
    url,
    prevUrl,
    previousUrlRaw,
    interceptSourceUrl,
    stale,
    matched,
    prevMatch,
    interceptContextMatch,
    manifestEntry,
    entries,
    clientSegmentIds,
    prevParams,
    bindings,
    handlerContext,
    actionContext,
    loaderPromises,
    metricsStore,
  } = params;

  // Compute derived values
  const pathname = url.pathname;
  const isAction = !!actionContext;
  const clientSegmentSet = new Set(clientSegmentIds);

  // Extract local route name (last segment of routeKey)
  const localRouteName = matched.routeKey.includes(".")
    ? matched.routeKey.split(".").pop()!
    : matched.routeKey;

  // Check if navigating within the same route type
  const isSameRouteNavigation = !!(
    interceptContextMatch &&
    interceptContextMatch.routeKey === matched.routeKey
  );

  return {
    // Request information
    request,
    url,
    pathname,
    prevUrl,
    previousUrlRaw,
    interceptSourceUrl,
    stale,

    // Route matching results
    matched,
    prevMatch,
    interceptContextMatch,
    manifestEntry,
    entries,

    // Client state
    clientSegmentIds,
    clientSegmentSet,
    prevParams,

    // Platform context
    bindings,
    handlerContext,
    actionContext,

    // Shared mutable state
    loaderPromises,
    metricsStore,

    // Computed values
    isAction,
    localRouteName,
    isSameRouteNavigation,
  };
}

/**
 * Extract revalidation params from ResolutionContext
 *
 * Helper to get the params needed for revalidation functions
 */
export function getRevalidationParams<TEnv>(ctx: ResolutionContext<TEnv>) {
  return {
    prevParams: ctx.prevParams,
    request: ctx.request,
    prevUrl: ctx.prevUrl,
    nextUrl: ctx.url,
    routeKey: ctx.matched.routeKey,
    handlerContext: ctx.handlerContext,
    actionContext: ctx.actionContext,
  };
}

/**
 * Extract intercept resolution params from ResolutionContext
 */
export function getInterceptParams<TEnv>(ctx: ResolutionContext<TEnv>) {
  return {
    clientSegmentIds: ctx.clientSegmentSet,
    prevParams: ctx.prevParams,
    request: ctx.request,
    prevUrl: ctx.prevUrl,
    nextUrl: ctx.url,
    routeKey: ctx.matched.routeKey,
    actionContext: ctx.actionContext,
    stale: ctx.stale,
  };
}
