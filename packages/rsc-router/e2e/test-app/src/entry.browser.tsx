import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  encodeReply,
  createTemporaryReferenceSet,
} from "rsc-router/internal/deps/browser";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-router/internal/deps/html-stream-client";
import { initBrowserApp, RSCRouter } from "rsc-router/browser";

async function initializeApp() {
  const deps = {
    createFromFetch,
    createFromReadableStream,
    encodeReply,
    setServerCallback,
    createTemporaryReferenceSet,
  };

  await initBrowserApp({ rscStream, deps });

  hydrateRoot(
    document,
    <React.StrictMode>
      <RSCRouter />
    </React.StrictMode>
  );
}

initializeApp().catch((error) => {
  console.error("[Test App] Initialization error:", error);
});
