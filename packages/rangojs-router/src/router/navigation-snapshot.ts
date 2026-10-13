import { isLoaderSegmentId } from "../browser/react/filter-segment-order.js";
import { requestHeaders } from "../server/request-headers.js";
import type { RouteMatchResult } from "./pattern-matching.js";

export interface NavigationSnapshot {
  prevUrl: URL;
  /**
   * The visitor's URL of the page being left when `prevUrl` is its rewrite
   * target (X-RSC-Router-Client-Route); null otherwise.
   */
  prevVisitorUrl: URL | null;
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
 *
 * `requestOrigin` is the origin pathname matching uses (`url.origin`), which
 * may not be `request.url`'s. `X-RSC-Router-Client-Path` is returned as sent.
 * A Referer counts only when it resolves against that origin and stays there.
 * A cross-origin Referer is dropped: resolveNavigation matches only the
 * pathname, so a foreign URL would be treated as a route on this app. A value
 * that does not parse is no context either.
 */
export function getNavigationContextHeader(
  request: Request,
  requestOrigin: string,
): string | null {
  const headers = requestHeaders(request);
  const clientPath = headers.get("X-RSC-Router-Client-Path");
  if (clientPath) return clientPath;

  const referer = headers.get("Referer");
  if (!referer) return null;

  try {
    if (new URL(referer, requestOrigin).origin !== requestOrigin) return null;
  } catch {
    return null;
  }
  return referer;
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
  return pr === true && !requestHeaders(request).get("X-RSC-HMR");
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
  return requestHeaders(request).get("X-RSC-Router-Intercept-Source");
}

/**
 * The URL the page on screen rendered when middleware rewrote it there
 * (#1144): `X-RSC-Router-Client-Route`, which the browser sends from the
 * payload's `rewriteTarget` while `X-RSC-Router-Client-Path` names the
 * visitor's URL. The server cannot re-derive a rewrite an earlier request
 * took, and matching the visitor's URL finds the rewriting route, so every
 * navigation from the page re-rendered its route and loaders and a
 * `revalidate()` param predicate never held. Same origin only. It names
 * only the page being left; what renders is still matched from the
 * request's own URL, so a forged value runs and skips no middleware.
 * Ignored beside `X-RSC-Router-Intercept-Source`: an intercept's request
 * is diffed from its source, which the header does not describe.
 */
function getShownRouteUrl(request: Request, origin: string): URL | null {
  const route = requestHeaders(request).get("X-RSC-Router-Client-Route");
  if (!route) return null;
  try {
    const shown = new URL(route, origin);
    return shown.origin === origin ? shown : null;
  } catch {
    return null;
  }
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
  const previousUrl = getNavigationContextHeader(request, url.origin);
  const interceptSourceUrl = getInterceptSourceHeader(request);
  const isHmr = !!requestHeaders(request).get("X-RSC-HMR");

  if (!previousUrl) {
    return null;
  }

  let prevUrl: URL;
  let prevVisitorUrl: URL | null = null;
  try {
    const visitor = new URL(previousUrl, url.origin);
    const shown = !interceptSourceUrl && getShownRouteUrl(request, url.origin);
    prevUrl = shown || visitor;
    if (shown) prevVisitorUrl = visitor;
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
    if (isLoaderSegmentId(id)) return false;
    return true;
  });

  const clientSegmentSet = new Set(clientSegmentIds);

  return {
    prevUrl,
    prevVisitorUrl,
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
    prevVisitorUrl: null,
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
