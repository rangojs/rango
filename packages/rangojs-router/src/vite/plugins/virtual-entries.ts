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
} from "@rangojs/router/internal/deps/browser";
import { createElement, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "@rangojs/router/internal/deps/html-stream-client";
import { initBrowserApp, RSCRouter } from "@rangojs/router/browser";

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
import { createFromReadableStream } from "@rangojs/router/internal/deps/ssr";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "@rangojs/router/internal/deps/html-stream-server";
import { createSSRHandler } from "@rangojs/router/ssr";

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
  decodeAction,
  decodeFormState,
} from "@rangojs/router/internal/deps/rsc";
import { router } from "${routerPath}";
import { createRSCHandler } from "@rangojs/router/internal/rsc-handler";
import { VERSION } from "@rangojs/router:version";

// Import loader manifest to ensure all fetchable loaders are registered at startup
// This is critical for serverless/multi-process deployments where the loader module
// might not be imported before a GET request arrives
import "virtual:rsc-router/loader-manifest";

// Import pre-generated route manifest so href() works immediately on cold start.
// In build mode, this contains the full route map generated at build time.
// In dev mode, this is a no-op (manifest is populated in-memory by the discovery plugin).
import "virtual:rsc-router/routes-manifest";

// Lazily create the handler on first request so that ESM live bindings
// have resolved by the time we read \`router\`. During HMR the module may
// re-evaluate before router.tsx finishes, leaving the import undefined.
let _handlerPromise;
let _handler;
export default async function handler(request, env) {
  if (!_handler) {
    if (!_handlerPromise) {
      _handlerPromise = createRSCHandler({
        router,
        version: VERSION,
        deps: {
          renderToReadableStream,
          decodeReply,
          createTemporaryReferenceSet,
          loadServerAction,
          decodeAction,
          decodeFormState,
        },
        loadSSRModule: () =>
          import.meta.viteRsc.loadModule("ssr", "index"),
      });
    }
    _handler = await _handlerPromise;
  }
  return _handler(request, env);
}
`.trim();
}

/**
 * Virtual module IDs
 */
export const VIRTUAL_IDS = {
  browser: "virtual:rsc-router/entry.browser.js",
  ssr: "virtual:rsc-router/entry.ssr.js",
  rsc: "virtual:rsc-router/entry.rsc.js",
  version: "@rangojs/router:version",
} as const;

/**
 * Virtual module content for version.
 * Exports VERSION - a timestamp that changes on server restart (dev) or at build time (production).
 */
export function getVirtualVersionContent(version: string): string {
  return `export const VERSION = ${JSON.stringify(version)};`;
}
