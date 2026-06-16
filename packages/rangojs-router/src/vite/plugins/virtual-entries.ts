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

  await initBrowserApp({ rscStream, deps });

  hydrateRoot(
    document,
    createElement(StrictMode, null, createElement(Rango))
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

export function getVirtualEntryRSCHost(hostEntryPath: string): string {
  return `
import * as __hostEntry from "${hostEntryPath}";
import { NoRouteMatchError } from "@rangojs/router/host";

// Register every sub-app's fetchable loaders + route manifests at startup, same
// as the single-router entry. Discovery's host fallback populates these for all
// mounted sub-apps, so the aggregate manifests cover the whole host tree.
import "virtual:rsc-router/loader-manifest";
import "virtual:rsc-router/routes-manifest";

// The host entry module must export the HostRouter instance (createHostRouter()),
// as a default export or a named \`hostRouter\`/\`router\` export. A Cloudflare-style
// \`export default { fetch }\` object is not a HostRouter and is rejected here.
const __defaultExport = __hostEntry.default;
const hostRouter =
  __defaultExport && typeof __defaultExport.match === "function"
    ? __defaultExport
    : __hostEntry.hostRouter ?? __hostEntry.router;

if (!hostRouter || typeof hostRouter.match !== "function") {
  throw new Error(
    "[rango] The host entry (${hostEntryPath}) must export a HostRouter instance for the node/vercel preset: a default export, or a named 'hostRouter'/'router' export (e.g. export default createHostRouter()). A Cloudflare-style 'export default { fetch }' object is not supported on this preset."
  );
}

// input = { env, ctx } from the launcher / node server. The host router threads
// it unchanged to each matched sub-app's handler and cache factory.
// On node/vercel rango owns this entry, so there is no user worker to translate
// an unmatched host into a response: catch NoRouteMatchError and return 404
// (parity with the documented Cloudflare catch). Other errors propagate.
export default async function handler(request, input) {
  try {
    return await hostRouter.match(request, input);
  } catch (err) {
    if (err instanceof NoRouteMatchError) {
      return new Response("Not Found", { status: 404 });
    }
    throw err;
  }
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
