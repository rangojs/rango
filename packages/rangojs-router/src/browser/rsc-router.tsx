import React from "react";
import {
  renderSegments as baseRenderSegments,
  type RenderSegmentsOptions,
} from "../segment-system.js";
import {
  createNavigationStore,
  generateHistoryKey,
} from "./navigation-store.js";
import { createEventController } from "./event-controller.js";
import { validateRedirectOrigin } from "./validate-redirect-origin.js";
import { createNavigationClient } from "./navigation-client.js";
import { createServerActionBridge } from "./server-action-bridge.js";
import { createNavigationBridge } from "./navigation-bridge.js";
import { NavigationProvider } from "./react/index.js";
import type {
  RscPayload,
  RscBrowserDependencies,
  ResolvedSegment,
  NavigationStore,
  NavigationBridge,
} from "./types.js";
import type { EventController } from "./event-controller.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";
import { initRangoState } from "./rango-state.js";
import { registerNavigationStore } from "./navigation-store-handle.js";
import { initPrefetchCache } from "./prefetch/cache.js";
import { setPrefetchDecoder } from "./prefetch/fetch.js";
import { setAppVersion } from "./app-version.js";
import {
  isInterceptSegment,
  splitInterceptSegments,
} from "./intercept-utils.js";
import { createAppShellRef } from "./app-shell.js";

// Vite HMR types are provided by vite/client

/**
 * Options for initializing the browser app
 */
export interface InitBrowserAppOptions {
  /**
   * RSC stream containing the initial payload (from rsc-html-stream/client)
   */
  rscStream: ReadableStream<Uint8Array>;

  /**
   * RSC browser dependencies from @vitejs/plugin-rsc/browser
   */
  deps: RscBrowserDependencies;

  /**
   * Optional store configuration
   */
  storeOptions?: {
    /**
     * Maximum number of history entries to cache
     * @default 10
     */
    cacheSize?: number;
  };

  /**
   * Enable global link interception for SPA navigation.
   * When enabled, clicks on same-origin anchor elements are intercepted
   * and handled via client-side navigation instead of full page loads.
   *
   * Links rendered with the Link component handle their own navigation
   * regardless of this setting.
   *
   * Set to false to disable global interception and rely solely on
   * Link components for SPA navigation.
   *
   * @default true
   */
  linkInterception?: boolean;

  /**
   * Theme configuration from router.
   * When provided, enables theme support via useTheme hook.
   * Pass router.themeConfig here to enable theme features.
   *
   * @example
   * ```tsx
   * import { router } from "./router.js";
   *
   * await initBrowserApp({
   *   rscStream,
   *   deps: rscBrowser,
   *   themeConfig: router.themeConfig,
   *   initialTheme: document.documentElement.className.includes("dark") ? "dark" : "light",
   * });
   * ```
   */
  themeConfig?: ResolvedThemeConfig | null;

  /**
   * Initial theme from server (typically read from cookie).
   * Only used when themeConfig is provided.
   */
  initialTheme?: Theme;
}

/**
 * Result from initializing the browser app
 */
export interface BrowserAppContext {
  store: NavigationStore;
  eventController: EventController;
  bridge: NavigationBridge;
  initialPayload: RscPayload;
  initialTree: React.ReactNode | Promise<React.ReactNode>;
  /** Theme configuration (null if theme not enabled) */
  themeConfig?: ResolvedThemeConfig | null;
  /** Initial theme from server */
  initialTheme?: Theme;
  /** Whether connection warmup is enabled */
  warmupEnabled?: boolean;
  /** App version for prefetch version mismatch detection */
  version?: string;
  /**
   * App-shell ref, read through on each render so renderSegments and the
   * NavigationProvider see rootLayout/basename/version without closing over a
   * stale snapshot. Set once from the initial payload and not swapped within a
   * session: a cross-app navigation is a full document load (X-RSC-Reload), so
   * the target app establishes its own shell on load. Theme, warmup, and
   * prefetch TTL are document-lifetime too (see AppShell).
   */
  appShellRef?: import("./app-shell.js").AppShellRef;
}

// Module-level state for the initialized app
let browserAppContext: BrowserAppContext | null = null;

/**
 * Initialize the browser app. Must be called before rendering Rango.
 *
 * This function:
 * - Loads the initial RSC payload from the stream
 * - Creates the navigation store and event controller
 * - Sets up action and navigation bridges
 * - Configures HMR support
 */
export async function initBrowserApp(
  options: InitBrowserAppOptions,
): Promise<BrowserAppContext> {
  const {
    rscStream,
    deps,
    storeOptions,
    linkInterception = true,
    themeConfig,
    initialTheme,
  } = options;

  const initialPayload =
    await deps.createFromReadableStream<RscPayload>(rscStream);

  // Extract themeConfig and initialTheme from payload if not explicitly provided
  // This allows virtual entries to work without importing the router
  const effectiveThemeConfig =
    themeConfig ?? initialPayload.metadata?.themeConfig ?? null;
  const effectiveInitialTheme =
    initialTheme ?? initialPayload.metadata?.initialTheme;

  // Get initial segments and compute history key from current URL
  const initialSegments = (initialPayload.metadata?.segments ??
    []) as ResolvedSegment[];
  const initialHistoryKey = generateHistoryKey(window.location.href);

  // Create navigation store with history-based caching
  const store = createNavigationStore({
    initialLocation: window.location,
    initialSegmentIds: initialSegments.map((s) => s.id),
    initialHistoryKey,
    initialSegments,
    ...(storeOptions?.cacheSize && { cacheSize: storeOptions.cacheSize }),
  });

  // Register the active store on the module-level handle and wire the
  // jar-divergence observer before any getRangoState() read can detect a
  // cross-tab/server rotation. There is no global store singleton, so this
  // handle is the live reference.
  registerNavigationStore(store);

  // Seed router identity from the initial SSR payload so the first
  // cross-app SPA navigation can detect the app switch.
  if (initialPayload.metadata?.routerId) {
    store.setRouterId?.(initialPayload.metadata.routerId);
  }

  // Create event controller for reactive state management
  const eventController = createEventController({
    initialLocation: new URL(window.location.href),
  });

  // Initialize event controller with segment order (even without handles)
  eventController.setHandleData({}, initialPayload.metadata?.matched);

  // Initialize route params
  eventController.setParams(initialPayload.metadata?.params ?? {});

  // Initialize handle data from initial payload BEFORE hydration
  // This ensures useHandle returns correct data during hydration to avoid mismatch
  // The handles property is an async generator that yields on each push
  if (initialPayload.metadata?.handles) {
    const handlesGenerator = initialPayload.metadata.handles;
    let lastHandleData: Record<string, Record<string, unknown[]>> = {};
    for await (const handleData of handlesGenerator) {
      lastHandleData = handleData;
    }
    // Initialize event controller with initial handle state before hydration.
    eventController.setHandleData(
      lastHandleData,
      initialPayload.metadata?.matched,
    );

    // Update the initial cache entry with the processed handleData
    // The cache entry was created by createNavigationStore but without handleData
    store.updateCacheHandleData(initialHistoryKey, lastHandleData);
  }

  // Create composable utilities
  const client = createNavigationClient(deps);

  // Capture the per-router app-shell. rootLayout, basename, and version live
  // here and are read through the ref at call time rather than closed over.
  // It is set once from the initial payload and not swapped within a session:
  // a cross-app navigation is a full document load (X-RSC-Reload), so the
  // target app establishes its own shell on load.
  const version = initialPayload.metadata?.version;
  const appShellRef = createAppShellRef({
    routerId: initialPayload.metadata?.routerId,
    rootLayout: initialPayload.metadata?.rootLayout,
    basename: initialPayload.metadata?.basename,
    version,
  });

  // Initialize the rango state cookie for cache invalidation. The build version
  // busts cached prefetches on deploy; the server-resolved cookie name
  // namespaces the cookie so sibling apps on the same origin don't collide
  // (falls back to the bare default prefix if metadata lacks the name).
  initRangoState(version ?? "0", initialPayload.metadata?.stateCookieName);
  setAppVersion(version);

  // Initialize the in-memory prefetch cache TTL from server config.
  // A value of 0 disables the cache; undefined falls back to the module default.
  const prefetchCacheTTL = initialPayload.metadata?.prefetchCacheTTL;
  if (prefetchCacheTTL !== undefined) {
    initPrefetchCache(prefetchCacheTTL);
  }

  // Wire the RSC decoder so prefetches decode eagerly and warm the route's
  // client chunks (same createFromFetch the navigation client uses).
  setPrefetchDecoder((response) => deps.createFromFetch<RscPayload>(response));

  // Create a bound renderSegments that reads rootLayout through the shell ref.
  // The shell is set once at init and not swapped within a session (a cross-app
  // navigation is a full document load), so this always renders this app's
  // Document; reading through the ref just avoids closing over a stale value.
  const renderSegments = (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions,
  ) =>
    baseRenderSegments(segments, {
      ...options,
      rootLayout: appShellRef.get().rootLayout,
    });

  // Lazy reference for navigation bridge — the action bridge is created first
  // but may need to trigger SPA navigation for action redirects.
  let navigateFn: ((url: string, options?: any) => Promise<void>) | null = null;

  // Setup server action bridge
  const actionBridge = createServerActionBridge({
    store,
    eventController,
    client,
    deps,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
    onNavigate: (url, options) => {
      if (!navigateFn) {
        // Navigation bridge not wired yet: hard-navigate, but re-validate
        // same-origin defensively so this init-window fallback cannot become an
        // open redirect (the normal path validates inside the navigation bridge).
        const safe = validateRedirectOrigin(url, window.location.origin);
        if (safe) {
          window.location.href = safe;
        }
        return Promise.resolve();
      }
      return navigateFn(url, options);
    },
  });
  actionBridge.register();

  // Setup navigation bridge
  const navigationBridge = createNavigationBridge({
    store,
    eventController,
    client,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
    version: version,
  });

  // Connect action redirect → navigation bridge (now that both are initialized)
  navigateFn = (url, options) => navigationBridge.navigate(url, options);

  // Optionally enable global link interception
  if (linkInterception) {
    navigationBridge.registerLinkInterception();
  }

  // Build initial tree with rootLayout
  const initialTree = renderSegments(initialPayload.metadata!.segments);

  // Setup HMR with debounce — burst saves (format-on-save, rapid edits)
  // fire many rsc:update events in quick succession. Without debouncing,
  // each event triggers a fetchPartial() which on slow routes can pile up
  // and overwhelm the worker (cross-request promise issues, 500s).
  if (import.meta.hot) {
    let hmrTimer: ReturnType<typeof setTimeout> | null = null;
    let hmrAbort: AbortController | null = null;

    import.meta.hot.on("rsc:update", () => {
      // Cancel any pending debounce timer
      if (hmrTimer !== null) {
        clearTimeout(hmrTimer);
      }

      // Abort any in-flight HMR fetch so it doesn't race with the next one
      if (hmrAbort) {
        hmrAbort.abort();
        hmrAbort = null;
      }

      // Debounce: wait 200ms of quiet before fetching
      hmrTimer = setTimeout(async () => {
        hmrTimer = null;

        // Don't interrupt an active user navigation — startNavigation()
        // would abort it and refetch the old URL (window.location.href
        // hasn't updated yet). The user's navigation will pick up the
        // new server code when it completes. isNavigating covers the
        // full lifecycle (fetching + streaming, before commit) without
        // blocking on server actions.
        if (eventController.getState().isNavigating) {
          console.log("[Rango] HMR: Skipping — navigation in progress");
          return;
        }

        console.log("[Rango] HMR: Server update, refetching RSC");

        const abort = new AbortController();
        hmrAbort = abort;

        const handle = eventController.startNavigation(window.location.href, {
          replace: true,
        });
        const streamingToken = handle.startStreaming();

        const interceptSourceUrl = store.getInterceptSourceUrl();

        try {
          const { payload, streamComplete } = await client.fetchPartial({
            targetUrl: window.location.href,
            segmentIds: [],
            previousUrl: store.getSegmentState().currentUrl,
            interceptSourceUrl: interceptSourceUrl || undefined,
            routerId: store.getRouterId?.(),
            hmr: true,
            signal: abort.signal,
          });

          if (abort.signal.aborted) return;

          // If the server returned a non-RSC response (404, 500 without
          // error boundary), the payload won't have valid metadata.
          // Reload to recover rather than leaving the page stale.
          if (!payload.metadata) {
            throw new Error("HMR refetch returned invalid payload");
          }

          // Update version BEFORE rebuilding state so that
          // clearHistoryCache() runs first, then the fresh segment
          // cache entry we create below survives.
          //
          // Compare against the bridge's live version, not the init-time
          // `version` const: after the first HMR bump the const is stale, so a
          // later update with an unchanged version would otherwise re-clear the
          // cache and re-broadcast across tabs/apps. The live read fires only
          // on a genuine version change.
          const newVersion = payload.metadata.version;
          const currentVersion = navigationBridge.getVersion();
          if (newVersion && newVersion !== currentVersion) {
            console.log(
              "[Rango] HMR: version changed",
              currentVersion,
              "→",
              newVersion,
              "clearing caches",
            );
            navigationBridge.updateVersion(newVersion);
          }

          // Apply only partial segment updates. A non-partial payload during
          // HMR is transient: the worker route table is still rebuilding after
          // the edit, so the URL momentarily resolves to not-found/catch-all.
          // Skip it -- the debounced follow-up refetch returns the settled
          // route's partial payload and renders it below. We never reload here:
          // a paramless document GET would run the SSR path and surface the
          // not-found page during that same transient.
          if (payload.metadata?.isPartial) {
            const segments = payload.metadata.segments || [];
            const matched = payload.metadata.matched || [];

            // Derive intercept state from the returned payload, not the
            // pre-fetch store snapshot. If the HMR edit removed intercept
            // behavior, the response won't contain intercept segments.
            const responseIsIntercept = segments.some(isInterceptSegment);

            // Sync store intercept state with what the server returned
            if (!responseIsIntercept && interceptSourceUrl) {
              store.setInterceptSourceUrl(null);
            }

            store.setSegmentIds(matched);
            store.setCurrentUrl(window.location.href);

            const historyKey = generateHistoryKey(window.location.href, {
              intercept: responseIsIntercept,
            });
            store.setHistoryKey(historyKey);
            const currentHandleData = eventController.getHandleState().data;
            store.cacheSegmentsForHistory(
              historyKey,
              segments,
              currentHandleData,
            );

            const { main, intercept } = splitInterceptSegments(segments);
            store.emitUpdate({
              root: renderSegments(main, {
                interceptSegments: intercept.length > 0 ? intercept : undefined,
              }),
              metadata: payload.metadata,
            });
          }

          await streamComplete;
          handle.complete(new URL(window.location.href));
          console.log("[Rango] HMR: RSC stream complete");
        } catch (err) {
          if (abort.signal.aborted) return;
          console.warn("[Rango] HMR: Refetch failed, reloading page", err);
          window.location.reload();
          return;
        } finally {
          if (hmrAbort === abort) hmrAbort = null;
          streamingToken.end();
          handle[Symbol.dispose]();
        }
      }, 200);
    });
  }

  // Store context for Rango component
  const context: BrowserAppContext = {
    store,
    eventController,
    bridge: navigationBridge,
    initialPayload,
    initialTree,
    themeConfig: effectiveThemeConfig,
    initialTheme: effectiveInitialTheme,
    warmupEnabled: initialPayload.metadata?.warmupEnabled ?? true,
    version,
    appShellRef,
  };
  browserAppContext = context;

  return context;
}

/**
 * Get the browser app context. Throws if initBrowserApp hasn't been called.
 */
export function getBrowserAppContext(): BrowserAppContext {
  if (!browserAppContext) {
    throw new Error(
      "Rango: initBrowserApp() must be called before rendering Rango",
    );
  }
  return browserAppContext;
}

/**
 * Reset the browser app context (for testing)
 */
export function resetBrowserAppContext(): void {
  browserAppContext = null;
}

/**
 * Props for the Rango component
 */
export interface RangoProps {}

/**
 * Rango component - renders the RSC router with all internal wiring.
 *
 * Must be called after initBrowserApp() has completed.
 *
 * @example
 * ```tsx
 * import { initBrowserApp, Rango } from "rsc-router/browser";
 * import { rscStream } from "rsc-html-stream/client";
 * import * as rscBrowser from "@vitejs/plugin-rsc/browser";
 *
 * async function main() {
 *   await initBrowserApp({ rscStream, deps: rscBrowser });
 *
 *   hydrateRoot(
 *     document,
 *     <React.StrictMode>
 *       <Rango />
 *     </React.StrictMode>
 *   );
 * }
 * main();
 * ```
 */
export function Rango(_props: RangoProps): React.ReactElement {
  const {
    store,
    eventController,
    bridge,
    initialPayload,
    initialTree,
    themeConfig,
    initialTheme,
    warmupEnabled,
    version,
    appShellRef,
  } = getBrowserAppContext();

  // Signal that the React tree has hydrated. useEffect only fires after
  // hydration completes, so this attribute is a stable readiness marker
  // that does not depend on React internals like __reactFiber.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "";
  }, []);

  return (
    <NavigationProvider
      store={store}
      eventController={eventController}
      initialPayload={{ root: initialTree, metadata: initialPayload.metadata! }}
      bridge={bridge}
      themeConfig={themeConfig}
      initialTheme={initialTheme}
      warmupEnabled={warmupEnabled}
      version={version}
      basename={initialPayload.metadata?.basename}
      appShellRef={appShellRef}
    />
  );
}
