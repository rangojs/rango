/**
 * Browser hydration entry point
 * Encapsulates all the internal logic for initializing the RSC Router on the client
 */

import { rscStream } from "rsc-html-stream/client";
import { renderSegments } from "../segment-system.js";
import { createNavigationStore } from "./navigation-store.js";
import { createRequestController } from "./request-controller.js";
import { createNavigationClient } from "./navigation-client.js";
import { createServerActionBridge } from "./server-action-bridge.js";
import { createNavigationBridge } from "./navigation-bridge.js";
import { NavigationProvider } from "./react/index.js";
import type { RscPayload, RscBrowserDependencies } from "./types.js";

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

  // Create navigation store
  const store = createNavigationStore({
    initialLocation: window.location,
    initialSegmentIds:
      initialPayload.metadata?.segments?.map((s) => s.id) ?? [],
  });

  // Store initial segments
  initialPayload.metadata?.segments?.forEach((segment) => {
    store.storeSegment(segment);
  });

  // Create utilities
  const requestController = createRequestController();
  const client = createNavigationClient(deps);

  // Setup server action bridge
  const actionBridge = createServerActionBridge({
    store,
    client,
    requestController,
    deps,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
  });
  actionBridge.register();

  // Setup navigation bridge
  const navigationBridge = createNavigationBridge({
    store,
    client,
    requestController,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
  });
  navigationBridge.registerLinkInterception();

  // Build initial tree
  const initialTree = renderSegments(initialPayload.metadata!.segments);

  // HMR support
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      store.setState({ isStreaming: true });

      const { payload, streamComplete } = await client.fetchPartial({
        targetUrl: window.location.href,
        segmentIds: [],
        previousUrl: store.getSegmentState().currentUrl,
      });

      if (payload.metadata?.isPartial) {
        store.storeSegments(payload.metadata.segments || []);
        store.setSegmentIds(payload.metadata.matched || []);
        store.setCurrentUrl(window.location.href);

        const fullSegments = (payload.metadata.matched || [])
          .map((id: string) => store.getSegmentState().storedSegments.get(id))
          .filter(Boolean);

        store.emitUpdate({
          root: renderSegments(fullSegments as any),
          metadata: payload.metadata,
        });
      }

      await streamComplete;
      store.setState({ isStreaming: false });
    });
  }

  // Return App component
  return function App() {
    return (
      <NavigationProvider
        store={store}
        initialPayload={{ ...initialPayload, root: initialTree }}
        bridge={navigationBridge}
      />
    );
  };
}
