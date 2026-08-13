import type { HeadScriptsOption } from "../plugin-types.js";

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
  const { strictMode, initialPayload } = await initBrowserApp({ rscStream, deps });

  if (import.meta.hot) {
    const { startDevDiscoveryHandshake } = await import(
      "@rangojs/router/internal/browser/dev-discovery"
    );
    startDevDiscoveryHandshake(
      initialPayload.metadata?.devDiscoveryEpoch,
      import.meta.hot
    );
  }

  const app = createElement(Rango);
  hydrateRoot(
    document,
    strictMode === false ? app : createElement(StrictMode, null, app)
  );
}

initializeApp().catch(console.error);
`.trim();

/**
 * Generate the virtual SSR entry. `headScripts` mirrors the rango() plugin
 * option: "preinit" (default) installs the client-reference preinit hook and
 * lets the SSR handlers convert the bootstrap to `bootstrapModules`;
 * "preload" omits the hook and pins the handlers to the hint-only strategy.
 */
export function getVirtualEntrySSR(
  headScripts: HeadScriptsOption = "preinit",
  progressiveChunkSize?: number,
): string {
  const preinit = headScripts !== "preload";
  // The preload variant drops exactly three preinit-only lines, all built
  // here so the template below stays a single unconditional shape.
  const depsImportNames = preinit
    ? "createFromReadableStream,\n  setOnClientReference,"
    : "createFromReadableStream,";
  const ssrImportNames = preinit ? "\n  installClientReferencePreinit," : "";
  const install = preinit
    ? `
// Upgrade client-reference modulepreload hints to executing module scripts in
// the document head, for every render pass (live SSR, shell capture, resume).
// See src/ssr/preinit-client-references.ts for the full rationale.
installClientReferencePreinit(setOnClientReference);
`
    : "";
  const hs = JSON.stringify(headScripts);
  // Emitted into all three handlers: live SSR and shell capture consume it
  // directly; the resume handler receives it for dep-shape uniformity (resume()
  // itself inherits the capture value from the postponed state). Number
  // serialization is exact for every finite number incl. MAX_SAFE_INTEGER.
  const pcs =
    progressiveChunkSize !== undefined
      ? `\n  progressiveChunkSize: ${JSON.stringify(progressiveChunkSize)},`
      : "";
  return `
import {
  ${depsImportNames}
} from "@rangojs/router/internal/deps/ssr";
import { renderToReadableStream, resume } from "react-dom/server.edge";
import { prerender } from "react-dom/static.edge";
import { injectRSCPayload } from "@rangojs/router/internal/deps/html-stream-server";
import {
  createSSRHandler,
  createShellCaptureHandler,
  createShellResumeHandler,${ssrImportNames}
} from "@rangojs/router/ssr";
${install}
export const renderHTML = createSSRHandler({
  createFromReadableStream,
  renderToReadableStream,
  injectRSCPayload,
  headScripts: ${hs},${pcs}
  loadBootstrapScriptContent: () =>
    import.meta.viteRsc.loadBootstrapScriptContent("index"),
});

export const captureShellHTML = createShellCaptureHandler({
  createFromReadableStream,
  renderToReadableStream,
  injectRSCPayload,
  prerender,
  resume,
  headScripts: ${hs},${pcs}
  loadBootstrapScriptContent: () =>
    import.meta.viteRsc.loadBootstrapScriptContent("index"),
});

export const resumeShellHTML = createShellResumeHandler({
  createFromReadableStream,
  renderToReadableStream,
  injectRSCPayload,
  prerender,
  resume,
  headScripts: ${hs},${pcs}
  loadBootstrapScriptContent: () =>
    import.meta.viteRsc.loadBootstrapScriptContent("index"),
});
`.trim();
}

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

// Startup bootstrap imports (routes + loader manifests). See
// RSC_ENTRY_BOOTSTRAP_IMPORTS — the same list the custom-entry injector uses.
//
// ORDER IS LOAD-BEARING: the bootstrap imports MUST precede the router import.
// The routes-manifest module installs client URL projections
// (setClientUrlProjection), and createRouter().routes(clientUrlsReference)
// consults them at router-module evaluation. Router-first would silently push
// every clientUrls() app onto the deferred-subscription path and change mount
// registration order with no error. The custom-entry injector keeps the same
// guarantee by PREPENDING this list at file top (version-injector.ts).
${bootstrapImports}

import { router } from "${routerPath}";
import { createRSCHandler } from "@rangojs/router/internal/rsc-handler";
import { VERSION } from "@rangojs/router:version";

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

export function getVirtualEntryRSCHost(hostEntryPath: string): string {
  return `
import * as __hostEntry from "${hostEntryPath}";
import { isNoRouteMatchError } from "@rangojs/router/host";

// Register every sub-app's fetchable loaders + route manifests at startup, same
// as the single-router entry. Discovery's host fallback populates these for all
// mounted sub-apps, so the aggregate manifests cover the whole host tree.
import "virtual:rsc-router/loader-manifest";
import "virtual:rsc-router/routes-manifest";

// The host entry module must export the HostRouter instance (createHostRouter()),
// as a default export or a named \`hostRouter\`/\`router\` export. A Cloudflare-style
// \`export default { fetch }\` object is not a HostRouter and is rejected (on first
// request; see the lazy resolution below).
// We require BOTH .match() and .host(): a regular createRouter() also exposes
// .match(), so matching on .match() alone would accept an ordinary router and then
// return its MatchResult (not a Response) at runtime. .host() is unique to a
// HostRouter, so it disambiguates a mistaken \`hostRouter\` path.
// Exports are read dynamically (m[name]) so Rollup does not emit IMPORT_IS_UNDEFINED
// warnings for the named exports a default-only host module legitimately omits.
const __resolveHostRouter = (m) => {
  for (const name of ["default", "hostRouter", "router"]) {
    const candidate = m[name];
    if (
      candidate &&
      typeof candidate.match === "function" &&
      typeof candidate.host === "function"
    )
      return candidate;
  }
  return undefined;
};

// Resolve + validate the HostRouter lazily on first request, mirroring the
// single-router entry's \`_handler\`. During HMR the host module can re-evaluate
// before its createHostRouter() export has resolved; validating at module-
// evaluation time would then throw a spurious "must export a HostRouter" error
// overlay for a perfectly valid app. Resolving on first request lets the live
// binding settle first.
let _hostRouter;

// input = { env, ctx } from the launcher / node server. The host router threads
// it unchanged to each matched sub-app's handler and cache factory.
// On node/vercel rango owns this entry, so there is no user worker to translate
// an unmatched host into a response: catch NoRouteMatchError and return 404
// (parity with the documented Cloudflare catch). Other errors propagate.
export default async function handler(request, input) {
  if (!_hostRouter) {
    _hostRouter = __resolveHostRouter(__hostEntry);
    if (!_hostRouter) {
      throw new Error(
        "[rango] The host entry (${hostEntryPath}) must export a HostRouter instance (createHostRouter()) for the node/vercel preset: a default export, or a named 'hostRouter'/'router' export. An ordinary createRouter() is not a host router (it has no .host()), and a Cloudflare-style 'export default { fetch }' object is not supported on this preset."
      );
    }
  }
  try {
    return await _hostRouter.match(request, input);
  } catch (err) {
    // isNoRouteMatchError also matches by name: a workspace with a duplicated
    // @rangojs/router copy can throw a NoRouteMatchError whose prototype differs
    // from this module's import, so a bare instanceof would turn an
    // unmatched-host 404 into a 500.
    if (isNoRouteMatchError(err)) {
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
