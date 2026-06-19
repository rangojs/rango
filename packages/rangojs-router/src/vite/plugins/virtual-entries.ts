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
import { initBrowserApp, Rango } from "@rangojs/router/browser";

async function initializeApp() {
  const deps = {
    createFromFetch,
    createFromReadableStream,
    encodeReply,
    setServerCallback,
    createTemporaryReferenceSet,
  };

  // initBrowserApp resolves the initial payload and returns the browser app
  // context, including strictMode (default true) from createRouter. StrictMode
  // is the default; createRouter({ strictMode: false }) ships the opt-out in the
  // payload metadata. StrictMode emits no DOM, so toggling never changes markup.
  const { strictMode } = await initBrowserApp({ rscStream, deps });

  const app = createElement(Rango);
  hydrateRoot(
    document,
    strictMode === false ? app : createElement(StrictMode, null, app)
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
let _handler;
export default function handler(request, env) {
  if (!_handler) {
    _handler = createRSCHandler({
      router,
      version: VERSION,
      // Forward the router's CSP nonce provider. createRSCHandler reads the
      // provider only from options.nonce; without this, createRouter({ nonce })
      // is silently dropped on the Node preset (the Cloudflare path wires it via
      // router.fetch). router.nonce is undefined when unconfigured, a safe no-op.
      nonce: router.nonce,
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
  return _handler(request, env);
}
`.trim();
}

export const VIRTUAL_IDS = {
  browser: "virtual:rsc-router/entry.browser.js",
  ssr: "virtual:rsc-router/entry.ssr.js",
  rsc: "virtual:rsc-router/entry.rsc.js",
  version: "@rangojs/router:version",
} as const;

export function getVirtualVersionContent(version: string): string {
  return `export const VERSION = ${JSON.stringify(version)};`;
}
