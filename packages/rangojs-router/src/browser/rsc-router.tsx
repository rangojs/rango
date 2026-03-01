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
import {
  NavigationProvider,
  initHandleDataSync,
  initSegmentsSync,
} from "./react/index.js";
import { initThemeConfigSync } from "../theme/theme-context.js";
import type {
  RscPayload,
  RscBrowserDependencies,
  ResolvedSegment,
  NavigationStore,
  NavigationBridge,
} from "./types.js";
import type { EventController } from "./event-controller.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";

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
  /** Prefetch mode: "router" for fetch-based, "browser" for <link rel="prefetch"> */
  prefetchMode?: "browser" | "router";
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

  // Load initial payload from SSR-injected __FLIGHT_DATA__
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

  // Create event controller for reactive state management
  const eventController = createEventController({
    initialLocation: new URL(window.location.href),
  });

  // Initialize segments state BEFORE hydration to avoid mismatch
  initSegmentsSync(
    initialPayload.metadata?.matched,
    initialPayload.metadata?.pathname,
    initialPayload.metadata?.params,
  );

  // Initialize theme config for MetaTags (must match SSR state)
  initThemeConfigSync(effectiveThemeConfig);

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
    // Initialize both event controller AND module-level SSR state for hydration compatibility
    eventController.setHandleData(
      lastHandleData,
      initialPayload.metadata?.matched,
    );
    initHandleDataSync(lastHandleData, initialPayload.metadata?.matched);

    // Update the initial cache entry with the processed handleData
    // The cache entry was created by createNavigationStore but without handleData
    store.updateCacheHandleData(initialHistoryKey, lastHandleData);
  }

  // Create composable utilities
  const client = createNavigationClient(deps);

  // Extract rootLayout and version from metadata for browser-side re-renders
  const rootLayout = initialPayload.metadata?.rootLayout;
  const version = initialPayload.metadata?.version;

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
    version,
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
    version,
  });

  // Connect action redirect → navigation bridge (now that both are initialized)
  navigateFn = (url, options) => navigationBridge.navigate(url, options);

  // Optionally enable global link interception
  if (linkInterception) {
    navigationBridge.registerLinkInterception();
  }

  // Build initial tree with rootLayout
  const initialTree = renderSegments(initialPayload.metadata!.segments);

  // Setup HMR
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      console.log("[RSCRouter] HMR: Server update, refetching RSC");

      const handle = eventController.startNavigation(window.location.href, {
        replace: true,
      });
      const streamingToken = handle.startStreaming();

      try {
        const { payload, streamComplete } = await client.fetchPartial({
          targetUrl: window.location.href,
          segmentIds: [],
          previousUrl: store.getSegmentState().currentUrl,
          hmr: true,
        });

        if (payload.metadata?.isPartial) {
          const segments = payload.metadata.segments || [];
          const matched = payload.metadata.matched || [];

          store.setSegmentIds(matched);
          store.setCurrentUrl(window.location.href);

          const historyKey = generateHistoryKey(window.location.href);
          store.setHistoryKey(historyKey);
          const currentHandleData = eventController.getHandleState().data;
          store.cacheSegmentsForHistory(
            historyKey,
            segments,
            currentHandleData,
          );

          store.emitUpdate({
            root: renderSegments(segments),
            metadata: payload.metadata,
          });
        }

        await streamComplete;
      } finally {
        streamingToken.end();
      }
      handle.complete(new URL(window.location.href));
      console.log("[RSCRouter] HMR: RSC stream complete");
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
    prefetchMode: initialPayload.metadata?.prefetchMode ?? "router",
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
    prefetchMode,
    version,
  } = getBrowserAppContext();

  return (
    <NavigationProvider
      store={store}
      eventController={eventController}
      initialPayload={{ root: initialTree, metadata: initialPayload.metadata! }}
      bridge={bridge}
      themeConfig={themeConfig}
      initialTheme={initialTheme}
      warmupEnabled={warmupEnabled}
      prefetchMode={prefetchMode}
      version={version}
    />
  );
}
