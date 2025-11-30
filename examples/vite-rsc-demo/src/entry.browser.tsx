import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  encodeReply,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import { renderSegments } from "rsc-router";
import {
  createNavigationStore,
  createRequestController,
  createNavigationClient,
  createServerActionBridge,
  createNavigationBridge,
  NavigationProvider,
  generateHistoryKey,
  type RscPayload,
  type ResolvedSegment,
} from "rsc-router/browser";

console.log("[Browser] Initializing...");

async function initializeApp() {
  // RSC browser dependencies
  const deps = {
    createFromFetch,
    createFromReadableStream,
    encodeReply,
    setServerCallback,
    createTemporaryReferenceSet,
  };

  // Load initial payload from SSR-injected __FLIGHT_DATA__
  console.log("[Browser] Loading initial payload...");
  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);
  console.log("[Browser] Initial payload:", initialPayload.metadata);

  // Get initial segments and compute history key from current URL
  const initialSegments = (initialPayload.metadata?.segments ?? []) as ResolvedSegment[];
  const initialHistoryKey = generateHistoryKey(window.location.href);

  // Create navigation store with history-based caching
  const store = createNavigationStore({
    initialLocation: window.location,
    initialSegmentIds: initialSegments.map((s) => s.id),
    initialHistoryKey,
    initialSegments,
  });

  console.log(
    "[Browser] Initial segments:",
    store.getSegmentState().currentSegmentIds.join(", ")
  );
  console.log(
    `[Browser] Cached segments for: ${initialHistoryKey}`
  );

  // Create composable utilities
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

  // Hydrate
  const root = document.getElementById("root") || document;
  hydrateRoot(
    root,
    <React.StrictMode>
      <NavigationProvider
        store={store}
        initialPayload={{ ...initialPayload, root: initialTree }}
        bridge={navigationBridge}
      />
    </React.StrictMode>
  );

  console.log("[Browser] Hydrated\n");

  // Note: Initial stream tracking is handled inside NavigationProvider's useEffect
  // to ensure it only runs AFTER hydration is complete (hydrateRoot doesn't complete synchronously)

  // HMR support
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      console.log("[Browser] HMR: Server update, refetching RSC");
      store.setState({ isStreaming: true });

      // Refetch with empty segments to get everything fresh
      const { payload, streamComplete } = await client.fetchPartial({
        targetUrl: window.location.href,
        segmentIds: [],
        previousUrl: store.getSegmentState().currentUrl,
      });

      if (payload.metadata?.isPartial) {
        const segments = payload.metadata.segments || [];
        const matched = payload.metadata.matched || [];

        // Update store state
        store.setSegmentIds(matched);
        store.setCurrentUrl(window.location.href);

        // Update cache with fresh segments
        const historyKey = generateHistoryKey(window.location.href);
        store.setHistoryKey(historyKey);
        store.cacheSegmentsForHistory(historyKey, segments);

        store.emitUpdate({
          root: renderSegments(segments),
          metadata: payload.metadata,
        });
      }

      // Wait for RSC stream to fully close
      await streamComplete;
      store.setState({ isStreaming: false });
      console.log("[Browser] HMR: RSC stream complete");
    });
  }
}

initializeApp().catch((error) => {
  console.error("[Browser] Initialization error:", error);
});
