/**
 * The discovery temp RSC server: a minimal Vite server whose module runner
 * imports the user's router files. Shared by dev discovery
 * (discovery/dev-server-phase.ts) and build discovery
 * (discovery/build-discovery-phase.ts).
 *
 * Sits in src/vite/, not src/vite/discovery/: the loader hook URL below
 * resolves against this module's import.meta.url, and the published bundle
 * (dist/vite/index.js) ships the hook at the same relative path.
 */

import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";
import { register } from "node:module";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import { getVirtualEntrySSR } from "./plugins/virtual-entries.js";
import { createVirtualStubPlugin } from "./plugins/virtual-stub-plugin.js";
import { createCloudflareProtocolStubPlugin } from "./plugins/cloudflare-protocol-stub.js";
import {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.js";
import { hashClientRefs } from "./plugins/client-ref-hashing.js";
import { hashServerRefs } from "./plugins/server-ref-hashing.js";
import { defineEncryptionKeyExpr } from "./encryption-key.js";
import type { DiscoveryState } from "./discovery/state.js";
import { recordClientUrlsModule } from "./discovery/client-urls-projection.js";
import { transitionWhenHoistPlugin } from "./plugins/transition-when-hoist.js";
import { clientUrlsRevalidateHoistPlugin } from "./plugins/client-urls-revalidate-hoist.js";

// ============================================================================
// Node ESM Loader Hook Registration
// ============================================================================

/**
 * Registers a Node ESM loader hook that resolves `cloudflare:*` specifiers
 * to a data: URL stub. Defense-in-depth alongside the Vite transform in
 * `cloudflare-protocol-stub.ts`:
 *
 * - The Vite transform catches `cloudflare:*` imports in modules that flow
 *   through Vite's plugin pipeline. That's the vast majority of cases.
 * - The Node loader catches imports in modules that Vite/Rollup externalize
 *   (e.g. the `partyserver` package, which has a top-level
 *   `import { DurableObject, env } from "cloudflare:workers"` and ships
 *   shapes plugin-rsc marks as external). Externalized modules are loaded
 *   via Node's native ESM loader, which rejects URL schemes.
 *
 * Registration is process-global and one-shot. The hook only intercepts
 * `cloudflare:*` specifiers; everything else passes through via
 * `nextResolve()`. It runs in a separate worker thread (Node ESM loader
 * architecture), so it can't read the `globalThis[BUILD_ENV_GLOBAL_KEY]`
 * bridge that the Vite transform uses — the stubs served here always
 * return `env = {}`. That's fine because externalized libraries don't
 * typically access `env` at module top level; user source (where real
 * `env` matters at build time) flows through the Vite transform.
 */
let loaderHookRegistered = false;
function ensureCloudflareProtocolLoaderRegistered(): void {
  if (loaderHookRegistered) return;
  loaderHookRegistered = true;
  try {
    register(
      new URL("./plugins/cloudflare-protocol-loader-hook.mjs", import.meta.url),
    );
  } catch (err: any) {
    // register() requires Node 18.19+ / 20.6+. Older Node still has the
    // Vite transform as primary defense.
    console.warn(
      `[rango] Could not register Node ESM loader hook for cloudflare:* imports (${err?.message ?? err}). Falling back to Vite transform only.`,
    );
  }
}

// ============================================================================
// Temp Server Factory
// ============================================================================

/**
 * Create a minimal Vite server for router discovery.
 *
 * Both dev-mode prerender and build-mode discovery need a temp RSC server
 * to import user router files via module runner. This factory centralizes
 * the shared config and the mode-specific differences:
 * - Dev: path-based IDs (no forceBuild), separate cacheDir
 * - Build: hashed IDs (forceBuild), hashClientRefs for production bundles
 *
 * Returns the ViteDevServer instance. Callers access .environments.rsc as needed.
 * @internal Exported for tests.
 */
export async function createTempRscServer(
  state: DiscoveryState,
  options: {
    forceBuild?: boolean;
    cacheDir?: string;
    /**
     * Serve the REAL rango SSR entry (getVirtualEntrySSR) for
     * "virtual:entry-ssr" instead of the discovery stub, so the dev
     * /__rsc_shell endpoint can drive captureShellHTML in this server's SSR
     * realm. Dev-correct by construction: the entry's bootstrap resolves to
     * plugin-rsc's stable virtual browser-entry URL, which the MAIN dev
     * server serves to the browser. Loaded lazily — discovery never imports
     * the SSR entry, so the temp server stays as light as before until a
     * shell capture actually runs.
     */
    realSsrEntry?: boolean;
  } = {},
): Promise<ViteDevServer> {
  // Install the Node ESM loader hook before any module evaluation so
  // `cloudflare:*` specifiers in externalized/loader-delegated modules
  // (e.g. packages plugin-rsc marks as external) resolve to stubs
  // instead of crashing Node's native loader.
  ensureCloudflareProtocolLoaderRegistered();
  const { default: rsc } = await import("@vitejs/plugin-rsc");
  // Mirror the user's resolution config + plugins so discovery (and the
  // prerender/static rendering that shares this runner) resolves modules the
  // same way the real environment does. Falls back to the legacy alias-only
  // behavior if configResolved hasn't populated the parity slice yet.
  const runnerConfig = state.userRunnerConfig;
  const resolveConfig = runnerConfig?.resolve ?? {
    alias: state.userResolveAlias,
  };
  const oxcConfig = runnerConfig?.oxc ?? {
    jsx: { runtime: "automatic", importSource: "react" },
  };
  return createViteServer({
    root: state.projectRoot,
    configFile: false,
    server: {
      middlewareMode: true,
      // Build mode: no file watching. buildStart installs the per-router tries
      // into this realm and runShellPrerenderPhase reuses it after the bundles
      // are written. A watched write in between (writeRouteTypesFiles' own
      // <router>.named-routes.gen.ts, which every router file imports) can
      // make Vite full-reload the RSC runner; the shell phase then matches in
      // a fresh realm with no tries and a root path("/*") wins (#947).
      ...(options.forceBuild ? { watch: null } : {}),
    },
    appType: "custom",
    logLevel: "silent",
    resolve: resolveConfig,
    ...(runnerConfig?.define ? { define: runnerConfig.define } : {}),
    oxc: oxcConfig as any,
    ...(options.cacheDir && { cacheDir: options.cacheDir }),
    plugins: [
      rsc({
        entries: {
          client: "virtual:entry-client",
          ssr: "virtual:entry-ssr",
          rsc: state.resolvedEntryPath!,
        },
        // The temp server renders Static/Prerender output and encrypts inline-
        // action bound args. Give it the SAME key as the main build/dev runtime
        // (defineEncryptionKeyExpr is process-cached) so those args decrypt at
        // invocation. Unconditional, NOT build-only: under Cloudflare/workerd dev
        // the RSC env has no module runner, so prerender is rendered by THIS temp
        // server (via /__rsc_prerender), and the action decrypts in the main
        // runtime with the rango.ts key -- gating on forceBuild left dev encrypting
        // with the temp server's own random key, failing decryptActionBoundArgs.
        // (hashServerRefs stays build-only: dev keeps dev-style ids the dev runtime
        // resolves directly.)
        defineEncryptionKey: defineEncryptionKeyExpr(),
      }),
      // hashClientRefs/hashServerRefs only in build mode — production bundles
      // need hashed refs. hashServerRefs is the server-side analog: it rewrites
      // registerServerReference dev-style ids to production hashes so a
      // server-created action embedded in prerendered/static Flight resolves
      // against the production manifest on a build-time-cache hit.
      ...(options.forceBuild
        ? [hashClientRefs(state.projectRoot), hashServerRefs(state.projectRoot)]
        : []),
      createVersionPlugin(),
      // Before the stub plugin, so "virtual:entry-ssr" resolves to the real
      // SSR entry when the shell endpoint needs it (see the option doc).
      ...(options.realSsrEntry
        ? [
            {
              name: "@rangojs/router:temp-real-ssr-entry",
              enforce: "pre" as const,
              resolveId(id: string) {
                return id === "virtual:entry-ssr"
                  ? "\0rango-temp-real-ssr-entry"
                  : null;
              },
              load(id: string) {
                return id === "\0rango-temp-real-ssr-entry"
                  ? getVirtualEntrySSR(
                      state.opts?.headScripts,
                      state.opts?.progressiveChunkSize,
                    )
                  : null;
              },
            } satisfies import("vite").Plugin,
          ]
        : []),
      createVirtualStubPlugin(),
      createCloudflareProtocolStubPlugin(),
      // Inline transition({ when }) literals become client references here
      // too, or discovery would see (and reject) the plain function.
      transitionWhenHoistPlugin(),
      // clientUrls() revalidate() predicates move to the server here too:
      // discovery serializes the SSR copy's markers and the RSC realm
      // registers the predicates the materialized stubs call. The index is
      // the main plugin's, so its group modules import the files assigned here.
      ...clientUrlsRevalidateHoistPlugin(state.clientUrlRevalidate),
      // Dev prerender must use dev-mode IDs (path-based) to match the workerd
      // runtime. forceBuild produces hashed IDs for production bundle consistency.
      exposeInternalIds(options.forceBuild ? { forceBuild: true } : undefined),
      exposeRouterId(),
      {
        name: "@rangojs/router:client-urls-source-tracking",
        enforce: "pre",
        transform(code, id) {
          recordClientUrlsModule(state, code, id);
        },
      },
      // Forwarded user resolution plugins (e.g. vite-tsconfig-paths). Stripped
      // to resolveId/load (plus transform for import rewriters, see
      // IMPORT_REWRITE_PLUGINS) and placed last so framework resolution runs first;
      // Vite re-sorts by `enforce`, so `enforce: "pre"` resolvers still lead.
      ...state.userResolvePlugins,
    ],
  });
}
