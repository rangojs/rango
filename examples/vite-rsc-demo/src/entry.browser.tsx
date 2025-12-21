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
import { initBrowserApp, RSCRouter } from "rsc-router/browser";

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

  // Initialize the RSC router (loads payload, sets up bridges)
  await initBrowserApp({ rscStream, deps });

  // Hydrate with full control over StrictMode and root element
  const root = document.getElementById("root") || document;
  hydrateRoot(
    root,
    <React.StrictMode>
      <RSCRouter />
    </React.StrictMode>
  );

  console.log("[Browser] Hydrated\n");
}

initializeApp().catch((error) => {
  console.error("[Browser] Initialization error:", error);
});
