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

/**
 * Virtual modules an RSC entry must import at startup to register the data the
 * request handler needs before the first request arrives:
 *
 * - routes-manifest: the pre-generated route map so href()/matching work on a
 *   cold start (full map in build, in-memory no-op in dev).
 * - loader-manifest: setLoaderImports() for fetchable loaders. Critical for
 *   serverless/multi-process deployments and for fetchable loaders reachable
 *   only through a client component — without it those loaders are never
 *   registered for the _rsc_loader endpoint and fail in production.
 *
 * Single source of truth: both the generated virtual RSC entry below and the
 * custom-entry injector (version-injector) consume this list, so a new
 * bootstrap manifest cannot be added to one path and forgotten on the other.
 * That exact drift (loader-manifest present here but missing from the injector)
 * is what left fetchable loaders unresolved on custom worker entries.
 */
export const RSC_ENTRY_BOOTSTRAP_IMPORTS: readonly string[] = [
  "virtual:rsc-router/routes-manifest",
  "virtual:rsc-router/loader-manifest",
];

export function getVirtualEntryRSC(routerPath: string): string {
  const bootstrapImports = RSC_ENTRY_BOOTSTRAP_IMPORTS.map(
    (id) => `import "${id}";`,
  ).join("\n");
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

// Startup bootstrap imports (routes + loader manifests). See
// RSC_ENTRY_BOOTSTRAP_IMPORTS — the same list the custom-entry injector uses.
${bootstrapImports}

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
