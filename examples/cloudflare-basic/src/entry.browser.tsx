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
  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

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
}

initializeApp().catch((error) => {
  console.error("[Browser] Initialization error:", error);
});
