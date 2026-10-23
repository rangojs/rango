"use client";

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  use,
  startTransition,
  type ReactNode,
} from "react";
import {
  HydrationBarrierContext,
  LocationStateContext,
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "./context.js";
import type {
  NavigationStore,
  NavigationUpdate,
  NavigateOptionsInternal,
  NavigationBridge,
  RscMetadata,
} from "../types.js";
import type { EventController } from "../event-controller.js";
import { RootErrorBoundary } from "../../root-error-boundary.js";
import type { HandleData } from "../types.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { NonceContext } from "./nonce-context.js";
import type { ResolvedThemeConfig, Theme } from "../../theme/types.js";
import { cancelAllPrefetches } from "../prefetch/loader.js";
import { handleNavigationEnd } from "../scroll-restoration.js";
import { createAppShellRef, type AppShellRef } from "../app-shell.js";
import { startConnectionWarmup } from "../connection-warmup.js";
import { debugLog } from "../logging.js";
import { cloneHandleData } from "../navigation-store.js";
import {
  deferredHandleNames,
  resolveDeferredHandleValues,
} from "../../handles/deferred-resolution.js";
import { auditTreeUpdate } from "../../suspense-audit.js";

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

  // This nav's instance token, captured before any await — processHandles runs
  // right after its own commit, so this is that commit's token. generateHistoryKey
  // is the URL (plus the source page for an intercept), so an A->B->A revisit
  // reuses the key; the token lets a late
  // resolution tell its own visit apart from a newer same-URL visit, so a stale
  // nav can never clobber a fresher one's live state or cache (P1).
  const myInstance = store.getNavInstance();

  // True while this nav still owns the live page: same history key AND the most
  // recent commit is still ours (no newer nav has committed since).
  const stillLive = (): boolean =>
    historyKey === store.getHistoryKey() &&
    myInstance === store.getNavInstance();

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

    // Resolve-by-default: hold the previous resolved value until this yield's
    // deferred (Promise) handle values settle, then apply the fully-resolved
    // snapshot. The hold needs NO extra state — we simply do not touch the store
    // until the values resolve, so useHandle keeps reading (and showing) the
    // previous data. A yield with no deferred value applies synchronously.
    const hasDeferred = deferredHandleNames(handleData).size > 0;

    if (!hasDeferred) {
      eventController.setHandleData(
        handleData,
        matched,
        isPartial,
        resolvedIds,
      );
      // Keep the cache fresh. The token guard stops a stale same-URL nav writing
      // a newer entry; the owned-write folds probe + write into one scan.
      store.updateCacheHandleDataIfOwned(
        historyKey,
        eventController.getHandleState().data,
        myInstance,
        false,
      );
      continue;
    }

    // The PREVIOUS (held) snapshot — captured before the await so the cache and
    // the navigate-away merge below reflect what useHandle is still showing.
    const previousSnapshot = cloneHandleData(
      eventController.getHandleState().data,
    );

    // The route HAS changed even though the handle data is held, so update
    // `routeSegmentIds` (what useSegments reads) now. This leaves `data` /
    // `segmentOrder` (what useHandle collects over) untouched, so useHandle keeps
    // holding its previous value while useSegments reflects the new route.
    eventController.setRouteSegmentIds(matched ?? []);

    // Deferred-pending: the new values are not applied yet (the previous value is
    // held), so the cache entry must NOT be served as fresh on a popstate return.
    // Mark it STALE + handlesPending (token-guarded), storing the PREVIOUS (held)
    // snapshot. P1 fix: a deferred value is a SERVER-side promise streamed via
    // Flight, so a navigate-away ABORTS the stream and the resolve below never
    // settles. stale makes a popstate return revalidate; handlesPending makes that
    // revalidation a FULL re-render (no client segment IDs) so the server
    // re-streams the handles — a diff-only revalidation would omit the unchanged
    // segments' handles and the deferred value would never land (see the
    // segmentIds branch in navigation-bridge.ts).
    store.updateCacheHandleDataIfOwned(
      historyKey,
      previousSnapshot,
      myInstance,
      true,
      true,
    );

    // Resolve every deferred value (allSettled; rejected + nullish dropped, sync
    // values pass through). Each stream yield is a full cumulative snapshot.
    const resolved = await resolveDeferredHandleValues(handleData);

    if (!stillLive()) {
      // Navigated away (or a same-URL nav superseded us) while resolving. We do
      // NOT write `resolved` into the entry. It is THIS yield's snapshot only (on a
      // partial nav, just the re-resolved segments' buckets), and a correct write
      // needs setHandleData's nested per-segment merge + matched/resolvedIds
      // cleanup: HandleData is handleName -> segmentId -> entries[], so a
      // handle-name-level spread would drop a shared layout bucket (e.g. a
      // Breadcrumbs layout crumb under L0 when the route pushed under R0) and would
      // mark stale previous-route buckets fresh. We cannot run that merge here
      // without touching the now-different live page. Instead leave the entry as it
      // was marked before the await — stale + handlesPending — so a popstate return
      // revalidates with a full re-render and re-streams the handles. A newer nav
      // owning the entry has already overwritten it; nothing to do either way.
      continue;
    }

    // Still live: apply the fully-resolved snapshot and refresh the cache fresh.
    eventController.setHandleData(resolved, matched, isPartial, resolvedIds);
    store.updateCacheHandleDataIfOwned(
      historyKey,
      eventController.getHandleState().data,
      myInstance,
      false,
      false,
    );
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
  // Only update if we're still on the same page AND this is still the live nav
  // (the token guard stops a stale same-URL nav writing a newer nav's state).
  if (stillLive()) {
    const finalHandleData = eventController.getHandleState().data;
    store.updateCacheHandleData(historyKey, finalHandleData);
  }
}

/**
 * Read the handle stream of `metadata` into the event controller and the
 * entry on screen. The provider's own call for every payload it is handed,
 * and the one write for a response that hands React nothing (a fill,
 * browser/partial-update.ts fillHoles).
 */
export function consumeHandles(
  metadata: RscMetadata,
  eventController: EventController,
  store: NavigationStore,
): void {
  processHandles(metadata.handles!, {
    eventController,
    store,
    matched: metadata.matched,
    isPartial: metadata.isPartial,
    resolvedIds: metadata.resolvedIds,
    // Now: by the time the stream ends the user may be elsewhere.
    historyKey: store.getHistoryKey(),
  }).catch((err) =>
    console.error("[NavigationProvider] Error consuming handles:", err),
  );
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

  /**
   * The document this provider hydrates (initBrowserApp; renderRoute with
   * `hydrate: true`), whose store EventController.lockHydration locked.
   * `settled` resolves once the stream has ended and React has revealed every
   * boundary. Then a transition changes HydrationBarrierContext alone, and
   * React commits it once every boundary has hydrated, one still suspended on
   * the client (a lazy chunk, a deferred-hydration gate) included. Until that
   * commit location state is `undefined`, as SSR rendered it, through any
   * commit no payload follows (a shallow navigation), and the store is
   * locked; after it the entry's state lands in a transition of its own
   * and the store is released (handle data lands in that release
   * notification). A navigation committed earlier releases the store before
   * its update, for the whole hold when the navigation is held: an old-page
   * boundary hydrating meanwhile reads the destination's values and can
   * mismatch.
   * Absent for a provider mounted on the client.
   */
  hydration?: { settled: Promise<void> };
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
  hydration,
}: NavigationProviderProps): ReactNode {
  // Track current payload for rendering (this triggers re-renders)
  const [payload, setPayload] = useState(initialPayload);
  // The location state of the entry `payload` renders (LocationStateContext).
  // Only ever set next to setPayload, or for a commit that has no payload.
  const [locationState, setLocationState] = useState(() =>
    hydration ? undefined : eventController.getLocationState(),
  );
  // HydrationBarrierContext's value; see NavigationProviderProps.hydration.
  const [hydrationBarrier, setHydrationBarrier] = useState(0);
  const hydrationOpen = useRef(hydration !== undefined);

  /**
   * Navigate to a URL (delegates to bridge)
   */
  const navigate = useCallback(
    async (url: string, options?: NavigateOptionsInternal): Promise<void> => {
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

  // Fixed for the document: read once on mount.
  const [origin] = useState(
    () => (eventController.getState().location as URL | undefined)?.origin,
  );

  const contextValue = useMemo<NavigationStoreContextValue>(() => {
    const value = {
      store,
      eventController,
      navigate,
      refresh,
      defaultPrefetch: initialPayload.metadata.defaultPrefetch,
      origin,
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

  // The document has been revealed. The barrier must be the only update in
  // its transition lane: then React holds the commit until every boundary
  // still dehydrated beneath it has hydrated. Any other update in the lane
  // (location state in its own startTransition here included) can let React
  // commit around a boundary still suspended on the client. Why:
  // docs/internal/execution-model.md, "The reveal barrier is alone in its lane".
  useEffect(() => {
    if (!hydration) return;
    let cancelled = false;
    void hydration.settled.then(() => {
      if (cancelled || !hydrationOpen.current) return;
      startTransition(() => setHydrationBarrier((n) => n + 1));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // After the barrier's commit no boundary under this provider is dehydrated:
  // the entry's location state lands in a transition of its own, and the
  // store is released so its handle writes reach their readers. A navigation
  // that committed first has done both (store onUpdate below).
  useEffect(() => {
    if (hydrationBarrier === 0 || !hydrationOpen.current) return;
    hydrationOpen.current = false;
    startTransition(() => setLocationState(eventController.getLocationState()));
    eventController.releaseHydrationLock();
  }, [hydrationBarrier]);

  // A commit no payload follows (a shallow navigation, a commit that keeps
  // every segment, merged server-set state): the tree on screen is already
  // the entry's, so its state is taken with the commit's notification. Not
  // while the hydration window is open: a boundary of the document may still
  // be dehydrated, an update a reader outside it takes commits around it, and
  // it then hydrates against the new state. The barrier's effect gives the
  // controller's state, this commit's included. The window stays open: this
  // commit mounts nothing that must read the live store.
  useEffect(
    () =>
      eventController.subscribe(() => {
        if (
          eventController.takeTreelessLocationState() &&
          !hydrationOpen.current
        ) {
          setLocationState(eventController.getLocationState());
        }
      }),
    [eventController],
  );

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

  // The last navigation's scroll decision, until React commits its update.
  const pendingScrollRef = useRef<NavigationUpdate["scroll"]>(undefined);
  // The last payload handed to React, until it commits: route state that
  // arrived behind it waits for that commit (flushRouteState("anchor")).
  const committingRef = useRef<typeof payload | undefined>(undefined);

  // Apply scroll after React commits the new content to the DOM
  useLayoutEffect(() => {
    if (payload === committingRef.current) {
      committingRef.current = undefined;
      eventController.releaseRouteState();
    }
    const scrollAction = pendingScrollRef.current;
    if (!scrollAction) return;
    pendingScrollRef.current = undefined;

    if (scrollAction.enabled === false) return;

    handleNavigationEnd({
      restore: scrollAction.restore,
      scroll: scrollAction.enabled,
      isStreaming: scrollAction.isStreaming,
      committed: true,
    });
  });

  // Subscribe to UI updates (for re-rendering the tree)
  useEffect(() => {
    const unsubscribe = store.onUpdate((update) => {
      if (process.env.NODE_ENV !== "production") auditTreeUpdate(update.root);
      // Scroll belongs to the navigation transaction: only an update that
      // carries one's decision sets the pending action, and the layout effect
      // above consumes it once, after the commit that follows. An update with
      // no decision (server action, error, prefetch: false fill) leaves a
      // pending one alone. React can hold a navigation's commit, and whatever
      // lands meanwhile must not cost the navigation its scroll. Nothing
      // stale is replayed: every update commits, and that commit consumes.
      if (update.scroll) pendingScrollRef.current = update.scroll;

      // Committed before the document finished hydrating: end the window
      // first, so the page this update mounts reads the live store. A
      // boundary of the document still dehydrated then hydrates against the
      // live store; where that differs from its HTML, React reports the
      // mismatch and renders the boundary on the client.
      if (hydrationOpen.current) {
        hydrationOpen.current = false;
        eventController.releaseHydrationLock();
      }

      const next = { root: update.root, metadata: update.metadata };
      committingRef.current = next;
      setPayload(next);
      // The state of the entry this payload renders, as its commit recorded
      // it: one update, so one lane, so one React commit with the tree.
      setLocationState(eventController.getLocationState());

      // Update route params. Only reset when the server actually sends a params
      // map — an absent `params` field means "no change" (e.g., legacy action
      // responses that omitted params). Explicit `{}` still clears correctly.
      if (update.metadata.params !== undefined) {
        eventController.setParams(update.metadata.params);
      }

      // tx.commit() and the metadata updates above mutate the controller
      // synchronously, but its ordinary notifications are task-debounced. Flush
      // them here so hook setState calls inherit this payload update's lane. In
      // a transition that suspends, the source tree therefore keeps its source
      // pathname/params until the destination payload commits with them.
      // A page in a transition: route state that arrives from here waits for
      // this payload's commit (useCommitAnchoredState). An urgent page: it is
      // set at default priority, in the page's lane, and commits with it.
      eventController.flushRouteState(
        update.inTransition ? "anchor" : "release",
      );

      // A page rendered from a history-cache entry (back/forward, or a link
      // to it) starts from the entry's pushes, and its response's handles
      // merge onto them: the page on screen's pushes are not its segments'.
      // After the flush: a crumb whose content is still pending would hold
      // the page in its transition; it waits and lands in the page's task.
      const { matched, cachedHandleData } = update.metadata;
      if (matched && cachedHandleData) {
        eventController.setHandleData(cachedHandleData, matched);
      }
      // Update handle data progressively as it streams in
      if (update.metadata.handles) {
        consumeHandles(update.metadata, eventController, store);
      } else if (matched && !cachedHandleData) {
        // Partial cleanup of segments no longer matched.
        eventController.setHandleData(
          {},
          matched,
          true,
          update.metadata.resolvedIds,
        );
      }
      eventController.flushRouteState();
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
      <LocationStateContext.Provider value={locationState}>
        <HydrationBarrierContext.Provider value={hydrationBarrier}>
          {content}
        </HydrationBarrierContext.Provider>
      </LocationStateContext.Provider>
    </NavigationStoreContext.Provider>
  );
}
