/**
 * Navigation Snapshot
 *
 * Pure data type representing the navigation-specific state for partial requests.
 * Consolidates the header parsing, previous-route matching, intercept-context
 * detection, and segment ID filtering that previously lived inline in
 * createMatchContextForPartial (match-api.ts).
 *
 * resolveNavigation() is the factory: given a request + URL + current route key,
 * it returns a NavigationSnapshot (or null if no previous URL).
 */

import type { RouteMatchResult } from "./pattern-matching.js";

/**
 * Snapshot of navigation state for a partial (navigation/action) request.
 *
 * Contains the "where are we coming from?" data: previous route, intercept
 * source, client segment state, and derived flags.
 */
export interface NavigationSnapshot {
  /** Previous page URL (from X-RSC-Router-Client-Path or Referer) */
  prevUrl: URL;
  /** Params from the previous route match */
  prevParams: Record<string, string>;
  /** Previous route match result (null if prev URL doesn't match any route) */
  prevMatch: RouteMatchResult | null;

  /** URL used as intercept context source */
  interceptContextUrl: URL;
  /** Route match for the intercept context URL */
  interceptContextMatch: RouteMatchResult | null;

  /** Raw segment IDs the client currently has */
  clientSegmentIds: string[];
  /** Set version for O(1) lookup */
  clientSegmentSet: Set<string>;
  /** Segment IDs filtered to remove parallel (.@) and loader (D\d+.) entries */
  filteredSegmentIds: string[];

  /** Whether client considers its cache stale */
  stale: boolean;

  /** Whether the intercept context route is the same as the current route */
  isSameRouteNavigation: boolean;

  /** Effective "from" URL (intercept source URL when present, else prevUrl) */
  effectiveFromUrl: URL;
  /** Effective "from" match (intercept source match when present, else prevMatch) */
  effectiveFromMatch: RouteMatchResult | null;

  /** Whether an intercept source header was present */
  hasInterceptSource: boolean;

  /** Whether an HMR request header was present */
  isHmr: boolean;
}

export interface ResolveNavigationDeps {
  findMatch: (pathname: string) => RouteMatchResult | null;
}

/**
 * Resolve navigation state from a partial request.
 *
 * Returns null if no previous URL is available (required for partial navigation).
 *
 * @param request - The incoming HTTP request
 * @param url - Parsed URL of the request
 * @param currentRouteKey - Route key of the current (target) route match
 * @param deps - Dependencies (findMatch)
 */
export function resolveNavigation(
  request: Request,
  url: URL,
  currentRouteKey: string,
  deps: ResolveNavigationDeps,
): NavigationSnapshot | null {
  // Parse client state from RSC request params/headers
  const clientSegmentIds =
    url.searchParams.get("_rsc_segments")?.split(",").filter(Boolean) || [];
  const stale = url.searchParams.get("_rsc_stale") === "true";
  const previousUrl =
    request.headers.get("X-RSC-Router-Client-Path") ||
    request.headers.get("Referer");
  const interceptSourceUrl = request.headers.get(
    "X-RSC-Router-Intercept-Source",
  );
  const isHmr = !!request.headers.get("X-RSC-HMR");

  if (!previousUrl) {
    return null;
  }

  // Parse previous URL
  let prevUrl: URL;
  try {
    prevUrl = new URL(previousUrl, url.origin);
  } catch {
    return null;
  }

  // Parse intercept context URL
  let interceptContextUrl: URL;
  try {
    interceptContextUrl = interceptSourceUrl
      ? new URL(interceptSourceUrl, url.origin)
      : prevUrl;
  } catch {
    interceptContextUrl = prevUrl;
  }

  // Match previous and intercept context routes
  const prevMatch = deps.findMatch(prevUrl.pathname);
  const prevParams = prevMatch?.params || {};
  const interceptContextMatch = interceptSourceUrl
    ? deps.findMatch(interceptContextUrl.pathname)
    : prevMatch;

  // Derived state
  const isSameRouteNavigation = !!(
    interceptContextMatch && interceptContextMatch.routeKey === currentRouteKey
  );

  const hasInterceptSource = !!interceptSourceUrl;
  const effectiveFromUrl = hasInterceptSource ? interceptContextUrl : prevUrl;
  const effectiveFromMatch = hasInterceptSource
    ? interceptContextMatch
    : prevMatch;

  // Filter segment IDs: remove parallel (.@) and loader (D\d+.) entries
  const filteredSegmentIds = clientSegmentIds.filter((id) => {
    if (id.includes(".@")) return false;
    if (/D\d+\./.test(id)) return false;
    return true;
  });

  const clientSegmentSet = new Set(clientSegmentIds);

  return {
    prevUrl,
    prevParams,
    prevMatch,
    interceptContextUrl,
    interceptContextMatch,
    clientSegmentIds,
    clientSegmentSet,
    filteredSegmentIds,
    stale,
    isSameRouteNavigation,
    effectiveFromUrl,
    effectiveFromMatch,
    hasInterceptSource,
    isHmr,
  };
}

/**
 * Test helper: create a NavigationSnapshot with sensible defaults and overrides.
 */
export function createNavigationSnapshot(
  overrides?: Partial<NavigationSnapshot>,
): NavigationSnapshot {
  const defaultUrl = new URL("http://localhost/");
  return {
    prevUrl: defaultUrl,
    prevParams: {},
    prevMatch: null,
    interceptContextUrl: defaultUrl,
    interceptContextMatch: null,
    clientSegmentIds: [],
    clientSegmentSet: new Set(),
    filteredSegmentIds: [],
    stale: false,
    isSameRouteNavigation: false,
    effectiveFromUrl: defaultUrl,
    effectiveFromMatch: null,
    hasInterceptSource: false,
    isHmr: false,
    ...overrides,
  };
}
