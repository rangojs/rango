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
import { cloneHandleData } from "../navigation-store.js";
import { collectHandleData } from "../../handle.js";
import { Meta } from "../../handles/meta.js";
import type { MetaDescriptor } from "../../router/types.js";
import {
  HEAD_RESOLVE_HANDLE_NAMES,
  hasDeferredHandleValue,
  resolveDeferredHandleValues,
} from "./deferred-handle-resolution.js";

/** Meta handle-name key. Meta is the only head-placed handle whose consumer
 *  use()s a deferred value above the route <Suspense>, so it must be resolved in
 *  the store before apply; every other handle keeps the promise contract. */
const META = "__rsc_router_meta__";

/**
 * Carry the previous page's COLLECTED Meta forward so the title is kept (no
 * blank) while a deferred Meta resolves on a soft navigation.
 *
 * Why a carry-forward and not just preserving the previous Meta data: handle
 * collection (useHandle/MetaTags) is driven by the event controller's
 * `segmentOrder`, which becomes the NEW route's order so the synchronous
 * breadcrumbs render immediately. The previous route's title lives under a
 * segment that is NOT in the new order, so it would stop being collected — the
 * title would fall back to the layout default. Re-keying the previous COLLECTED
 * descriptors under a segment that IS in the new order keeps them visible.
 *
 * Title descriptors are wrapped as `{ title: { absolute } }` so re-collection
 * under a (possibly template-bearing) new layout does not re-apply a title
 * template to an already-final title. Promise and default (charSet/viewport)
 * descriptors are dropped: Promise ones would suspend MetaTags, and the defaults
 * are re-added by collectMeta.
 */
function carriedPreviousMeta(prev: MetaDescriptor[]): MetaDescriptor[] {
  const out: MetaDescriptor[] = [];
  for (const d of prev) {
    if (d && typeof (d as { then?: unknown }).then === "function") continue;
    const base = d as Exclude<MetaDescriptor, Promise<unknown>>;
    if ("charSet" in base) continue;
    if ("name" in base && (base as { name?: unknown }).name === "viewport") {
      continue;
    }
    if ("title" in base) {
      const t = (base as { title: unknown }).title;
      out.push({ title: { absolute: typeof t === "string" ? t : String(t) } });
      continue;
    }
    out.push(base);
  }
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

  // This nav's instance token, captured before any await — processHandles runs
  // right after its own commit, so this is that commit's token. generateHistoryKey
  // is URL-only, so an A->B->A revisit reuses the key; the token lets a late
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

    // Resolve ONLY Meta in the store before applying. Meta is the sole
    // head-placed handle whose consumer use()s a deferred value above the route
    // <Suspense>; an uncontained suspension there would revert the just-committed
    // route and hide its loading fallback. Every other handle (Breadcrumbs,
    // custom handles) keeps the DeferredHandleEntry contract: its deferred values
    // reach the consumer AS A PROMISE and are narrowed via isThenable(). So sync
    // handles AND non-Meta deferred promises apply/stream through immediately —
    // only Meta is held back and swapped in once resolved.
    const metaDeferred = hasDeferredHandleValue(
      handleData,
      HEAD_RESOLVE_HANDLE_NAMES,
    );

    // Apply now. The non-deferred-Meta case applies the whole snapshot in one
    // call (Meta included). When Meta IS deferred, replace the deferred Meta with
    // the previous page's COLLECTED Meta (stale-while-revalidate — never a blank
    // title) keyed under one of the NEW route's Meta segments, so it stays
    // collected under the new segment order while the synchronous and non-Meta
    // deferred handles update with normal cleanup. The resolved Meta is swapped
    // in by the partial merge below.
    if (metaDeferred) {
      const immediate: HandleData = { ...handleData };
      const metaSegments = handleData[META] ?? {};
      // Anchor: the last new Meta segment in matched order (collected after the
      // shared layout, so its carried title wins). Falls back to any new Meta
      // segment if matched ordering does not surface one.
      const metaSegmentIds = Object.keys(metaSegments);
      const ordered = (matched ?? []).filter((id) =>
        metaSegmentIds.includes(id),
      );
      const anchor = ordered.at(-1) ?? metaSegmentIds.at(-1);

      const prevState = eventController.getHandleState();
      const prevCollected = collectHandleData(
        Meta,
        prevState.data,
        prevState.segmentOrder,
      ) as MetaDescriptor[];
      const carried = carriedPreviousMeta(prevCollected);

      if (anchor && carried.length > 0) {
        immediate[META] = { [anchor]: carried };
      } else {
        // No previous Meta to carry and/or no anchor: leave Meta unset until it
        // resolves (the documented no-previous-Meta behavior).
        delete immediate[META];
      }
      eventController.setHandleData(immediate, matched, isPartial, resolvedIds);
    } else {
      eventController.setHandleData(
        handleData,
        matched,
        isPartial,
        resolvedIds,
      );
    }

    // Snapshot of the nav's full applied handle state (sync handles, non-Meta
    // deferred promises, and — when Meta is deferred — the carried previous Meta).
    // Captured AFTER applying so it reflects what is actually on screen now.
    const baseSnapshot = cloneHandleData(eventController.getHandleState().data);

    if (!metaDeferred) {
      // Non-deferred: the applied snapshot is final. Keep the cache in sync and
      // fresh. The token guard stops a stale same-URL nav writing a newer entry.
      if (store.getCacheEntryInstance(historyKey) === myInstance) {
        store.updateCacheHandleData(historyKey, baseSnapshot, false);
      }
      continue;
    }

    // Meta is deferred-pending. The applied snapshot carries the PREVIOUS page's
    // Meta (or none), not this route's final title, so the cache entry must NOT
    // be served as fresh on a popstate return. Mark it STALE and handlesPending
    // (token-guarded). This is the P1 fix: the deferred Meta is a SERVER-side
    // promise streamed via Flight, so a navigate-away ABORTS the stream and the
    // client's deferred-Meta promise never resolves — the .then below never
    // fires. stale makes a popstate return revalidate; handlesPending makes that
    // revalidation a FULL re-render (no client segment IDs) so the server
    // re-streams the handles. A diff-only revalidation would omit the unchanged
    // segments' handles and the deferred Meta would never land — see the
    // segmentIds branch in navigation-bridge.ts.
    if (store.getCacheEntryInstance(historyKey) === myInstance) {
      store.updateCacheHandleData(historyKey, baseSnapshot, true, true);
    }

    // Resolve Meta late, then swap it in. The swap is a PARTIAL merge with
    // resolvedIds=undefined so the stale-clear loop (which scans all handle
    // names under resolvedIds) cannot wipe the non-Meta buckets we already
    // applied. When the deferred Meta DOES resolve while this nav still owns the
    // entry (no navigate-away abort), write the resolved handle data and clear
    // stale + handlesPending — the entry is now complete, so a popstate return
    // serves it without revalidating.
    //
    // Order-safety: each stream yield is a full cumulative snapshot and a
    // segment's handle array is atomic, so concurrent Meta resolutions of
    // different yields write identical per-segment arrays or touch disjoint
    // segments — neither can clobber the other.
    void resolveDeferredHandleValues(
      handleData,
      HEAD_RESOLVE_HANDLE_NAMES,
    ).then((resolved) => {
      const cacheValue = { ...baseSnapshot, [META]: resolved[META] };
      if (stillLive()) {
        // Still on the live page: swap Meta in and refresh the cache as fresh.
        eventController.setHandleData(
          { [META]: resolved[META] },
          matched,
          true,
          undefined,
        );
        store.updateCacheHandleData(
          historyKey,
          eventController.getHandleState().data,
          false,
          false,
        );
      } else if (store.getCacheEntryInstance(historyKey) === myInstance) {
        // Navigated away, but THIS nav still owns the target cache entry: write
        // the resolved data and clear stale + handlesPending so a popstate return
        // is fresh.
        store.updateCacheHandleData(historyKey, cacheValue, false, false);
      }
      // else: a newer nav to the same URL superseded us — do nothing.
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
  // Only update if we're still on the same page AND this is still the live nav
  // (the token guard stops a stale same-URL nav writing a newer nav's state).
  if (stillLive()) {
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
