/**
 * Browser hydration entry point
 * Encapsulates all the internal logic for initializing the RSC Router on the client
 */

import { rscStream } from "rsc-html-stream/client";
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
} from "./types.js";

// Vite HMR types
declare global {
  interface ImportMeta {
    hot?: {
      on(event: string, callback: () => void): void;
    };
  }
}

/**
 * Configuration for createApp
 */
export interface CreateAppConfig {
  /**
   * RSC browser dependencies from @vitejs/plugin-rsc/browser
   */
  deps: RscBrowserDependencies;
}

/**
 * Create the RSC app component for hydration
 * Returns a React element that you can hydrate with your own wrapper
 *
 * @example
 * ```typescript
 * import { createApp } from "rsc-router/browser";
 * import * as browserDeps from "@vitejs/plugin-rsc/browser";
 * import { hydrateRoot } from "react-dom/client";
 *
 * async function main() {
 *   const App = await createApp({ deps: browserDeps });
 *
 *   hydrateRoot(
 *     document.getElementById("root")!,
 *     <React.StrictMode>
 *       <App />
 *     </React.StrictMode>
 *   );
 * }
 *
 * main();
 * ```
 */
export async function createApp(
  config: CreateAppConfig
): Promise<() => React.ReactElement> {
  const { deps } = config;

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
  });

  // Create event controller for reactive state management
  const eventController = createEventController({
    initialLocation: new URL(window.location.href),
  });

  // Create utilities
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

  // Build initial tree
  const initialTree = await renderSegments(initialPayload.metadata!.segments);

  // HMR support
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

  // Return App component
  return function App() {
    return (
      <NavigationProvider
        store={store}
        eventController={eventController}
        initialPayload={{ ...initialPayload, root: initialTree }}
        bridge={navigationBridge}
      />
    );
  };
}
