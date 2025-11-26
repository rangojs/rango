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
  type RscPayload,
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

  // Create navigation store
  const store = createNavigationStore({
    initialLocation: window.location,
    initialSegmentIds:
      initialPayload.metadata?.segments?.map((s) => s.id) ?? [],
  });

  // Store initial segments for partial rendering
  initialPayload.metadata?.segments?.forEach((segment) => {
    console.log(`[Browser] Storing initial segment: ${segment.id}`);
    store.storeSegment(segment);
  });

  console.log(
    "[Browser] Initial segments:",
    store.getSegmentState().currentSegmentIds.join(", ")
  );
  console.log(
    `[Browser] Stored ${store.getSegmentState().storedSegments.size} segments for partial rendering`
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
