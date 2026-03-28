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
import { createNavigationClient } from "./navigation-client.js";
import { createServerActionBridge } from "./server-action-bridge.js";
import { createNavigationBridge } from "./navigation-bridge.js";
import { NavigationProvider } from "./react/index.js";
import { setBasename } from "./basename.js";
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
import { initPrefetchCache } from "./prefetch/cache.js";
import { setAppVersion } from "./app-version.js";
import {
  isInterceptSegment,
  splitInterceptSegments,
} from "./intercept-utils.js";

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
}

// Module-level state for the initialized app
let browserAppContext: BrowserAppContext | null = null;

/**
 * Initialize the browser app. Must be called before rendering RSCRouter.
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

  // Seed router identity from the initial SSR payload so the first
  // cross-app SPA navigation can detect the app switch.
  if (initialPayload.metadata?.routerId) {
    store.setRouterId?.(initialPayload.metadata.routerId);
  }

  // Seed basename so href() and Link auto-prefix app-local paths.
  if (initialPayload.metadata?.basename) {
    setBasename(initialPayload.metadata.basename);
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

  // Extract rootLayout and version from metadata for browser-side re-renders
  const rootLayout = initialPayload.metadata?.rootLayout;
  const version = initialPayload.metadata?.version;

  // Initialize the localStorage state key for cache invalidation.
  // Uses the build version so a new deploy automatically busts all cached prefetches.
  initRangoState(version ?? "0");
  setAppVersion(version);

  // Initialize the in-memory prefetch cache TTL from server config.
  // A value of 0 disables the cache; undefined falls back to the module default.
  const prefetchCacheTTL = initialPayload.metadata?.prefetchCacheTTL;
  if (prefetchCacheTTL !== undefined) {
    initPrefetchCache(prefetchCacheTTL);
  }

  // Create a bound renderSegments that includes rootLayout
  const renderSegments = (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions,
  ) => baseRenderSegments(segments, { ...options, rootLayout });

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
        window.location.href = url;
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
          console.log("[RSCRouter] HMR: Skipping — navigation in progress");
          return;
        }

        console.log("[RSCRouter] HMR: Server update, refetching RSC");

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
          const newVersion = payload.metadata.version;
          if (newVersion && newVersion !== version) {
            console.log(
              "[RSCRouter] HMR: version changed",
              version,
              "→",
              newVersion,
              "clearing caches",
            );
            navigationBridge.updateVersion(newVersion);
          }

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
          console.log("[RSCRouter] HMR: RSC stream complete");
        } catch (err) {
          if (abort.signal.aborted) return;
          console.warn("[RSCRouter] HMR: Refetch failed, reloading page", err);
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

  // Store context for RSCRouter component
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
      "RSCRouter: initBrowserApp() must be called before rendering RSCRouter",
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
 * Props for the RSCRouter component
 */
export interface RSCRouterProps {}

/**
 * RSCRouter component - renders the RSC router with all internal wiring.
 *
 * Must be called after initBrowserApp() has completed.
 *
 * @example
 * ```tsx
 * import { initBrowserApp, RSCRouter } from "rsc-router/browser";
 * import { rscStream } from "rsc-html-stream/client";
 * import * as rscBrowser from "@vitejs/plugin-rsc/browser";
 *
 * async function main() {
 *   await initBrowserApp({ rscStream, deps: rscBrowser });
 *
 *   hydrateRoot(
 *     document,
 *     <React.StrictMode>
 *       <RSCRouter />
 *     </React.StrictMode>
 *   );
 * }
 * main();
 * ```
 */
export function RSCRouter(_props: RSCRouterProps): React.ReactElement {
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
    />
  );
}
