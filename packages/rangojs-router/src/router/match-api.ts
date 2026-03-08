/**
 * Match API
 *
 * Extracted from createRouter closure. Contains match context creation functions
 * and the matchError function for error boundary resolution.
 */

import { CacheScope, createCacheScope } from "../cache/cache-scope.js";
import { RouteNotFoundError } from "../errors";
import {
  createErrorInfo,
  createErrorSegment,
  findNearestErrorBoundary as findErrorBoundary,
} from "./error-handling.js";
import {
  createHandlerContext,
  stripInternalParams,
} from "./handler-context.js";
import { setupLoaderAccess } from "./loader-resolution.js";
import { loadManifest, clearManifestCache } from "./manifest.js";
import { collectRouteMiddleware } from "./middleware.js";
import { traverseBack } from "./pattern-matching.js";
import { DefaultErrorFallback } from "../default-error-boundary.js";
import {
  EntryData,
  LoaderEntry,
  getContext,
  InterceptSelectorContext,
} from "../server/context";
import type { ErrorBoundaryHandler, ErrorInfo, MatchResult } from "../types";
import type { ReactNode } from "react";
import type { MatchContext } from "./match-context.js";
import type { MatchApiDeps, ActionContext } from "./types.js";
import { getRequestContext } from "../server/request-context.js";
import { debugLog, debugWarn } from "./logging.js";

/**
 * Create match context for full requests (document/SSR).
 */
export async function createMatchContextForFull<TEnv>(
  request: Request,
  env: TEnv,
  deps: MatchApiDeps<TEnv>,
  findInterceptForRoute: MatchApiDeps<TEnv>["findInterceptForRoute"],
): Promise<MatchContext<TEnv> | { type: "redirect"; redirectUrl: string }> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const metricsStore = deps.getMetricsStore();

  const routeMatchStart = metricsStore ? performance.now() : 0;
  const matched = deps.findMatch(pathname, metricsStore);
  if (metricsStore) {
    metricsStore.metrics.push({
      label: "route-matching",
      duration: performance.now() - routeMatchStart,
      startTime: routeMatchStart - metricsStore.requestStart,
    });
  }

  if (!matched) {
    throw new RouteNotFoundError(`No route matched for ${pathname}`, {
      cause: { pathname, method: request.method },
    });
  }

  if (matched.redirectTo) {
    return {
      type: "redirect",
      redirectUrl: matched.redirectTo + url.search,
    };
  }

  const manifestStart = metricsStore ? performance.now() : 0;
  const manifestEntry = await loadManifest(
    matched.entry,
    matched.routeKey,
    pathname,
    metricsStore,
    true,
  );
  if (metricsStore) {
    metricsStore.metrics.push({
      label: "manifest-loading",
      duration: performance.now() - manifestStart,
      startTime: manifestStart - metricsStore.requestStart,
    });
  }

  const routeMiddleware = collectRouteMiddleware(
    traverseBack(manifestEntry),
    matched.params,
  );

  // Clean URL without internal _rsc* params for userland access
  const cleanUrl = stripInternalParams(url);

  const handlerContext = createHandlerContext(
    matched.params,
    request,
    cleanUrl.searchParams,
    pathname,
    cleanUrl,
    env,
    deps.getRouteMap(),
    matched.routeKey,
    matched.responseType,
  );

  const loaderPromises = new Map<string, Promise<any>>();
  setupLoaderAccess(handlerContext, loaderPromises);

  const Store = getContext().getOrCreateStore(matched.routeKey);
  Store.run = <T>(fn: () => T | Promise<T>) =>
    getContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      fn,
    );
  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  const entries = [...traverseBack(manifestEntry)];
  let cacheScope: CacheScope | null = null;
  for (const entry of entries) {
    if (entry.cache) {
      cacheScope = createCacheScope(entry.cache, cacheScope);
    }
  }

  return {
    request,
    url: cleanUrl,
    pathname,
    env,
    clientSegmentIds: [],
    clientSegmentSet: new Set(),
    stale: false,
    prevUrl: cleanUrl,
    prevParams: {},
    prevMatch: null,
    matched,
    manifestEntry,
    entries,
    routeKey: matched.routeKey,
    localRouteName: matched.routeKey.includes(".")
      ? matched.routeKey.split(".").pop()!
      : matched.routeKey,
    handlerContext,
    loaderPromises,
    routeMap: deps.getRouteMap(),
    metricsStore,
    Store,
    interceptContextMatch: null,
    interceptSelectorContext: {
      from: cleanUrl,
      to: cleanUrl,
      params: matched.params,
      request,
      env,
      segments: { path: [], ids: [] },
    },
    isSameRouteNavigation: false,
    interceptResult: null,
    cacheScope,
    isIntercept: false,
    actionContext: undefined,
    isAction: false,
    routeMiddleware,
    isFullMatch: true,
  };
}

/**
 * Create match context for partial requests (navigation/actions).
 */
export async function createMatchContextForPartial<TEnv>(
  request: Request,
  env: TEnv,
  deps: MatchApiDeps<TEnv>,
  findInterceptForRoute: MatchApiDeps<TEnv>["findInterceptForRoute"],
  actionContext?: ActionContext,
): Promise<MatchContext<TEnv> | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const metricsStore = deps.getMetricsStore();

  const clientSegmentIds =
    url.searchParams.get("_rsc_segments")?.split(",").filter(Boolean) || [];
  const stale = url.searchParams.get("_rsc_stale") === "true";
  const previousUrl =
    request.headers.get("X-RSC-Router-Client-Path") ||
    request.headers.get("Referer");
  const interceptSourceUrl = request.headers.get(
    "X-RSC-Router-Intercept-Source",
  );

  // HMR: clear manifest cache so stale handler references are discarded
  if (request.headers.get("X-RSC-HMR")) {
    clearManifestCache();
  }

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

  const routeMatchStart = metricsStore ? performance.now() : 0;
  const prevMatch = deps.findMatch(prevUrl.pathname);
  const prevParams = prevMatch?.params || {};
  const interceptContextMatch = interceptSourceUrl
    ? deps.findMatch(interceptContextUrl.pathname)
    : prevMatch;

  const matched = deps.findMatch(pathname, metricsStore);

  if (metricsStore) {
    metricsStore.metrics.push({
      label: "route-matching",
      duration: performance.now() - routeMatchStart,
      startTime: routeMatchStart - metricsStore.requestStart,
    });
  }

  if (!matched) {
    throw new RouteNotFoundError(`No route matched for ${pathname}`, {
      cause: { pathname, method: request.method, previousUrl },
    });
  }

  if (matched.redirectTo) {
    return null;
  }

  if (prevMatch && prevMatch.entry !== matched.entry && !matched.pr) {
    debugLog("matchPartial", "route group changed", {
      from: prevMatch.routeKey,
      to: matched.routeKey,
    });
  }

  const manifestStart = metricsStore ? performance.now() : 0;
  const manifestEntry = await loadManifest(
    matched.entry,
    matched.routeKey,
    pathname,
    metricsStore,
    false,
  );
  if (metricsStore) {
    metricsStore.metrics.push({
      label: "manifest-loading",
      duration: performance.now() - manifestStart,
      startTime: manifestStart - metricsStore.requestStart,
    });
  }

  const routeMiddleware = collectRouteMiddleware(
    traverseBack(manifestEntry),
    matched.params,
  );

  // Clean URL without internal _rsc* params for userland access
  const cleanUrl = stripInternalParams(url);

  const handlerContext = createHandlerContext(
    matched.params,
    request,
    cleanUrl.searchParams,
    pathname,
    cleanUrl,
    env,
    deps.getRouteMap(),
    matched.routeKey,
    matched.responseType,
  );

  const clientSegmentSet = new Set(clientSegmentIds);
  debugLog("matchPartial", "client segments", {
    segments: Array.from(clientSegmentSet),
  });

  const loaderPromises = new Map<string, Promise<any>>();
  setupLoaderAccess(handlerContext, loaderPromises);

  const Store = getContext().getOrCreateStore(matched.routeKey);
  Store.run = <T>(fn: () => T | Promise<T>) =>
    getContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      fn,
    );
  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  const isSameRouteNavigation = !!(
    interceptContextMatch && interceptContextMatch.routeKey === matched.routeKey
  );

  if (interceptSourceUrl) {
    debugLog("matchPartial.intercept", "intercept context detected", {
      currentUrl: pathname,
      interceptSource: interceptSourceUrl,
      contextRoute: interceptContextMatch?.routeKey,
      currentRoute: matched.routeKey,
      sameRouteNavigation: isSameRouteNavigation,
    });
  }

  const localRouteName = matched.routeKey.includes(".")
    ? matched.routeKey.split(".").pop()!
    : matched.routeKey;

  const filteredSegmentIds = clientSegmentIds.filter((id) => {
    if (id.includes(".@")) return false;
    if (/D\d+\./.test(id)) return false;
    return true;
  });
  const effectiveFromUrl = interceptSourceUrl ? interceptContextUrl : prevUrl;
  const interceptSelectorContext: InterceptSelectorContext = {
    from: effectiveFromUrl,
    to: cleanUrl,
    params: matched.params,
    request,
    env,
    segments: {
      path: effectiveFromUrl.pathname.split("/").filter(Boolean),
      ids: filteredSegmentIds,
    },
  };
  const isAction = !!actionContext;

  const clientHasInterceptSegments = [...clientSegmentSet].some((id) =>
    id.includes(".@"),
  );
  const skipInterceptForAction = isAction && !clientHasInterceptSegments;
  const interceptResult =
    isSameRouteNavigation || skipInterceptForAction
      ? null
      : findInterceptForRoute(
          matched.routeKey,
          manifestEntry.parent,
          interceptSelectorContext,
          isAction,
        ) ||
        (localRouteName !== matched.routeKey
          ? findInterceptForRoute(
              localRouteName,
              manifestEntry.parent,
              interceptSelectorContext,
              isAction,
            )
          : null);

  if (
    isSameRouteNavigation &&
    manifestEntry.type === "route" &&
    interceptSourceUrl
  ) {
    debugLog("matchPartial.intercept", "forcing route segment render", {
      segmentId: manifestEntry.shortCode,
    });
    clientSegmentSet.delete(manifestEntry.shortCode);
  }

  const entries = [...traverseBack(manifestEntry)];
  let cacheScope: CacheScope | null = null;
  for (const entry of entries) {
    if (entry.cache) {
      cacheScope = createCacheScope(entry.cache, cacheScope);
    }
  }

  const isIntercept = !!interceptResult;

  return {
    request,
    url: cleanUrl,
    pathname,
    env,
    clientSegmentIds,
    clientSegmentSet,
    stale,
    prevUrl,
    prevParams,
    prevMatch,
    matched,
    manifestEntry,
    entries,
    routeKey: matched.routeKey,
    localRouteName,
    handlerContext,
    loaderPromises,
    routeMap: deps.getRouteMap(),
    metricsStore,
    Store,
    interceptContextMatch,
    interceptSelectorContext,
    isSameRouteNavigation,
    interceptResult,
    cacheScope,
    isIntercept,
    actionContext,
    isAction,
    routeMiddleware,
    isFullMatch: false,
  };
}

/**
 * Match an error to the nearest error boundary and return error segments.
 */
export async function matchError<TEnv>(
  request: Request,
  _context: TEnv,
  error: unknown,
  deps: MatchApiDeps<TEnv>,
  defaultErrorBoundary: ReactNode | ErrorBoundaryHandler | undefined,
  segmentType: ErrorInfo["segmentType"] = "route",
): Promise<MatchResult | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  debugLog("matchError", "matching error", { pathname });

  const matched = deps.findMatch(pathname);
  if (!matched) {
    debugWarn("matchError", "no route matched", { pathname });
    return null;
  }

  const manifestEntry = await loadManifest(
    matched.entry,
    matched.routeKey,
    pathname,
    undefined,
    false,
  );

  const findNearestErrorBoundary = (entry: EntryData | null) =>
    findErrorBoundary(entry, defaultErrorBoundary);

  const fallback = findNearestErrorBoundary(manifestEntry);
  const useDefaultFallback = !fallback;

  const errorInfo = createErrorInfo(
    error,
    manifestEntry.shortCode || "unknown",
    segmentType,
  );

  let entryWithBoundary: EntryData | null = null;
  let current: EntryData | null = manifestEntry;
  while (current) {
    if (current.errorBoundary && current.errorBoundary.length > 0) {
      entryWithBoundary = current;
      break;
    }

    if (current.layout && current.layout.length > 0) {
      for (const orphan of current.layout) {
        if (orphan.errorBoundary && orphan.errorBoundary.length > 0) {
          entryWithBoundary = orphan;
          break;
        }
      }
      if (entryWithBoundary) break;
    }

    current = current.parent;
  }

  let boundaryEntry: EntryData;
  let outletEntry: EntryData;

  if (entryWithBoundary) {
    boundaryEntry = entryWithBoundary;

    outletEntry = manifestEntry;
    current = manifestEntry;

    while (current) {
      if (current.parent === boundaryEntry) {
        outletEntry = current;
        break;
      }

      if (current.parent && current.parent.layout) {
        if (current.parent.layout.includes(boundaryEntry)) {
          outletEntry = current;
          break;
        }
      }

      current = current.parent;
    }
  } else {
    let rootEntry = manifestEntry;
    while (rootEntry.parent) {
      rootEntry = rootEntry.parent;
    }
    boundaryEntry = rootEntry;
    outletEntry = rootEntry;
  }

  const matchedIds: string[] = [];

  current = boundaryEntry;
  const stack: {
    shortCode: string;
    loaderEntries: LoaderEntry[];
  }[] = [];
  while (current) {
    if (current.shortCode) {
      stack.push({
        shortCode: current.shortCode,
        loaderEntries: current.loader || [],
      });
    }
    current = current.parent;
  }
  for (const item of stack.reverse()) {
    matchedIds.push(item.shortCode);
    for (let i = 0; i < item.loaderEntries.length; i++) {
      const loaderId = item.loaderEntries[i].loader?.$$id || "unknown";
      matchedIds.push(`${item.shortCode}D${i}.${loaderId}`);
    }
  }

  const reqCtx = getRequestContext();
  if (reqCtx) {
    reqCtx.setStatus(500);
  }

  const effectiveFallback = fallback || DefaultErrorFallback;
  const errorSegment = createErrorSegment(
    errorInfo,
    effectiveFallback,
    outletEntry,
    matched.params,
  );

  if (useDefaultFallback) {
    debugLog("matchError", "using default error boundary");
  }

  debugLog("matchError", "resolved boundary", {
    boundarySegmentId: boundaryEntry.shortCode,
    outletSegmentId: outletEntry.shortCode,
  });

  return {
    segments: [errorSegment],
    matched: matchedIds,
    diff: [errorSegment.id],
    params: matched.params,
  };
}
