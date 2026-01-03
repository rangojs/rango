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
} from "rsc-router/internal/deps/browser";
import { createElement, StrictMode } from "react";
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
    createElement(StrictMode, null, createElement(RSCRouter))
  );
}

initializeApp().catch(console.error);
`.trim();

export const VIRTUAL_ENTRY_SSR: string = `
import { createFromReadableStream } from "rsc-router/internal/deps/ssr";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-router/internal/deps/html-stream-server";
import { createSSRHandler } from "rsc-router/ssr";

export const renderHTML = createSSRHandler({
  createFromReadableStream,
  renderToReadableStream,
  injectRSCPayload,
  loadBootstrapScriptContent: () =>
    import.meta.viteRsc.loadBootstrapScriptContent("index"),
});
`.trim();

/**
 * Generate the RSC entry content with the specified router path
 */
export function getVirtualEntryRSC(routerPath: string): string {
  return `
import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
} from "rsc-router/internal/deps/rsc";
import { router } from "${routerPath}";
import { createRSCHandler } from "rsc-router/rsc";

// Import loader manifest to ensure all fetchable loaders are registered at startup
// This is critical for serverless/multi-process deployments where the loader module
// might not be imported before a GET request arrives
import "virtual:rsc-router/loader-manifest";

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
}

/**
 * Virtual module IDs
 */
export const VIRTUAL_IDS = {
  browser: "virtual:rsc-router/entry.browser.js",
  ssr: "virtual:rsc-router/entry.ssr.js",
  rsc: "virtual:rsc-router/entry.rsc.js",
} as const;
