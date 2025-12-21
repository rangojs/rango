import React from "react";
import { renderSegments } from "../segment-system.js";
import {
  createNavigationStore,
  generateHistoryKey,
} from "./navigation-store.js";
import { createEventController } from "./event-controller.js";
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

// Vite HMR types
declare global {
  interface ImportMeta {
    hot?: {
      on(event: string, callback: () => void): void;
    };
  }
}

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
  options: InitBrowserAppOptions
): Promise<BrowserAppContext> {
  const { rscStream, deps, storeOptions } = options;

  // Load initial payload from SSR-injected __FLIGHT_DATA__
  const initialPayload =
    await deps.createFromReadableStream<RscPayload>(rscStream);

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

  // Create composable utilities
  const client = createNavigationClient(deps);

  // Setup server action bridge
  const actionBridge = createServerActionBridge({
    store,
    eventController,
    client,
    deps,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
  });
  actionBridge.register();

  // Setup navigation bridge
  const navigationBridge = createNavigationBridge({
    store,
    eventController,
    client,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
  });
  navigationBridge.registerLinkInterception();

  // Use the server's root directly - it already includes rootLayout wrapper
  // Don't rebuild with renderSegments as that would lose the rootLayout
  const initialRoot = initialPayload.root;

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
        });

        if (payload.metadata?.isPartial) {
          const segments = payload.metadata.segments || [];
          const matched = payload.metadata.matched || [];

          store.setSegmentIds(matched);
          store.setCurrentUrl(window.location.href);

          const historyKey = generateHistoryKey(window.location.href);
          store.setHistoryKey(historyKey);
          store.cacheSegmentsForHistory(historyKey, segments);

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
    initialTree: initialRoot,
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
      "RSCRouter: initBrowserApp() must be called before rendering RSCRouter"
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
  const { store, eventController, bridge, initialPayload, initialTree } =
    getBrowserAppContext();

  return (
    <NavigationProvider
      store={store}
      eventController={eventController}
      initialPayload={{ ...initialPayload, root: initialTree }}
      bridge={bridge}
    />
  );
}
