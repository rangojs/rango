import type { RouteMatchResult } from "./pattern-matching.js";

export interface NavigationSnapshot {
  prevUrl: URL;
  prevParams: Record<string, string>;
  prevMatch: RouteMatchResult | null;

  interceptContextUrl: URL;
  interceptContextMatch: RouteMatchResult | null;

  clientSegmentIds: string[];
  clientSegmentSet: Set<string>;
  filteredSegmentIds: string[];

  stale: boolean;

  isSameRouteNavigation: boolean;

  effectiveFromUrl: URL;
  effectiveFromMatch: RouteMatchResult | null;

  hasInterceptSource: boolean;

  isHmr: boolean;
}

export interface ResolveNavigationDeps {
  findMatch: (pathname: string) => RouteMatchResult | null;
}

export function resolveNavigation(
  request: Request,
  url: URL,
  currentRouteKey: string,
  deps: ResolveNavigationDeps,
): NavigationSnapshot | null {
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

  let prevUrl: URL;
  try {
    prevUrl = new URL(previousUrl, url.origin);
  } catch {
    return null;
  }

  let interceptContextUrl: URL;
  try {
    interceptContextUrl = interceptSourceUrl
      ? new URL(interceptSourceUrl, url.origin)
      : prevUrl;
  } catch {
    interceptContextUrl = prevUrl;
  }

  const prevMatch = deps.findMatch(prevUrl.pathname);
  const prevParams = prevMatch?.params || {};
  const interceptContextMatch = interceptSourceUrl
    ? deps.findMatch(interceptContextUrl.pathname)
    : prevMatch;

  const isSameRouteNavigation = !!(
    interceptContextMatch && interceptContextMatch.routeKey === currentRouteKey
  );

  const hasInterceptSource = !!interceptSourceUrl;
  const effectiveFromUrl = hasInterceptSource ? interceptContextUrl : prevUrl;
  const effectiveFromMatch = hasInterceptSource
    ? interceptContextMatch
    : prevMatch;

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
