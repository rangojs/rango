import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptionsInternal,
  ResolvedSegment,
} from "./types.js";
import { setAppVersion } from "./app-version.js";
import * as React from "react";
import { startTransition } from "react";
import {
  createNavigationTransaction,
  resolveNavigationState,
} from "./navigation-transaction.js";
import { buildHistoryState, pushHistoryWithIdx } from "./history-state.js";
import {
  handleNavigationStart,
  handleNavigationEnd,
  ensureHistoryKey,
} from "./scroll-restoration.js";

// addTransitionType is only available in React experimental
const addTransitionType: ((type: string) => void) | undefined =
  "addTransitionType" in React ? (React as any).addTransitionType : undefined;

import { setupLinkInterception } from "./link-interceptor.js";
import { createPartialUpdater } from "./partial-update.js";
import { generateHistoryKey } from "./navigation-store.js";
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

export { createNavigationTransaction };

/**
 * Extended configuration for navigation bridge with event controller
 */
export interface NavigationBridgeConfigWithController extends NavigationBridgeConfig {
  eventController: EventController;
  /** RSC version from initial payload metadata. */
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
  const { store, client, eventController, onUpdate, renderSegments } = config;
  let version = config.version;

  // Create shared partial updater
  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
    renderSegments,
    getVersion: () => version,
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

      // Shallow navigation: skip RSC fetch when revalidate is false
      // and the pathname hasn't changed (search param / hash only change).
      if (
        options?.revalidate === false &&
        targetUrl.pathname === new URL(window.location.href).pathname
      ) {
        // Preserve intercept context from the current history entry so that
        // popstate uses the correct cache key (:intercept suffix) and restores
        // the right full-page vs modal semantics.
        const currentHistoryState = window.history.state;
        const isIntercept = currentHistoryState?.intercept === true;
        const interceptSourceUrl = isIntercept
          ? currentHistoryState?.sourceUrl
          : undefined;

        const historyKey = generateHistoryKey(url, { intercept: isIntercept });

        // Copy current segments to the new history key so back/forward restores instantly
        const currentKey = store.getHistoryKey();
        const currentCache = store.getCachedSegments(currentKey);
        if (currentCache?.segments) {
          const currentHandleData = eventController.getHandleState().data;
          store.cacheSegmentsForHistory(
            historyKey,
            currentCache.segments,
            currentHandleData,
          );
        }

        // Save current scroll position before changing URL
        handleNavigationStart();

        // Snapshot old state before pushState/replaceState overwrites it
        const oldState = window.history.state;

        // Update browser URL (carry intercept context into history state)
        const historyState = buildHistoryState(
          resolvedState,
          {
            intercept: isIntercept || undefined,
            sourceUrl: interceptSourceUrl,
          },
          {},
        );
        pushHistoryWithIdx(historyState, url, options?.replace ?? false);

        // Ensure new history entry has a scroll restoration key
        ensureHistoryKey();

        // Notify useLocationState() hooks when state changes
        const hasOldState =
          oldState &&
          typeof oldState === "object" &&
          ("state" in oldState ||
            Object.keys(oldState).some((k) => k.startsWith("__rsc_ls_")));
        const hasNewState =
          historyState &&
          ("state" in historyState ||
            Object.keys(historyState).some((k) => k.startsWith("__rsc_ls_")));
        if (hasOldState || hasNewState) {
          window.dispatchEvent(new Event("__rsc_locationstate"));
        }

        // Update store history key so future navigations reference the right cache
        store.setHistoryKey(historyKey);
        store.setCurrentUrl(url);

        // Notify hooks — location updates, state stays idle
        eventController.setLocation(targetUrl);

        // Handle post-navigation scroll
        handleNavigationEnd({ scroll: options.scroll });
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
      // 5. stale cache - server action invalidated it, need fresh data with loading state
      const hasUsableCache =
        cachedSegments &&
        cachedSegments.length > 0 &&
        !isInterceptOnlyCache(cachedSegments) &&
        !hasInterceptCache &&
        !isLeavingIntercept &&
        !cached?.stale &&
        !options?._skipCache;

      // Forward navigations always await fetchPartialUpdate before rendering,
      // so useNavigation should always report "loading". skipLoadingState is
      // only used for popstate background revalidation (line ~526) where
      // cached content renders instantly without a network wait.
      const tx = createNavigationTransaction(store, eventController, url, {
        ...options,
        state: resolvedState,
        skipLoadingState: false,
      });

      // REVALIDATE: Fetch fresh data from server
      try {
        await fetchPartialUpdate(
          url,
          hasUsableCache
            ? cachedSegments!.map((s) => s.id)
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
        // cleanup resets loading state. Re-navigate to the redirect
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
      } finally {
        tx[Symbol.dispose]();
      }
    },

    /**
     * Refresh current route
     */
    async refresh(): Promise<void> {
      eventController.abortNavigation();

      const tx = createNavigationTransaction(
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
      } finally {
        tx[Symbol.dispose]();
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

      // Popstate that exits an intercept to a non-intercept destination. The
      // fallback fetch path below needs `leave-intercept` mode so it filters
      // the cached @modal segment from the request and forces a re-render —
      // otherwise a cache-miss popstate whose server response has an empty
      // diff hits the "no changes" branch in partial-update and the modal
      // stays on screen.
      const isLeavingIntercept =
        !isIntercept && currentInterceptSource !== null;

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

        // Restore router identity from cache so subsequent navigations
        // don't falsely detect an app switch.
        if (cached?.routerId) {
          store.setRouterId?.(cached.routerId);
        }

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
            scroll: { restore: true, isStreaming },
          };
          // Intercept-driven popstate (entering OR leaving an intercept) only
          // mutates the parallel slot; the main outlet shows the same content.
          // Skip startViewTransition in those cases — same rationale as the
          // intercept guard in partial-update.ts's hasTransition computation.
          const hasTransition =
            !isIntercept &&
            !isLeavingIntercept &&
            cachedSegments.some((s) => s.transition);
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

          // SWR: If stale, trigger background revalidation
          if (isStale) {
            debugLog("[Browser] Cache is stale, background revalidating...");
            // Background revalidation - don't await, just fire and forget
            const segmentIds = cachedSegments.map((s) => s.id);

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
      const tx = createNavigationTransaction(store, eventController, url, {
        replace: true,
      });

      try {
        await fetchPartialUpdate(
          url,
          undefined,
          false,
          tx.handle.signal,
          tx.with({
            url,
            replace: true,
            scroll: false,
            intercept: isIntercept,
            interceptSourceUrl,
          }),
          isIntercept
            ? { type: "navigate", interceptSourceUrl }
            : isLeavingIntercept
              ? { type: "leave-intercept" }
              : undefined,
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
      } finally {
        tx[Symbol.dispose]();
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
          // pagehide flips scrollRestoration to "auto" for bfcache compat;
          // restore "manual" so the router controls scroll on SPA navigations.
          window.history.scrollRestoration = "manual";
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

    getVersion(): string | undefined {
      return version;
    },

    updateVersion(newVersion: string): void {
      version = newVersion;
      setAppVersion(newVersion);
      store.clearHistoryCache();
    },
  };
}

export { createNavigationBridge as default };
