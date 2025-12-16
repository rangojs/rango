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
  createNavigationClient,
  createServerActionBridge,
  createNavigationBridge,
  createEventController,
  NavigationProvider,
  generateHistoryKey,
  type RscPayload,
  type ResolvedSegment,
} from "rsc-router/browser";

async function initializeApp() {
  const deps = {
    createFromFetch,
    createFromReadableStream,
    encodeReply,
    setServerCallback,
    createTemporaryReferenceSet,
  };

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);
  const initialSegments = (initialPayload.metadata?.segments ?? []) as ResolvedSegment[];
  const initialHistoryKey = generateHistoryKey(window.location.href);

  const store = createNavigationStore({
    initialLocation: window.location,
    initialSegmentIds: initialSegments.map((s) => s.id),
    initialHistoryKey,
    initialSegments,
  });

  const eventController = createEventController({
    initialLocation: new URL(window.location.href),
  });

  const client = createNavigationClient(deps);

  const actionBridge = createServerActionBridge({
    store,
    eventController,
    client,
    deps,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
  });
  actionBridge.register();

  const navigationBridge = createNavigationBridge({
    store,
    eventController,
    client,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments,
  });
  navigationBridge.registerLinkInterception();

  const initialTree = renderSegments(initialPayload.metadata!.segments);

  hydrateRoot(
    document,
    <React.StrictMode>
      <NavigationProvider
        store={store}
        eventController={eventController}
        initialPayload={{ ...initialPayload, root: initialTree }}
        bridge={navigationBridge}
      />
    </React.StrictMode>
  );

  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      const handle = eventController.startNavigation(window.location.href, { replace: true });
      handle.setStreaming();

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
          root: await renderSegments(segments),
          metadata: payload.metadata,
        });
      }

      await streamComplete;
      handle.complete(new URL(window.location.href));
    });
  }
}

initializeApp().catch((error) => {
  console.error("[Test App] Initialization error:", error);
});
