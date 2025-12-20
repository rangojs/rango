/**
 * Default virtual entry file contents for rsc-router.
 * These are used when users don't provide their own entry files.
 */

export const VIRTUAL_ENTRY_BROWSER: string = `
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

initializeApp().catch(console.error);
`.trim();

export const VIRTUAL_ENTRY_SSR: string = `
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";
import { createSSRHandler } from "rsc-router/ssr";

export const renderHTML = createSSRHandler({
  createFromReadableStream,
  renderToReadableStream,
  injectRSCPayload,
  loadBootstrapScriptContent: () =>
    import.meta.viteRsc.loadBootstrapScriptContent("index"),
});
`.trim();

export const VIRTUAL_ENTRY_RSC: string = `
import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
} from "@vitejs/plugin-rsc/rsc";
import { router } from "./router.js";
import { createRSCHandler } from "rsc-router/rsc";

export default createRSCHandler({
  router,
  deps: {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
  },
  loadSSRModule: () =>
    import.meta.viteRsc.loadModule("ssr", "index"),
});
`.trim();

/**
 * Virtual module IDs
 */
export const VIRTUAL_IDS = {
  browser: "virtual:rsc-router/entry.browser.tsx",
  ssr: "virtual:rsc-router/entry.ssr.tsx",
  rsc: "virtual:rsc-router/entry.rsc.tsx",
} as const;
