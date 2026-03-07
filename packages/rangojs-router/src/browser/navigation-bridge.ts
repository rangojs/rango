import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptionsInternal,
  ResolvedSegment,
} from "./types.js";
import * as React from "react";
import { startTransition } from "react";
import {
  createNavigationTransaction,
  resolveNavigationState,
} from "./navigation-transaction.js";

// addTransitionType is only available in React experimental
const addTransitionType: ((type: string) => void) | undefined =
  "addTransitionType" in React ? (React as any).addTransitionType : undefined;

import { setupLinkInterception } from "./link-interceptor.js";
import { createPartialUpdater } from "./partial-update.js";
import { generateHistoryKey } from "./navigation-store.js";
import { handleNavigationEnd } from "./scroll-restoration.js";
import type { EventController } from "./event-controller.js";
import { isInterceptOnlyCache } from "./intercept-utils.js";
import {
  toNetworkError,
  emitNetworkError,
  isBackgroundSuppressible,
} from "./network-error-handler.js";
import { debugLog } from "./logging.js";
import { ServerRedirect } from "../errors.js";
import { validateRedirectOrigin } from "./validate-redirect-origin.js";

// Polyfill Symbol.dispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}

/** Get IDs of non-loader segments (layouts, routes, parallels). */
function getNonLoaderSegmentIds(segments: ResolvedSegment[]): string[] {
  return segments.filter((s) => s.type !== "loader").map((s) => s.id);
}

export { createNavigationTransaction };

/**
 * Extended configuration for navigation bridge with event controller
 */
export interface NavigationBridgeConfigWithController extends NavigationBridgeConfig {
  eventController: EventController;
  /** RSC version from initial payload metadata */
  version?: string;
}

/**
 * Create a navigation bridge for handling client-side navigation
 *
 * The bridge coordinates all navigation operations:
 * - Link click interception
 * - Browser back/forward (popstate)
 * - Programmatic navigation
 *
 * Uses the event controller for reactive state management.
 *
 * @param config - Bridge configuration
 * @returns NavigationBridge instance
 */
export function createNavigationBridge(
  config: NavigationBridgeConfigWithController,
): NavigationBridge {
  const { store, client, eventController, onUpdate, renderSegments, version } =
    config;

  // Create shared partial updater
  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
    renderSegments,
    version,
  });

  return {
    /**
     * Navigate to a URL
     * Uses cached segments for SWR revalidation when available
     */
    async navigate(
      url: string,
      options?: NavigateOptionsInternal,
    ): Promise<void> {
      // Resolve LocationStateEntry[] to flat object if needed
      const resolvedState =
        options?.state !== undefined
          ? resolveNavigationState(options.state)
          : undefined;

      // Cross-origin URLs are not handled by SPA navigation.
      // Fall back to a full browser navigation for http/https only.
      let targetUrl: URL;
      try {
        targetUrl = new URL(url, window.location.origin);
      } catch {
        console.warn(`[rango] navigate() ignored: malformed URL "${url}"`);
        return;
      }
      if (targetUrl.origin !== window.location.origin) {
        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
          console.error(
            `[rango] navigate() blocked: unsupported scheme "${targetUrl.protocol}"`,
          );
          return;
        }
        window.location.href = targetUrl.href;
        return;
      }

      // Only abort pending requests when navigating to a different route
      // Same-route navigation (e.g., /todos -> /todos) should not cancel in-flight actions
      const currentPath = new URL(window.location.href).pathname;
      const targetPath = targetUrl.pathname;
      if (currentPath !== targetPath) {
        eventController.abortNavigation();
      }

      // Check if we're "leaving intercept" - navigating from intercept to same URL without intercept
      // This happens when clicking "View Full Details" in an intercept modal
      const currentHistoryState = window.history.state;
      const isCurrentlyIntercept = currentHistoryState?.intercept === true;
      const isSamePathNavigation = currentPath === targetPath;
      const isLeavingIntercept = isCurrentlyIntercept && isSamePathNavigation;

      if (isLeavingIntercept) {
        debugLog(
          "[Browser] Leaving intercept - same URL navigation from intercept",
        );
        // Clear intercept source URL to ensure server doesn't treat this as intercept
        store.setInterceptSourceUrl(null);
      }

      // Before navigating away, update the source page's cache with the latest handleData.
      // This ensures the cache has correct handleData even if handles were streaming.
      const sourceHistoryKey = store.getHistoryKey();
      const sourceCached = store.getCachedSegments(sourceHistoryKey);
      if (sourceCached?.segments && sourceCached.segments.length > 0) {
        const currentHandleData = eventController.getHandleState().data;
        store.cacheSegmentsForHistory(
          sourceHistoryKey,
          sourceCached.segments,
          currentHandleData,
        );
      }

      // Check if we have cached segments for target URL
      const historyKey = generateHistoryKey(url);
      const cached = store.getCachedSegments(historyKey);

      // For shared segments (same ID on current and target), use current page's version
      // since it may have fresher data after an action revalidation.
      // This avoids unnecessary server round-trips for shared layout loaders.
      let cachedSegments = cached?.segments;
      const cachedHandleData = cached?.handleData;
      if (cachedSegments && sourceCached?.segments) {
        const sourceSegmentMap = new Map(
          sourceCached.segments.map((s) => [s.id, s]),
        );
        cachedSegments = cachedSegments.map((targetSeg) => {
          const sourceSeg = sourceSegmentMap.get(targetSeg.id);
          // Use source (current page) version for shared segments - it's fresher
          return sourceSeg || targetSeg;
        });
      }

      // Also check if there's an intercept cache entry for this URL
      // If so, this URL CAN be intercepted, and we shouldn't use the non-intercept cache
      // because the navigation might result in an intercept (depending on source URL)
      const interceptHistoryKey = generateHistoryKey(url, { intercept: true });
      const hasInterceptCache = store.hasHistoryCache(interceptHistoryKey);

      // Skip cached SWR for:
      // 1. intercept caches - interception depends on source page context
      // 2. routes that CAN be intercepted - we don't know if this navigation will intercept
      // 3. when leaving intercept - we need fresh non-intercept segments from server
      // 4. redirect-with-state - force re-render so hooks read fresh state
      const hasUsableCache =
        cachedSegments &&
        cachedSegments.length > 0 &&
        !isInterceptOnlyCache(cachedSegments) &&
        !hasInterceptCache &&
        !isLeavingIntercept &&
        !options?._skipCache;

      using tx = createNavigationTransaction(store, eventController, url, {
        ...options,
        state: resolvedState,
        skipLoadingState: hasUsableCache,
      });

      // REVALIDATE: Fetch fresh data from server
      try {
        await fetchPartialUpdate(
          url,
          hasUsableCache
            ? getNonLoaderSegmentIds(cachedSegments!)
            : options?._skipCache
              ? [] // Action redirect: send no segments so server renders everything fresh
              : undefined,
          false,
          tx.handle.signal,
          tx.with({
            url,
            replace: options?.replace,
            scroll: options?.scroll,
            state: resolvedState,
          }),
          hasUsableCache
            ? {
                type: "navigate" as const,
                targetCacheSegments: cachedSegments,
                targetCacheHandleData: cachedHandleData,
              }
            : isLeavingIntercept
              ? { type: "leave-intercept" as const }
              : undefined,
        );
      } catch (error) {
        // Server-side redirect with location state: the current transaction's
        // `using` cleanup resets loading state. Re-navigate to the redirect
        // target carrying the server-set state into history.pushState.
        if (error instanceof ServerRedirect) {
          const redirectUrl = validateRedirectOrigin(
            error.url,
            window.location.origin,
          );
          if (!redirectUrl) {
            return;
          }
          return this.navigate(redirectUrl, {
            state: error.state,
            replace: options?.replace,
            _skipCache: true,
          } as NavigateOptionsInternal);
        }

        if (error instanceof DOMException && error.name === "AbortError") {
          debugLog("[Browser] Navigation aborted by newer navigation");
          return;
        }

        const networkError = toNetworkError(error, {
          url,
          operation: "navigation",
        });
        if (networkError) {
          console.error(
            "[Browser] Network error during navigation:",
            networkError,
          );
          emitNetworkError(onUpdate, networkError, url);
          return;
        }

        throw error;
      }
    },

    /**
     * Refresh current route
     */
    async refresh(): Promise<void> {
      eventController.abortNavigation();

      using tx = createNavigationTransaction(
        store,
        eventController,
        window.location.href,
        { replace: true },
      );

      try {
        // Refetch with empty segments to get everything fresh
        await fetchPartialUpdate(
          window.location.href,
          [],
          false,
          tx.handle.signal,
          tx.with({ url: window.location.href, replace: true, scroll: false }),
        );
      } catch (error) {
        const networkError = toNetworkError(error, {
          url: window.location.href,
          operation: "revalidation",
        });
        if (networkError) {
          console.error(
            "[Browser] Network error during refresh:",
            networkError,
          );
          emitNetworkError(onUpdate, networkError, window.location.href);
          return;
        }
        throw error;
      }
    },

    /**
     * Handle browser back/forward navigation
     * Uses cached segments when available for instant restoration
     */
    async handlePopstate(): Promise<void> {
      // Abort any pending navigation to prevent race conditions
      eventController.abortNavigation();

      const url = window.location.href;

      // Check if this history entry is an intercept
      const historyState = window.history.state;
      const isIntercept = historyState?.intercept === true;
      const interceptSourceUrl = historyState?.sourceUrl;

      // Check if intercept context is changing (same URL, different intercept state)
      // If so, abort in-flight actions - their results would be for wrong context
      const currentInterceptSource = store.getInterceptSourceUrl();
      const newInterceptSource = interceptSourceUrl ?? null;
      if (currentInterceptSource !== newInterceptSource) {
        debugLog(
          `[Browser] Intercept context changing (${currentInterceptSource} -> ${newInterceptSource}), aborting in-flight actions`,
        );
        eventController.abortAllActions();
      }

      // Compute history key from URL (with intercept suffix if applicable)
      const historyKey = generateHistoryKey(url, { intercept: isIntercept });

      debugLog(
        "[Browser] Popstate -",
        isIntercept ? "intercept" : "normal",
        "key:",
        historyKey,
      );

      // Update location in event controller
      eventController.setLocation(new URL(url));

      // If this is an intercept, restore the intercept context
      if (isIntercept && interceptSourceUrl) {
        store.setInterceptSourceUrl(interceptSourceUrl);
      } else {
        store.setInterceptSourceUrl(null);
      }

      // Helper to check if streaming is in progress
      const isStreaming = () => eventController.getState().isStreaming;

      // Check if we can restore from history cache
      const cached = store.getCachedSegments(historyKey);
      const cachedSegments = cached?.segments;
      const cachedHandleData = cached?.handleData;
      const isStale = cached?.stale ?? false;

      if (cachedSegments && cachedSegments.length > 0) {
        // Update store to point to this history entry
        store.setHistoryKey(historyKey);
        store.setSegmentIds(cachedSegments.map((s) => s.id));
        store.setCurrentUrl(url);
        store.setPath(new URL(url).pathname);

        // Render from cache - force await to skip loading fallbacks
        try {
          const root = await renderSegments(cachedSegments, {
            forceAwait: true,
          });
          // Merge params from cached segments for useParams restoration.
          // Set params on event controller before onUpdate so both location
          // and params are current when the debounced notify() fires.
          const cachedParams: Record<string, string> = {};
          for (const s of cachedSegments) {
            if (s.params) Object.assign(cachedParams, s.params);
          }
          eventController.setParams(cachedParams);

          const popstateUpdate = {
            root,
            metadata: {
              pathname: new URL(url).pathname,
              segments: cachedSegments,
              isPartial: true,
              matched: cachedSegments.map((s) => s.id),
              diff: [],
              cachedHandleData,
              params: cachedParams,
            },
          };
          const hasTransition = cachedSegments.some((s) => s.transition);
          if (hasTransition) {
            startTransition(() => {
              if (addTransitionType) {
                addTransitionType("navigation-back");
              }
              onUpdate(popstateUpdate);
            });
          } else {
            onUpdate(popstateUpdate);
          }

          // Restore scroll position for back/forward navigation
          handleNavigationEnd({ restore: true, isStreaming });

          // SWR: If stale, trigger background revalidation
          if (isStale) {
            debugLog("[Browser] Cache is stale, background revalidating...");
            // Background revalidation - don't await, just fire and forget
            const segmentIds = getNonLoaderSegmentIds(cachedSegments);

            const tx = createNavigationTransaction(
              store,
              eventController,
              url,
              { skipLoadingState: true, replace: true },
            );

            fetchPartialUpdate(
              url,
              segmentIds,
              false,
              tx.handle.signal,
              tx.with({
                url,
                replace: true,
                scroll: false,
                intercept: isIntercept,
                interceptSourceUrl,
                cacheOnly: true,
              }),
              { type: "stale-revalidation", interceptSourceUrl },
            )
              .catch((error) => {
                if (isBackgroundSuppressible(error)) return;
                console.error(
                  "[Browser] Background revalidation failed:",
                  error,
                );
              })
              .finally(() => {
                tx[Symbol.dispose]();
              });
          }
          return;
        } catch (error) {
          console.warn(
            "[Browser] Failed to render from cache, fetching:",
            error,
          );
          // Fall through to fetch
        }
      } else {
        debugLog("[Browser] History cache miss for key:", historyKey);
      }

      // Fetch if not cached
      using tx = createNavigationTransaction(store, eventController, url, {
        replace: true,
      });

      try {
        await fetchPartialUpdate(
          url,
          undefined,
          false,
          tx.handle.signal,
          tx.with({ url, replace: true, scroll: false }),
        );
        // Restore scroll position after fetch completes
        handleNavigationEnd({ restore: true, isStreaming });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          debugLog("[Browser] Popstate navigation aborted");
          return;
        }

        const networkError = toNetworkError(error, {
          url,
          operation: "navigation",
        });
        if (networkError) {
          console.error(
            "[Browser] Network error during popstate:",
            networkError,
          );
          emitNetworkError(onUpdate, networkError, url);
          return;
        }

        throw error;
      }
    },

    /**
     * Register link interception
     * @returns Cleanup function
     */
    registerLinkInterception(): () => void {
      const cleanupLinks = setupLinkInterception((url, options) => {
        this.navigate(url, options);
      });

      const handlePopstate = () => {
        this.handlePopstate();
      };

      // When the browser restores a page from bfcache (back-forward cache),
      // any in-flight navigation state is stale. This happens when:
      // 1. A navigation triggers X-RSC-Reload (e.g., response route hit via SPA)
      // 2. window.location.href does a hard navigation
      // 3. The user presses back and the browser restores from bfcache
      // At that point, currentNavigation is still set from step 1, so
      // getState() returns "loading" and the progress bar shows.
      // Abort the stale navigation to reset state to idle.
      const handlePageShow = (event: PageTransitionEvent) => {
        if (event.persisted) {
          debugLog(
            "[Browser] Page restored from bfcache, resetting navigation state",
          );
          eventController.abortNavigation();
        }
      };

      // Register cross-tab refresh callback with the store
      store.setCrossTabRefreshCallback(() => {
        this.refresh();
      });

      window.addEventListener("popstate", handlePopstate);
      window.addEventListener("pageshow", handlePageShow);
      debugLog("[Browser] Navigation bridge ready");

      return () => {
        cleanupLinks();
        window.removeEventListener("popstate", handlePopstate);
        window.removeEventListener("pageshow", handlePageShow);
      };
    },
  };
}

export { createNavigationBridge as default };
