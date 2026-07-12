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
  findMatch: (
    pathname: string,
  ) => RouteMatchResult | null | Promise<RouteMatchResult | null>;
}

/**
 * The raw navigation-context header for a partial request, or null when the
 * request carries none. Single source of truth shared by resolveNavigation and
 * the PPR replay gate (matchPartialWithPprReplay): a context-less partial can
 * never produce a partial match, so the replay path must decide
 * `no-navigation-context` BEFORE spending shell-store reads — the two
 * predicates drifting apart would misattribute the bypass again.
 */
export function getNavigationContextHeader(request: Request): string | null {
  return (
    request.headers.get("X-RSC-Router-Client-Path") ||
    request.headers.get("Referer")
  );
}

/**
 * Whether withCacheLookup's prerender short-circuit will serve this partial
 * from the build-time prerender store: a Prerender() match (`matched.pr`)
 * outside dev HMR — the short-circuit is disabled on X-RSC-HMR so HMR
 * navigations pick up edited modules. Shared by withCacheLookup and the PPR
 * replay gate (matchPartialWithPprReplay) for the same drift reason as
 * getNavigationContextHeader: the gate's `prerender-store` bypass must decide
 * exactly what the middleware will actually do. (Both callers additionally
 * exclude actions on their own paths — the gate via its GET-only check.)
 */
export function prerenderStoreShortCircuits(
  pr: true | undefined,
  request: Request,
): boolean {
  return pr === true && !request.headers.get("X-RSC-HMR");
}

/**
 * The intercept-source header for a partial request, or null when the request
 * carries none. Shared by resolveNavigation and the PPR replay gate's
 * prerender probe: intercept navigations consult the intercept-specific
 * prerender artifact (`paramHash + "/i"`), so the probe must check the same
 * variant the middleware will — probing the bare hash for an intercept
 * request would report `prerender-store` for an artifact that cannot serve.
 */
export function getInterceptSourceHeader(request: Request): string | null {
  return request.headers.get("X-RSC-Router-Intercept-Source");
}

export async function resolveNavigation(
  request: Request,
  url: URL,
  currentRouteKey: string,
  deps: ResolveNavigationDeps,
): Promise<NavigationSnapshot | null> {
  const clientSegmentIds =
    url.searchParams.get("_rsc_segments")?.split(",").filter(Boolean) || [];
  const stale = url.searchParams.get("_rsc_stale") === "true";
  const previousUrl = getNavigationContextHeader(request);
  const interceptSourceUrl = getInterceptSourceHeader(request);
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

  const prevMatch = await deps.findMatch(prevUrl.pathname);
  const prevParams = prevMatch?.params || {};
  const interceptContextMatch = interceptSourceUrl
    ? await deps.findMatch(interceptContextUrl.pathname)
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
