"use client";

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  use,
  type ReactNode,
} from "react";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "./context.js";
import type {
  NavigationStore,
  NavigationUpdate,
  NavigateOptions,
  NavigationBridge,
} from "../types.js";
import type { EventController } from "../event-controller.js";
import { RootErrorBoundary } from "../../root-error-boundary.js";
import type { HandleData } from "../types.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { NonceContext } from "./nonce-context.js";
import type { ResolvedThemeConfig, Theme } from "../../theme/types.js";
import { cancelAllPrefetches } from "../prefetch/queue.js";
import { handleNavigationEnd } from "../scroll-restoration.js";
import { createAppShellRef, type AppShellRef } from "../app-shell.js";
import { startConnectionWarmup } from "../connection-warmup.js";
import { debugLog } from "../logging.js";
import { isThenable } from "../../handles/is-thenable.js";

/** True when any handle value in this snapshot is a deferred (Promise) value. */
function hasDeferredHandleValue(data: HandleData): boolean {
  for (const segments of Object.values(data)) {
    for (const values of Object.values(segments)) {
      if (values.some(isThenable)) return true;
    }
  }
  return false;
}

/** Snapshot with deferred (Promise) values awaited; a rejected deferred is
 *  dropped (it contributes nothing), mirroring the render-side REJECTED_META.
 *  Promise.allSettled treats non-promise values as already-fulfilled, so plain
 *  values pass through unchanged. */
async function resolveDeferredHandleValues(
  data: HandleData,
): Promise<HandleData> {
  const out: HandleData = {};
  await Promise.all(
    Object.entries(data).flatMap(([handleName, segments]) => {
      out[handleName] = {};
      return Object.entries(segments).map(async ([segmentId, values]) => {
        const settled = await Promise.allSettled(values);
        out[handleName][segmentId] = settled
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<unknown>).value);
      });
    }),
  );
  return out;
}

/**
 * Process handles from an async generator, updating the event controller
 * and cache as data streams in.
 *
 * This handles:
 * 1. Consuming the async generator and calling setHandleData on each yield
 * 2. Stopping early if user navigates away (historyKey changes)
 * 3. Cleaning up stale data when generator yields nothing
 * 4. Updating the cache after processing completes (if still on same page)
 */
async function processHandles(
  handlesGenerator: AsyncGenerator<HandleData>,
  opts: {
    eventController: EventController;
    store: NavigationStore;
    matched?: string[];
    isPartial?: boolean;
    /** Server's `resolvedIds`: every segment re-resolved this request,
     *  including null-component ones excluded from `diff`/`segments`.
     *  Drives cleanup of stale handle buckets when a re-resolved segment
     *  pushed nothing. */
    resolvedIds?: string[];
    historyKey: string;
  },
): Promise<void> {
  const {
    eventController,
    store,
    matched,
    isPartial,
    resolvedIds,
    historyKey,
  } = opts;

  let yieldCount = 0;
  for await (const handleData of handlesGenerator) {
    // Check if user navigated away before each update.
    // This prevents handle data from cancelled navigations polluting
    // the current route's breadcrumbs (e.g., quick popstate after clicking a link).
    if (historyKey !== store.getHistoryKey()) {
      debugLog(
        "[NavigationProvider] Stopping handle processing - user navigated away",
      );
      return;
    }

    yieldCount++;

    if (!hasDeferredHandleValue(handleData)) {
      eventController.setHandleData(
        handleData,
        matched,
        isPartial,
        resolvedIds,
      );
      continue;
    }

    // A handle value can be a deferred Promise (e.g.
    // ctx.use(Meta)(data.then(v => ({ title: v.t })))). Resolving it on the
    // client here — instead of letting the consumer use() it — keeps the
    // consumer (useHandle/MetaTags) dumb: it only ever sees resolved values, so
    // it never suspends mid-navigation. MetaTags lives in <head>, above the
    // route's <Suspense>, so an uncontained suspension there would revert the
    // just-committed route and hide its loading fallback.
    //
    // Keep the PREVIOUS handle data on screen (stale-while-revalidate) until the
    // resolved snapshot is ready, then swap it in atomically. Do NOT apply a
    // stripped snapshot first: that would blank a title/meta whose only value is
    // deferred for the whole resolution window. Skip if the user navigated away.
    //
    // Order-safety: each stream yield is a full cumulative snapshot, and a
    // segment's handle array is atomic (handlers push synchronously, batched by
    // handle-store stream()), so concurrent resolutions of different yields write
    // identical per-segment arrays or touch disjoint segments — neither can clobber
    // the other (setHandleData replaces per segment, never the whole store).
    void resolveDeferredHandleValues(handleData).then((resolved) => {
      if (historyKey !== store.getHistoryKey()) return; // navigated away
      eventController.setHandleData(resolved, matched, isPartial, resolvedIds);
      store.updateCacheHandleData(
        historyKey,
        eventController.getHandleState().data,
      );
    });
  }

  // Check again before final updates
  if (historyKey !== store.getHistoryKey()) {
    return;
  }

  // For partial updates where the generator yielded nothing (every
  // re-resolved handler pushed nothing), still call setHandleData so the
  // cleanup pass can clear out stale buckets for those segments.
  if (yieldCount === 0 && matched) {
    eventController.setHandleData({}, matched, true, resolvedIds);
  }

  // After handles processing completes, update the cache's handleData.
  // This fixes a race condition where commit() caches stale handleData before
  // the async handles processing completes.
  // Only update if we're still on the same page (historyKey matches).
  if (historyKey === store.getHistoryKey()) {
    const finalHandleData = eventController.getHandleState().data;
    store.updateCacheHandleData(historyKey, finalHandleData);
  }
}

/**
 * Props for NavigationProvider
 */
export interface NavigationProviderProps {
  /**
   * Navigation store instance (for cache/segment management)
   */
  store: NavigationStore;

  /**
   * Event controller instance (for navigation/action state)
   */
  eventController: EventController;

  /**
   * Initial rendered tree + metadata from server payload
   */
  initialPayload: NavigationUpdate;

  /**
   * Navigation bridge for handling navigation
   */
  bridge: NavigationBridge;

  /**
   * Theme configuration (null if theme not enabled)
   * When provided, wraps content in ThemeProvider
   */
  themeConfig?: ResolvedThemeConfig | null;

  /**
   * Initial theme from server (from cookie)
   * Only used when themeConfig is provided
   */
  initialTheme?: Theme;

  /**
   * Whether connection warmup is enabled.
   * When true, keeps TLS alive by sending HEAD requests after idle periods.
   */
  warmupEnabled?: boolean;

  /**
   * App version from server payload.
   * Used only as a fallback when `appShellRef` is not supplied.
   */
  version?: string;

  /**
   * URL prefix for all routes (from createRouter({ basename })).
   * Used only as a fallback when `appShellRef` is not supplied.
   */
  basename?: string;

  /**
   * App-shell ref. When provided, the context's `basename` and `version` are
   * read through it (live getters) so they don't close over a stale snapshot or
   * invalidate the memoized context value. The shell is set once at init and is
   * not swapped within a session — a cross-app navigation is a full document
   * load (X-RSC-Reload), so the target app establishes its own shell on load.
   */
  appShellRef?: AppShellRef;

  /**
   * CSP nonce to expose via NonceContext. Production leaves this undefined — the
   * browser has no nonce (it is a server-side HTML concern), and SSR provides the
   * nonce through its own NonceContext.Provider. Test harnesses (renderRoute) set
   * it to seed a nonce so components calling useNonce() can be exercised.
   */
  nonce?: string;
}

/**
 * Navigation provider component
 *
 * Provides navigation context to the component tree and handles:
 * - Providing stable store and event controller references (never re-renders consumers)
 * - Subscribing to UI updates to re-render the tree
 * - Providing navigate/refresh methods (delegated to bridge)
 *
 * State subscriptions happen via useNavigation hook (via event controller), not via context.
 * This means context consumers don't re-render on state changes.
 *
 * @example
 * ```tsx
 * <NavigationProvider
 *   store={store}
 *   eventController={eventController}
 *   initialPayload={payload}
 *   bridge={navigationBridge}
 * />
 * ```
 */
export function NavigationProvider({
  store,
  eventController,
  initialPayload,
  bridge,
  themeConfig,
  initialTheme,
  warmupEnabled,
  version,
  basename,
  appShellRef,
  nonce,
}: NavigationProviderProps): ReactNode {
  // Track current payload for rendering (this triggers re-renders)
  const [payload, setPayload] = useState(initialPayload);

  /**
   * Navigate to a URL (delegates to bridge)
   */
  const navigate = useCallback(
    async (url: string, options?: NavigateOptions): Promise<void> => {
      await bridge.navigate(url, options);
    },
    [],
  );

  /**
   * Refresh current route (delegates to bridge)
   */
  const refresh = useCallback(async (): Promise<void> => {
    await bridge.refresh();
  }, []);

  // basename/version are always read through a shell ref so the context value
  // has a single shape. Both are set once: a supplied appShellRef is seeded
  // from the init payload (a cross-app navigation reloads, so it is not swapped
  // in-session), and the standalone fallback wraps the mount-time props.
  const fallbackShellRef = useRef<AppShellRef | null>(null);
  if (!fallbackShellRef.current) {
    fallbackShellRef.current = createAppShellRef({ basename, version });
  }
  const shellRef = appShellRef ?? fallbackShellRef.current;

  const contextValue = useMemo<NavigationStoreContextValue>(() => {
    const value = {
      store,
      eventController,
      navigate,
      refresh,
    } as NavigationStoreContextValue;
    Object.defineProperty(value, "basename", {
      configurable: true,
      enumerable: true,
      get: () => shellRef.get().basename,
    });
    Object.defineProperty(value, "version", {
      configurable: true,
      enumerable: true,
      get: () => shellRef.get().version,
    });
    return value;
  }, []);

  // Connection warmup: keep TLS alive after idle periods. After 60s of no
  // interaction the connection is marked cold; the next pointer/touch
  // interaction or visibility change warms TLS via a HEAD request before the
  // user clicks a link. State machine lives in connection-warmup.ts.
  useEffect(() => {
    if (!warmupEnabled) return;
    return startConnectionWarmup();
  }, [warmupEnabled]);

  // Cancel non-matching prefetches when navigation starts.
  // Frees connections so the navigation fetch isn't competing with
  // speculative prefetches. The prefetch matching the navigation target
  // is kept alive so it can be reused via consumeInflightPrefetch.
  useEffect(() => {
    let wasIdle = true;
    const unsub = eventController.subscribe(() => {
      const state = eventController.getState();
      const isIdle = state.state === "idle" && !state.isStreaming;
      if (wasIdle && !isIdle) {
        cancelAllPrefetches(state.pendingUrl);
      }
      wasIdle = isIdle;
    });
    return unsub;
  }, [eventController]);

  // Pending scroll action to apply after React commits
  const pendingScrollRef = useRef<NavigationUpdate["scroll"]>(undefined);

  // Apply scroll after React commits the new content to the DOM
  useLayoutEffect(() => {
    const scrollAction = pendingScrollRef.current;
    if (!scrollAction) return;
    pendingScrollRef.current = undefined;

    if (scrollAction.enabled === false) return;

    handleNavigationEnd({
      restore: scrollAction.restore,
      scroll: scrollAction.enabled,
      isStreaming: scrollAction.isStreaming,
    });
  });

  // Subscribe to UI updates (for re-rendering the tree)
  useEffect(() => {
    const unsubscribe = store.onUpdate((update) => {
      // Capture scroll intent — it will be applied in useLayoutEffect
      // after React commits this state update to the DOM.
      // Always assign (even undefined) to clear stale scroll from prior navigations,
      // so server actions or error updates don't accidentally replay old scroll.
      pendingScrollRef.current = update.scroll;

      setPayload({
        root: update.root,
        metadata: update.metadata,
      });

      // Update route params. Only reset when the server actually sends a params
      // map — an absent `params` field means "no change" (e.g., legacy action
      // responses that omitted params). Explicit `{}` still clears correctly.
      if (update.metadata.params !== undefined) {
        eventController.setParams(update.metadata.params);
      }

      // Update handle data progressively as it streams in
      if (update.metadata.handles) {
        // Capture historyKey now - by the time async processing completes,
        // the user might have navigated elsewhere
        const historyKey = store.getHistoryKey();

        processHandles(update.metadata.handles, {
          eventController,
          store,
          matched: update.metadata.matched,
          isPartial: update.metadata.isPartial,
          resolvedIds: update.metadata.resolvedIds,
          historyKey,
        }).catch((err) =>
          console.error("[NavigationProvider] Error consuming handles:", err),
        );
      } else if (update.metadata.matched) {
        // cachedHandleData present -> full restore (back/forward); absent ->
        // partial cleanup of segments no longer matched.
        const cached = update.metadata.cachedHandleData;
        eventController.setHandleData(
          cached ?? {},
          update.metadata.matched,
          cached === undefined,
          cached === undefined ? update.metadata.resolvedIds : undefined,
        );
      }
    });

    return unsubscribe;
  }, []);

  // Handle promise case - use() will suspend until resolved
  const root =
    payload.root instanceof Promise ? use(payload.root) : payload.root;

  // Wrap content in RootErrorBoundary to catch:
  // 1. Errors from RenderErrorThrower (network failures and unprocessable
  //    navigation responses, routed here by the navigation bridge)
  // 2. Client component errors that occur before/outside the segment tree's error boundary
  // 3. Errors during promise resolution or navigation state updates
  // This acts as a safety net - the segment tree has its own RootErrorBoundary that
  // catches most errors, but this outer boundary catches anything that slips through.

  // Build the content tree
  let content = <RootErrorBoundary>{root}</RootErrorBoundary>;

  // Wrap with ThemeProvider when theme is enabled. The ThemeProvider is
  // document-lifetime: its config comes from the initial load and persists for
  // the session. It sits above the segment tree and is not remounted in-session;
  // a cross-app navigation is a full document load (X-RSC-Reload), so the target
  // app's theme config takes effect on its own load.
  if (themeConfig) {
    content = (
      <ThemeProvider config={themeConfig} initialTheme={initialTheme}>
        {content}
      </ThemeProvider>
    );
  }

  // Match SSR tree shape: NonceContext.Provider is always present so
  // hydration sees the same component tree. Value is undefined on the
  // client — CSP nonces are a server-side HTML concern — unless a test
  // harness seeded one via the `nonce` prop.
  content = (
    <NonceContext.Provider value={nonce}>{content}</NonceContext.Provider>
  );

  return (
    <NavigationStoreContext.Provider value={contextValue}>
      {content}
    </NavigationStoreContext.Provider>
  );
}
