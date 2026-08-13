/**
 * Router Discovery Plugin
 *
 * Vite plugin that discovers router instances at dev/build time via the RSC
 * environment. Delegates to extracted modules for discovery, route types
 * generation, virtual module codegen, and bundle post-processing.
 */

import type { Plugin } from "vite";
import { createServer as createViteServer } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import {
  formatNestedRouterConflictError,
  findNestedRouterConflict,
  findRouterFiles,
  createScanFilter,
} from "../build/generate-route-types.js";
import { firstCodeMatchIndex } from "../build/route-types/source-scan.js";
import {
  DEV_DISCOVERY_EPOCH_HEADER,
  DEV_DISCOVERY_PROBE_HEADER,
  DEV_DISCOVERY_QUERY_EVENT,
  DEV_DISCOVERY_READY_EVENT,
} from "../dev-discovery-protocol.js";
import {
  DEV_SHELL_PROBE_TIMEOUT_MS,
  normalizeCaptureTimeout,
} from "../rsc/shell-serve.js";
import {
  injectClientDebugFlag,
  internalDebugNoCacheMiddleware,
} from "./inject-client-debug.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import { getVirtualEntrySSR, VIRTUAL_IDS } from "./plugins/virtual-entries.js";
import { createVirtualStubPlugin } from "./plugins/virtual-stub-plugin.js";
import {
  BUILD_ENV_GLOBAL_KEY,
  createCloudflareProtocolStubPlugin,
} from "./plugins/cloudflare-protocol-stub.js";
import {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.js";
import { hashClientRefs } from "./plugins/client-ref-hashing.js";
import { hashServerRefs } from "./plugins/server-ref-hashing.js";
import { defineEncryptionKeyExpr } from "./encryption-key.js";
import { extractHandlerExportsFromChunk } from "./utils/bundle-analysis.js";
import {
  createDiscoveryState,
  VIRTUAL_ROUTES_MANIFEST_ID,
  type DiscoveryState,
  type PluginOptions,
} from "./discovery/state.js";
import {
  consumeSelfGenWrite,
  peekSelfGenWrite,
} from "./discovery/self-gen-tracking.js";
import { discoverRouters } from "./discovery/discover-routers.js";
import {
  recordClientUrlsModule,
  refreshRecordedClientUrlProjections,
} from "./discovery/client-urls-projection.js";
import { runShellPrerenderPhase } from "./discovery/shell-prerender-phase.js";
import { describeDiscoveryFailure } from "./discovery/discovery-errors.js";
import {
  createDevPrerenderCache,
  devPrerenderCacheKey,
  payloadBodiesFromResult,
} from "./discovery/dev-prerender-cache.js";
import {
  writeCombinedRouteTypesWithTracking,
  writeRouteTypesFiles,
  supplementGenFilesWithRuntimeRoutes,
} from "./discovery/route-types-writer.js";
import {
  generateRoutesManifestModule,
  generatePerRouterModule,
} from "./discovery/virtual-module-codegen.js";
import { postprocessBundle } from "./discovery/bundle-postprocess.js";
import { createDiscoveryGate } from "./discovery/gate-state.js";
import { resetStagedBuildAssets } from "./utils/prerender-utils.js";
import { resolveRscEntryFromConfig } from "./utils/shared-utils.js";
import {
  pickForwardedRunnerConfig,
  selectForwardableResolvePlugins,
} from "./utils/forward-user-plugins.js";
import { createRangoDebugger, timed, timedSync, NS } from "./debug.js";

const debugDiscovery = createRangoDebugger(NS.discovery);
const debugRoutes = createRangoDebugger(NS.routes);
const debugBuild = createRangoDebugger(NS.build);
const debugDev = createRangoDebugger(NS.dev);

export { VIRTUAL_ROUTES_MANIFEST_ID };

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
 * Outcome of getOrCreateTempServer. `env` is the temp RSC environment on
 * success, else null with `error` carrying WHY the create/import failed — or
 * null when createServer resolved cleanly but attached no runner (terminal, but
 * not an exception). The dev /__rsc_shell endpoint runs `error` through the
 * SAME reoptimization classifier the import sites use: only a transient Vite
 * re-optimization is signalled NOT-READY (client re-polls); every terminal
 * failure fails fast so the read-through MISSes immediately instead of
 * re-polling a permanently-broken realm for the full readiness deadline
 * (issue #719 P2).
 */
type TempServerResult = { env: any; error: unknown };

/**
 * Test-only one-shot boot-race injection (issue #719 P3). When
 * RANGO_E2E_INJECT_SHELL_NOTREADY=1, the dev /__rsc_shell endpoint emits a
 * single reoptimization-class NOT-READY per pathname before serving, so an e2e
 * can drive the REAL endpoint + real client re-poll deterministically — a
 * natural cold race settles too fast on quick machines to guard the regression.
 * Keyed per pathname so the read-through's re-poll finds it already fired and
 * gets the HIT. Never engaged without the env flag.
 */
const injectedShellNotReadyPaths = new Set<string>();

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
 */
async function createTempRscServer(
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
) {
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
    server: { middlewareMode: true },
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
      // to resolveId/load and placed last so framework resolution runs first;
      // Vite re-sorts by `enforce`, so `enforce: "pre"` resolvers still lead.
      ...state.userResolvePlugins,
    ],
  });
}

// ============================================================================
// Build-Time Env Resolution
// ============================================================================

import type {
  BuildEnvOption,
  BuildEnvFactoryContext,
  BuildEnvResult,
} from "./plugin-types.js";

/**
 * Resolve the buildEnv option into a concrete { env, dispose? } result.
 * Handles all four input shapes: false, "auto", factory, plain object.
 */
async function resolveBuildEnv(
  option: BuildEnvOption | undefined,
  factoryCtx: BuildEnvFactoryContext,
): Promise<BuildEnvResult | null> {
  if (!option) return null;

  if (option === "auto") {
    if (factoryCtx.preset !== "cloudflare") {
      throw new Error(
        '[rango] buildEnv: "auto" is only supported with preset: "cloudflare". ' +
          "Use a factory function or plain object for other presets.",
      );
    }
    try {
      // Resolve wrangler from the user's project root (not the router package)
      const userRequire = createRequire(
        resolve(factoryCtx.root, "package.json"),
      );
      const wranglerPath = userRequire.resolve("wrangler");
      const { getPlatformProxy } = (await import(
        pathToFileURL(wranglerPath).href
      )) as {
        getPlatformProxy: (opts?: any) => Promise<any>;
      };
      const proxy = await getPlatformProxy();
      return {
        env: proxy.env as Record<string, unknown>,
        dispose: proxy.dispose,
      };
    } catch (err: any) {
      throw new Error(
        '[rango] buildEnv: "auto" requires wrangler to be installed.\n' +
          `Install it with: pnpm add -D wrangler\n${err.message}`,
      );
    }
  }

  if (typeof option === "function") {
    return await option(factoryCtx);
  }

  // Plain object
  return { env: option };
}

/**
 * Acquire build-time env bindings and store on discovery state.
 * Returns true if env was acquired, false if buildEnv is disabled.
 */
async function acquireBuildEnv(
  s: DiscoveryState,
  command: "serve" | "build",
  mode: string,
): Promise<boolean> {
  const option = s.opts?.buildEnv;
  if (!option) return false;

  const result = await resolveBuildEnv(option, {
    root: s.projectRoot,
    mode,
    command,
    preset: s.opts?.preset ?? "node",
  });
  if (!result) return false;

  s.resolvedBuildEnv = result.env;
  s.buildEnvDispose = result.dispose ?? null;
  // Bridge the resolved env into `cloudflare:workers`'s stubbed `env`
  // export so user code that does `import { env } from "cloudflare:workers"`
  // sees the real bindings proxy during discovery + prerender instead of
  // an empty object. The stub reads this global at module-evaluation time.
  (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY] = result.env;
  return true;
}

/**
 * Reset the per-build prerender collection state. A helper (not inline
 * assignments in buildStart) so TS's property narrowing does not pin
 * `s.shellCandidates` to `null` across the discovery call that repopulates
 * it — the finally block re-reads it to decide the temp-server keep-alive.
 */
function resetPrerenderCollection(s: DiscoveryState): void {
  s.prerenderManifestEntries = null;
  s.staticManifestEntries = null;
  s.shellCandidates = null;
  s.prerenderPayloadValues = null;
}

/**
 * Release build-time env resources and clear state.
 */
async function releaseBuildEnv(s: DiscoveryState): Promise<void> {
  if (s.buildEnvDispose) {
    try {
      await s.buildEnvDispose();
    } catch (err: any) {
      console.warn(`[rango] buildEnv dispose failed: ${err.message}`);
    }
    s.buildEnvDispose = null;
  }
  s.resolvedBuildEnv = undefined;
  delete (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY];
}

/**
 * Plugin that discovers router instances at dev/build time via the RSC environment.
 *
 * Uses `server.environments.rsc.runner.import()` to load the user's router file
 * with full TS/TSX compilation. This triggers `createRouter()` which populates
 * the `RouterRegistry`. The plugin then generates manifests for each router.
 *
 * In dev mode, this runs in `configureServer` (post-middleware setup).
 * In build mode, this will run in `buildStart` (future).
 *
 * @internal
 */
export function createRouterDiscoveryPlugin(
  entryPath: string | undefined,
  opts?: PluginOptions,
): Plugin {
  const s = createDiscoveryState(entryPath, opts);
  let viteCommand: "serve" | "build" = "build";
  let viteMode = "production";

  return {
    name: "@rangojs/router:discovery",

    // Make INTERNAL_RANGO_DEBUG reach the CLIENT debug logs by just setting the
    // env var. See injectClientDebugFlag: bakes the resolved flag into the
    // internal-debug module so FE debug no longer depends on Vite delivering the
    // `__RANGO_DEBUG__` define to the client (which it does only as an injected
    // global whose presence varies across consumer setups). Runs in dev and build.
    transform: {
      order: "pre",
      handler(code, id) {
        recordClientUrlsModule(s, code, id);
        return injectClientDebugFlag(id);
      },
    },

    configResolved(config) {
      s.projectRoot = config.root;
      // Compile the optional discovery scan filter (glob include/exclude) now
      // that the project root is known. findRouterFiles() below — and the
      // build/HMR rediscovery paths — honor s.scanFilter.
      s.scanFilter = opts?.discovery
        ? createScanFilter(s.projectRoot, opts.discovery)
        : undefined;
      s.isBuildMode = config.command === "build";
      viteCommand = config.command as "serve" | "build";
      viteMode = config.mode;
      // Capture user's resolve aliases for the temp server
      s.userResolveAlias = config.resolve.alias;
      // Capture the data-only resolution config (resolve.*, define, oxc) and
      // the user's resolution plugins (resolveId/load) so the discovery temp
      // server resolves modules the same way the real environment does.
      // Without this, both flavors of user resolution are absent during
      // discovery/prerender/static rendering even though they apply at request
      // time: third-party resolvers (e.g. vite-tsconfig-paths, forwarded as
      // plugins) and Vite 8's native resolve.tsconfigPaths (forwarded in the
      // data slice). See utils/forward-user-plugins.ts.
      s.userRunnerConfig = pickForwardedRunnerConfig(config);
      s.userResolvePlugins = selectForwardableResolvePlugins(
        config.plugins as any,
      );
      // Node preset: pick up auto-discovered router path from the config() hook.
      // The auto-discover plugin runs in config() using Vite's resolved root,
      // populating the mutable ref before configResolved fires.
      if (!s.resolvedEntryPath && opts?.routerPathRef?.path) {
        s.resolvedEntryPath = opts.routerPathRef.path;
      }
      // Cloudflare preset: entry comes from the resolved RSC env config.
      if (!s.resolvedEntryPath) {
        const entry = resolveRscEntryFromConfig(config);
        if (entry) s.resolvedEntryPath = entry;
      }
      // Generate combined named-routes.gen.ts from static source parsing.
      // Runs before the dev server starts so the gen file exists immediately for IDE.
      // In build mode, the runtime discovery in buildStart produces the definitive
      // named-routes.gen.ts (including dynamically generated routes).
      // preserveIfLarger prevents overwriting a previously generated complete
      // file with a partial one.
      if (opts?.staticRouteTypesGeneration !== false) {
        s.cachedRouterFiles = findRouterFiles(s.projectRoot, s.scanFilter);
        writeCombinedRouteTypesWithTracking(s, { preserveIfLarger: true });
      }
      // Resolve prerenderHandlerModules and staticHandlerModules from the consolidated IDs plugin's API.
      if (opts?.enableBuildPrerender) {
        const idsPlugin = config.plugins.find(
          (p: any) => p.name === "@rangojs/router:expose-internal-ids",
        );
        s.resolvedPrerenderModules = (
          idsPlugin?.api as any
        )?.prerenderHandlerModules;
        s.resolvedStaticModules = (idsPlugin?.api as any)?.staticHandlerModules;
      }
    },

    // Dev mode: discover routers and populate manifest in memory.
    // Skipped in build mode (buildStart handles it).
    configureServer(server) {
      if (s.isBuildMode) return;
      // Skip if this is a temp server created by buildStart
      if ((globalThis as any).__rscRouterDiscoveryActive) return;
      s.devServer = server;

      let workerReadyEpoch: number | undefined;
      const publishDevDiscoveryReady = (epoch: number) => {
        if (epoch <= (workerReadyEpoch ?? -1)) return;
        workerReadyEpoch = epoch;
        (server.environments as any)?.client?.hot?.send({
          type: "custom",
          event: DEV_DISCOVERY_READY_EVENT,
          data: { epoch },
        });
        debugDiscovery?.("hmr: workerd ready at epoch %d", epoch);
      };
      if (opts?.preset === "cloudflare") {
        const registeredClientHotChannels = new Set<any>();
        const registerDevDiscoveryHotChannels = () => {
          const clientHot = (server.environments as any)?.client?.hot;
          if (clientHot && !registeredClientHotChannels.has(clientHot)) {
            registeredClientHotChannels.add(clientHot);
            clientHot.on(
              DEV_DISCOVERY_QUERY_EVENT,
              (_payload: unknown, client: any) => {
                if (workerReadyEpoch === undefined) return;
                client.send(DEV_DISCOVERY_READY_EVENT, {
                  epoch: workerReadyEpoch,
                });
              },
            );
          }
          debugDiscovery?.(
            "hmr: dev discovery browser channel registered (client=%s)",
            !!clientHot,
          );
        };

        registerDevDiscoveryHotChannels();
        if (server.httpServer && !server.httpServer.listening) {
          server.httpServer.once("listening", registerDevDiscoveryHotChannels);
        }
      }

      // Serve the internal-debug module no-cache: consumers resolve it into
      // node_modules, where dev's immutable `?v=` caching pinned browsers to a
      // stale baked INTERNAL_RANGO_DEBUG. See internalDebugNoCacheMiddleware.
      server.middlewares.use(internalDebugNoCacheMiddleware());

      // Discovery promise that the handler can await if requests arrive
      // before discovery completes
      let resolveDiscovery: () => void;
      const discoveryPromise = new Promise<void>((resolve) => {
        resolveDiscovery = resolve;
      });

      // Manifest-readiness gate + rediscovery scheduler.
      // The virtual:rsc-router/routes-manifest module's `load()` hook
      // awaits `s.discoveryDone`; the gate is reset on each discovery
      // cycle so workerd's HMR reloads block until the new gen file is
      // written. State machine + transitions are extracted into
      // ./discovery/gate-state.ts and unit-tested there — see the
      // module's JSDoc for the four-flag contract.
      const gate = createDiscoveryGate(s, debugDiscovery);
      const beginDiscoveryGate = gate.beginGate;
      const resolveDiscoveryGate = gate.resolveGate;

      // Compute dev server origin from resolved URLs (preferred) or config port (fallback).
      // Called after discovery (or in the load hook) when the server may be listening.
      const getDevServerOrigin = () =>
        server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ||
        `http://localhost:${server.config.server.port || 5173}`;
      let devServerClosed = false;

      // Shared temp server for Cloudflare dev (no module runner in workerd).
      // Used by both discover() (route type generation) and the prerender
      // middleware (on-demand prerender evaluation). Created lazily, closed on
      // server shutdown.
      let prerenderTempServer: any = null;
      let prerenderNodeRegistry: Map<string, any> | null = null;

      // Clean up the temporary server and build env when the dev server shuts down
      server.httpServer?.on("close", () => {
        devServerClosed = true;
        if (prerenderTempServer) {
          prerenderTempServer.close().catch(() => {});
          prerenderTempServer = null;
        }
        releaseBuildEnv(s).catch(() => {});
      });

      // Mirror the build-path contract (the buildStart hook below, which sets
      // __rscRouterDiscoveryActive before running user modules):
      // set __rscRouterDiscoveryActive before running user modules so any
      // module-level router.reverse() calls return a placeholder instead
      // of throwing. The temp Vite server's module runner has its own
      // module context; the flag must be on globalThis to cross that
      // boundary. Cleared in finally so the dev request handlers run with
      // strict reverse() semantics afterwards.
      async function importEntryAndRegistry(tempRscEnv: any): Promise<void> {
        const flagAlreadySet = !!(globalThis as any).__rscRouterDiscoveryActive;
        if (!flagAlreadySet) {
          (globalThis as any).__rscRouterDiscoveryActive = true;
        }
        try {
          debugDiscovery?.(
            "importEntryAndRegistry: importing entry (flag=%s)",
            (globalThis as any).__rscRouterDiscoveryActive ?? false,
          );
          await tempRscEnv.runner.import(s.resolvedEntryPath!);
          debugDiscovery?.(
            "importEntryAndRegistry: entry import OK, fetching RouterRegistry",
          );
          const serverMod = await tempRscEnv.runner.import(
            "@rangojs/router/server",
          );
          prerenderNodeRegistry = serverMod.RouterRegistry;
          debugDiscovery?.(
            "importEntryAndRegistry: registry size=%d",
            prerenderNodeRegistry?.size ?? 0,
          );
        } finally {
          if (!flagAlreadySet) {
            delete (globalThis as any).__rscRouterDiscoveryActive;
            debugDiscovery?.(
              "importEntryAndRegistry: cleared __rscRouterDiscoveryActive",
            );
          }
        }
      }

      async function getOrCreateTempServer(): Promise<TempServerResult> {
        // Reuse path: if a temp server is already alive, prefer reusing
        // it over orphaning the existing instance and spinning up a new
        // one. This handles two cases:
        //
        //   1. Steady-state cache hit (cold-start completed, registry
        //      cached) — return the env immediately.
        //   2. Recovery from a failed refresh: refreshTempRscEnv() may
        //      have invalidated and nulled the registry, then thrown
        //      during importEntryAndRegistry. Without reuse, the next
        //      call would `createTempRscServer` and overwrite the
        //      handle, leaking the previous server. Try to re-import on
        //      the existing runner first; only if THAT fails do we
        //      close the orphan and create new.
        if (prerenderTempServer) {
          const existingEnv = (prerenderTempServer.environments as any)?.rsc;
          if (existingEnv?.runner) {
            if (prerenderNodeRegistry) {
              debugDiscovery?.(
                "getOrCreateTempServer: cached temp runner reused",
              );
              return { env: existingEnv, error: null };
            }
            // Server alive but registry missing — likely after a prior
            // refresh's invalidate + import threw. Try to re-import.
            debugDiscovery?.(
              "getOrCreateTempServer: server alive but registry missing — re-importing",
            );
            try {
              await importEntryAndRegistry(existingEnv);
              return { env: existingEnv, error: null };
            } catch (err: any) {
              debugDiscovery?.(
                "getOrCreateTempServer: reuse import failed (%s) — closing orphan and creating fresh",
                err?.message ?? String(err),
              );
              await prerenderTempServer.close().catch(() => {});
              prerenderTempServer = null;
              prerenderNodeRegistry = null;
              // Fall through to create-new path below.
            }
          } else {
            // Server reference exists but its rsc env is unhealthy
            // (no runner). Close and recreate.
            debugDiscovery?.(
              "getOrCreateTempServer: existing server has no rsc.runner — closing and recreating",
            );
            await prerenderTempServer.close().catch(() => {});
            prerenderTempServer = null;
            prerenderNodeRegistry = null;
          }
        }

        // Create path: no existing temp server (or just nullified above).
        debugDiscovery?.(
          "getOrCreateTempServer: creating new temp server, entry=%s",
          s.resolvedEntryPath ?? "(unset)",
        );
        // Surface the create/import cause to the caller (issue #719 P2): a
        // transient re-optimization is re-pollable, a terminal fault is not. A
        // clean createServer that yields no runner leaves this null — terminal,
        // but not an exception.
        let createError: unknown = null;
        try {
          prerenderTempServer = await createTempRscServer(s, {
            cacheDir: "node_modules/.vite_prerender",
            // The dev /__rsc_shell endpoint drives captureShellHTML in this
            // server's SSR realm; the entry is only imported when a shell
            // capture runs, so discovery cost is unchanged.
            realSsrEntry: true,
          });

          const tempRscEnv = (prerenderTempServer.environments as any)?.rsc;
          if (tempRscEnv?.runner) {
            await importEntryAndRegistry(tempRscEnv);
            return { env: tempRscEnv, error: null };
          }
          debugDiscovery?.(
            "getOrCreateTempServer: tempRscEnv.runner unavailable",
          );
        } catch (err: any) {
          createError = err;
          debugDiscovery?.(
            "getOrCreateTempServer: FAILED message=%s",
            err.message,
          );
          console.warn(`[rango] Failed to create temp runner: ${err.message}`);
        }
        // Reached only on failure (runner unavailable, or create/import threw
        // AFTER the server was created). Close the just-created server so a
        // failed discovery does not leak it until the next call or dev shutdown,
        // and null the refs so the reuse path above starts clean. Mirrors the
        // close pattern used when an existing server is discarded (above).
        await prerenderTempServer?.close().catch(() => {});
        prerenderTempServer = null;
        prerenderNodeRegistry = null;
        return { env: null, error: createError };
      }

      // Clear the package-level singleton registries that survive a Vite
      // moduleGraph.invalidateAll(). createRouter() / createHostRouter()
      // call .set(id, ...) on these Maps; for "router removed" or
      // "router id changed" edits, the OLD entry would persist after
      // re-import without an explicit .clear(), leaving ghost routes
      // in discoverRouters' output.
      //
      // We import the same module the runner imports, so the .clear()
      // here mutates the same Map the freshly re-imported entry will
      // populate.
      async function clearTempRegistries(tempRscEnv: any): Promise<void> {
        try {
          const serverMod = await tempRscEnv.runner.import(
            "@rangojs/router/server",
          );
          if (typeof serverMod?.RouterRegistry?.clear === "function") {
            serverMod.RouterRegistry.clear();
          }
          if (typeof serverMod?.HostRouterRegistry?.clear === "function") {
            serverMod.HostRouterRegistry.clear();
          }
          debugDiscovery?.(
            "clearTempRegistries: cleared RouterRegistry + HostRouterRegistry",
          );
        } catch (err: any) {
          // Non-fatal: if the import fails here, importEntryAndRegistry
          // below will fail loudly with the same root cause and the
          // caller will surface it.
          debugDiscovery?.(
            "clearTempRegistries: import @rangojs/router/server failed (%s)",
            err?.message ?? String(err),
          );
        }
      }

      // HMR refresh: keep the temp Vite server alive across HMR cycles and
      // invalidate its module graph instead of close+recreate. Closing the
      // temp server during workerd's first post-cold-start module-fetch
      // window disrupted the main dev server's transport — the user-visible
      // symptom was a `transport was disconnected, cannot call "fetchModule"`
      // error on the first urls.tsx edit (workerd's cache was cold, so its
      // eval was still in flight when our close() ran). Module-graph
      // invalidation is the architecturally cleaner refresh: same Vite
      // instance, same transport, fresh source.
      //
      // Falls back to close+recreate when neither the env-level nor
      // server-level moduleGraph exposes invalidateAll() (defensive — Vite
      // versions / preset configurations may differ in which graph carries
      // the module-runner cache).
      async function refreshTempRscEnv(): Promise<any | null> {
        const tempRscEnv = (await getOrCreateTempServer()).env;
        if (!tempRscEnv) return null;

        // Module-runner cache is on the per-environment graph in Vite 6+;
        // older / non-environments setups carry it on the server graph.
        // Try env first, server second.
        const envGraph = (tempRscEnv as any).moduleGraph;
        const serverGraph = (prerenderTempServer as any)?.moduleGraph;
        const target = envGraph?.invalidateAll
          ? envGraph
          : serverGraph?.invalidateAll
            ? serverGraph
            : null;

        if (!target) {
          // No invalidate method available — fall back to close+recreate.
          // This preserves the previous behavior in case a Vite version
          // doesn't expose invalidateAll on either graph.
          debugDiscovery?.(
            "refreshTempRscEnv: invalidateAll unavailable on env+server graphs, falling back to close+recreate",
          );
          if (prerenderTempServer) {
            await prerenderTempServer.close().catch(() => {});
            prerenderTempServer = null;
            prerenderNodeRegistry = null;
          }
          return (await getOrCreateTempServer()).env;
        }

        debugDiscovery?.(
          "refreshTempRscEnv: invalidating module graph (%s)",
          envGraph?.invalidateAll ? "env" : "server",
        );
        target.invalidateAll();
        // Drop the cached registry so importEntryAndRegistry re-reads it
        // through the now-invalidated module runner.
        prerenderNodeRegistry = null;
        // Clear singleton Maps that Vite's moduleGraph invalidation can't
        // reach (RouterRegistry / HostRouterRegistry). Without this, an
        // edit that REMOVES a createRouter() call or CHANGES a router id
        // would leave the old entry in the registry, and discoverRouters
        // would still emit its routes alongside whatever the new source
        // declares.
        await clearTempRegistries(tempRscEnv);
        await importEntryAndRegistry(tempRscEnv);
        return tempRscEnv;
      }

      // Surface a discovery failure on either dev path (Node RSC runner or the
      // Cloudflare temp Node server). `hashBefore`/`hashAfter` are the discovering
      // environment's dep-optimizer browserHash snapshots: a change across the
      // attempt means a reload-causing re-optimization landed mid-flight, so an
      // empty registry was the transient race (downgraded to a warning) rather
      // than a genuine misconfig (loud, actionable error). Shared so both catch
      // sites frame the same failure identically.
      const emitDiscoveryFailure = (
        err: unknown,
        hashBefore: string | undefined,
        hashAfter: string | undefined,
      ): void => {
        const reoptimizeObserved =
          hashBefore !== undefined &&
          hashAfter !== undefined &&
          hashBefore !== hashAfter;
        const report = describeDiscoveryFailure(err, { reoptimizeObserved });
        if (report.level === "warn") {
          console.warn(report.message);
        } else {
          console.error(report.message);
        }
      };

      const discover = async () => {
        const discoverStart = performance.now();
        const rscEnv = (server.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          // Cloudflare dev: no module runner available (workerd-based RSC env).
          // Set devServerOrigin so the virtual module can inject __PRERENDER_DEV_URL
          // for on-demand prerender via the /__rsc_prerender endpoint.
          debugDiscovery?.(
            "dev: cloudflare path start, __rscRouterDiscoveryActive=%s",
            (globalThis as any).__rscRouterDiscoveryActive ?? false,
          );
          s.devServerOrigin = getDevServerOrigin();

          // Create a temp Node.js server to run runtime discovery and generate
          // named route types (static parser can't resolve factory calls).
          // The temp server is a separate Vite instance with its own dep
          // optimizer; snapshot ITS browserHash (hoisted so the catch can tell a
          // transient re-optimization apart from a genuine empty registry, the
          // same way the Node path below does).
          let tempRscEnv: any;
          let optimizerHashBefore: string | undefined;
          try {
            // Acquire build-time env bindings for dev prerender
            await timed(debugDiscovery, "acquireBuildEnv", () =>
              acquireBuildEnv(s, viteCommand, viteMode),
            );

            tempRscEnv = (
              await timed(debugDiscovery, "getOrCreateTempServer", () =>
                getOrCreateTempServer(),
              )
            ).env;
            if (tempRscEnv) {
              optimizerHashBefore =
                tempRscEnv.depsOptimizer?.metadata?.browserHash;
              await timed(debugDiscovery, "discoverRouters (cloudflare)", () =>
                discoverRouters(
                  s,
                  tempRscEnv,
                  (prerenderTempServer?.environments as any)?.ssr,
                ),
              );
              timedSync(debugDiscovery, "writeRouteTypesFiles", () =>
                writeRouteTypesFiles(s),
              );
            }
          } catch (err: any) {
            emitDiscoveryFailure(
              err,
              optimizerHashBefore,
              tempRscEnv?.depsOptimizer?.metadata?.browserHash,
            );
          }

          debugDiscovery?.(
            "dev discovery done (%sms)",
            (performance.now() - discoverStart).toFixed(1),
          );
          resolveDiscovery!();
          return;
        }

        // Snapshot the dep-optimizer hash before discovery so the catch can tell
        // a transient re-optimization race apart from a genuine empty registry.
        // A reload-causing re-optimization regenerates browserHash; if it changed
        // across the attempt, an empty read was almost certainly the race below.
        const optimizerHashBefore: string | undefined =
          rscEnv.depsOptimizer?.metadata?.browserHash;

        try {
          // Acquire build-time env bindings for dev prerender (Node.js path)
          debugDiscovery?.("dev: node path start");
          await timed(debugDiscovery, "acquireBuildEnv", () =>
            acquireBuildEnv(s, viteCommand, viteMode),
          );

          // Discover routers FIRST, then arm the manifest-readiness gate on the
          // server module discovery actually read the registry from.
          //
          // We deliberately do NOT pre-import "@rangojs/router/server" before the
          // entry to arm the gate early. During a Vite dependency re-optimization
          // (dev boot after a lockfile change, or `vite dev --force`), a module
          // imported here before the entry resolves to the pre-optimize copy of
          // the runner's module graph, while discoverRouters' entry import — which
          // awaits the in-flight re-optimization — resolves to the post-optimize
          // copy. createRouter() then populates RouterRegistry on the fresh copy,
          // but a stale pre-imported "@rangojs/router/server" reads the other
          // copy's empty Map and discovery throws a spurious "No routers found"
          // even though the app is configured correctly. discoverRouters imports
          // the entry first and reads the registry off the same instance, keeping
          // read and write on one copy. The virtual manifest module's own gate
          // (s.discoveryDone, armed by beginDiscoveryGate) already blocks early
          // requests during discovery on the Node path, so arming
          // manifestReadyPromise after discovery is sufficient here.
          const serverMod = await timed(debugDiscovery, "discoverRouters", () =>
            discoverRouters(s, rscEnv, (server.environments as any)?.ssr),
          );
          if (serverMod?.setManifestReadyPromise) {
            serverMod.setManifestReadyPromise(discoveryPromise);
          }

          // Store server origin for dev prerender endpoint (virtual module injection)
          s.devServerOrigin = getDevServerOrigin();

          // Update named-routes.gen.ts from runtime discovery.
          // The runtime manifest is the source of truth: it evaluates dynamic
          // routes (e.g. Array.from loops) that the static parser cannot see.
          // writeRouteTypesFiles() only writes when content changes, so this
          // won't cause unnecessary HMR triggers.
          timedSync(debugDiscovery, "writeRouteTypesFiles", () =>
            writeRouteTypesFiles(s),
          );

          // Populate the route map and per-router data in the RSC env
          await timed(debugDiscovery, "propagateDiscoveryState", () =>
            propagateDiscoveryState(rscEnv),
          );
        } catch (err: any) {
          emitDiscoveryFailure(
            err,
            optimizerHashBefore,
            rscEnv.depsOptimizer?.metadata?.browserHash,
          );
        } finally {
          debugDiscovery?.(
            "dev discovery done (%sms)",
            (performance.now() - discoverStart).toFixed(1),
          );
          resolveDiscovery!();
        }
      };

      // Schedule after all plugins have finished configureServer.
      // The gate (s.discoveryDone) is reset via beginDiscoveryGate() and
      // resolved when discover() finishes, so the virtual manifest module's
      // load() awaits the populated state.
      beginDiscoveryGate();
      setTimeout(
        () => discover().then(resolveDiscoveryGate, resolveDiscoveryGate),
        0,
      );

      // Dev-mode on-demand prerender endpoint.
      // When workerd hits a prerender route, it fetches this endpoint instead of
      // trying to run node:fs-dependent handlers in the Cloudflare environment.
      //
      // Node.js preset: uses the main server's RSC environment directly (router
      // instances are already discovered and have matchForPrerender).
      // Cloudflare preset: lazily creates a Node.js temp server because the main
      // RSC environment uses workerd where node:fs can't access the host filesystem.

      // Registry from the main server's RSC environment (populated by discoverRouters)
      let mainRegistry: Map<string, any> | null = null;

      // Memoized /__rsc_prerender render results, keyed by router-instance
      // identity (#654). The per-request entry re-import below is what makes
      // identity a valid freshness key: an HMR-invalidated chain re-runs
      // createRouter() and replaces the registry instance, so cached bodies
      // for the old instance become unreachable; an untouched chain returns
      // the same instance and the cached body is byte-identical to a fresh
      // render. See dev-prerender-cache.ts for the full invariant.
      const devPrerenderCache = createDevPrerenderCache();

      // Push discovery state (manifest, trie, precomputed entries) to the
      // server module so runtime request handling uses the current routes.
      // Shared by initial discovery and HMR-triggered re-discovery.
      const propagateDiscoveryState = async (rscEnv: any) => {
        const serverMod = await rscEnv.runner.import("@rangojs/router/server");
        if (!serverMod) return;
        // Clear stale per-router and global route data before repopulating.
        // Without this, removed routers/routes survive in the per-router maps
        // and shrunk precomputed entries or tries are never purged.
        if (serverMod.clearAllRouterData) {
          serverMod.clearAllRouterData();
        }
        mainRegistry = serverMod.RouterRegistry ?? null;
        if (s.mergedRouteManifest && serverMod.setCachedManifest) {
          serverMod.setCachedManifest(s.mergedRouteManifest);
        }
        const perRouterSetters: Array<[Map<string, any>, string]> = [
          [s.perRouterManifestDataMap, "setRouterManifest"],
          [s.perRouterTrieMap, "setRouterTrie"],
          [s.perRouterPrecomputedMap, "setRouterPrecomputedEntries"],
        ];
        for (const [map, fn] of perRouterSetters) {
          const setter = serverMod[fn];
          if (typeof setter !== "function") continue;
          for (const [routerId, value] of map) setter(routerId, value);
        }
      };

      server.middlewares.use("/__rsc_prerender", async (req: any, res: any) => {
        const reqStart = debugDev ? performance.now() : 0;
        const logResult = (status: number, note: string) => {
          debugDev?.(
            "/__rsc_prerender %s -> %d %s (%sms)",
            req.url,
            status,
            note,
            (performance.now() - reqStart).toFixed(1),
          );
        };

        if (s.discoveryDone) await s.discoveryDone;

        const url = new URL(req.url || "/", "http://localhost");
        const pathname = url.searchParams.get("pathname");
        if (!pathname) {
          res.statusCode = 400;
          res.end("Missing pathname");
          logResult(400, "missing pathname");
          return;
        }

        // Import the user's entry module to force re-evaluation of any
        // HMR-invalidated modules in the chain (entry → router → urls → handlers).
        // This ensures createRouter() re-runs with updated handler code before
        // we read RouterRegistry. Without this, edits to prerender handler files
        // produce stale content because the old router instance remains registered.
        const rscEnv = (server.environments as any)?.rsc;
        let registry: Map<string, any> | null = null;
        if (rscEnv?.runner && s.resolvedEntryPath) {
          try {
            await rscEnv.runner.import(s.resolvedEntryPath);
            const serverMod = await rscEnv.runner.import(
              "@rangojs/router/server",
            );
            registry = serverMod.RouterRegistry ?? null;
          } catch (err: any) {
            console.warn(
              `[rango] Dev prerender module refresh failed: ${err.message}`,
            );
            res.statusCode = 500;
            res.end(`Prerender handler error: ${err.message}`);
            logResult(500, "module refresh failed");
            return;
          }
        } else {
          registry = mainRegistry;
        }

        if (!registry) {
          // No main registry: the RSC env has no module runner (Cloudflare dev).
          // Lazily create a Node.js temp server for prerender evaluation, and
          // re-import the entry through it on EVERY request — the temp server
          // has its own file watcher, so a handler-only edit (a file without
          // urls()/createRouter() that the main watcher's route-file sniff
          // ignores) invalidates its module graph; the re-import re-evaluates
          // exactly the dirty subgraph and re-registers fresh router
          // instances. Before #654 the cached registry was only refreshed on
          // route-file edits, so handler-only edits served stale prerender
          // content on this path. Warm-cache re-imports are module-cache hits.
          const tempRscEnv = (await getOrCreateTempServer()).env;
          if (tempRscEnv) {
            try {
              await importEntryAndRegistry(tempRscEnv);
            } catch (err: any) {
              console.warn(
                `[rango] Dev prerender module refresh failed: ${err.message}`,
              );
              res.statusCode = 500;
              res.end(`Prerender handler error: ${err.message}`);
              logResult(500, "temp module refresh failed");
              return;
            }
          }
          registry = prerenderNodeRegistry;
        }

        if (!registry || registry.size === 0) {
          res.statusCode = 503;
          res.end("Prerender runner not available");
          logResult(503, "no registry");
          return;
        }

        const wantIntercept = url.searchParams.get("intercept") === "1";
        const wantRouteName = url.searchParams.get("routeName");
        const wantPassthrough = url.searchParams.get("passthrough") === "1";

        // One render warms BOTH variant keys (matchForPrerender computes the
        // intercept segments unconditionally), so a route's main and modal
        // variants cost a single render per HMR generation.
        const variantDims = {
          passthrough: wantPassthrough,
          routeName: wantRouteName,
        };
        const keyMain = devPrerenderCacheKey(pathname, {
          intercept: false,
          ...variantDims,
        });
        const keyIntercept = devPrerenderCacheKey(pathname, {
          intercept: true,
          ...variantDims,
        });
        const requestedKey = wantIntercept ? keyIntercept : keyMain;

        for (const [, routerInstance] of registry) {
          if (!routerInstance.matchForPrerender) continue;
          // Cache is consulted per router IN LOOP ORDER so multi-router
          // fall-through semantics are identical to the uncached path: a
          // router that never produced a payload for this key still runs
          // its matchForPrerender (cheap trie miss / intentionally-uncached
          // error retry) before the next router is considered.
          const cached = devPrerenderCache.get(routerInstance, requestedKey);
          if (cached !== undefined) {
            res.setHeader("content-type", "application/json");
            res.setHeader("x-rango-prerender-cache", "HIT");
            res.end(cached);
            logResult(200, "cache hit");
            return;
          }
          try {
            const result = await routerInstance.matchForPrerender(
              pathname,
              {},
              undefined,
              wantPassthrough,
              s.resolvedBuildEnv,
              true, // devMode: check getParams for passthrough routes
            );
            if (!result) continue;
            if (result.passthrough) continue;
            // When routeName is specified, only accept a match for that route.
            // This prevents returning the wrong entry when multiple routers
            // have prerenderable routes sharing the same pathname.
            if (wantRouteName && result.routeName !== wantRouteName) continue;
            // Pre-encoded MERGED handle string in the intercept body comes
            // from the producer (handles are Flight-encoded so
            // Promise/ReactNode values survive the wire).
            const bodies = payloadBodiesFromResult(result);
            devPrerenderCache.set(routerInstance, keyMain, bodies.main);
            devPrerenderCache.set(
              routerInstance,
              keyIntercept,
              bodies.intercept,
            );
            res.setHeader("content-type", "application/json");
            res.setHeader("x-rango-prerender-cache", "MISS");
            res.end(wantIntercept ? bodies.intercept : bodies.main);
            logResult(200, `match ${result.routeName}`);
            return;
          } catch (err: any) {
            // matchForPrerender now re-throws render failures instead of baking
            // an error page (issue #587). In dev there is no frozen artifact, so
            // we fall through (404 -> live handler). A `throw new Skip()` is the
            // expected "skip this URL" signal, not a failure, so it stays quiet.
            if (err?.name !== "Skip") {
              console.warn(
                `[rango] Dev prerender error for ${pathname} (serving live instead): ${err.message}`,
              );
            }
          }
        }

        res.statusCode = 404;
        res.end("No prerender match");
        logResult(404, "no match");
      });

      // Dev on-demand PPR shell production (producer B, #699). There is no
      // build manifest in dev, so the serve path's read-through
      // (rsc/shell-build-manifest.ts) fetches the shell entry from here on a
      // Prerender+ppr route's first request — dev serves x-rango-shell: HIT
      // from request one, mirroring production. Memoized per router HMR
      // generation AND per caller version (a client-module edit bumps the
      // version without rotating the router instance; the stale entry would
      // fail the serve gate forever). The endpoint is policy-free: the caller
      // (the serve gate, which resolved the route's ppr option) sends
      // ttl/swr/tags/version. Only prerender-backed routes produce entries —
      // the /__rsc_prerender pre-flight below both warms the payload memo the
      // capture's dev store fetch will hit AND refuses non-prerenderable
      // routes (a live-handler render must never be served as a baked shell).
      server.middlewares.use("/__rsc_shell", async (req: any, res: any) => {
        await s.discoveryDone;
        const url = new URL(req.url ?? "", "http://localhost");
        const pathname = url.searchParams.get("pathname");
        const routeName = url.searchParams.get("routeName");
        const version = url.searchParams.get("version");
        // ttl is required like the identifiers: the endpoint is policy-free
        // (the serve gate resolved the route's ppr option and always sends
        // it), so there is deliberately no default to drift from
        // resolvePprConfig's.
        const ttlRaw = url.searchParams.get("ttl");
        if (!pathname || !routeName || !version || !ttlRaw) {
          res.statusCode = 400;
          res.end("Missing pathname/routeName/version/ttl");
          return;
        }

        // Boot-race readiness signal (issue #719): the capture realm is stood
        // up lazily on the first hit (temp server, registry import, and a Vite
        // dep re-optimization the first shell-capture import can trigger). All
        // are TRANSIENT — a retry seconds later succeeds. Tagging them 503 +
        // x-rango-shell-dev: NOT-READY lets the read-through re-poll ONLY these
        // (a bounded await of readiness) instead of mapping the boot window to
        // a hard first-request MISS. Genuine negatives (404) stay untagged so a
        // non-baked route never stalls the foreground.
        const sendNotReady = (detail: string): void => {
          res.statusCode = 503;
          res.setHeader("x-rango-shell-dev", "NOT-READY");
          res.end(detail);
        };
        // A Vite dependency re-optimization surfaces as ERR_OUTDATED_OPTIMIZED_DEP
        // (import throws once, then re-imports clean) — retryable, unlike a real
        // module fault (syntax error, missing export), which stays a hard 500.
        // The message-regex fallback is NOT gratuitous: err.code is stripped when
        // the error serializes across the module-runner/workerd RPC boundary (the
        // message survives), so under the Cloudflare preset .code alone misses it.
        const isReoptimizing = (err: any): boolean =>
          err?.code === "ERR_OUTDATED_OPTIMIZED_DEP" ||
          /Outdated Optimize Dep|optimized dependency|new dependencies optimized/i.test(
            String(err?.message ?? ""),
          );
        // Fold the reoptimize-guard pasted at all three import/capture catch
        // sites: emit NOT-READY + report handled for a transient re-optimization,
        // else leave the caller to send its own terminal (500 for an entry
        // import, 404 for a mid-capture failure that keeps runtime capture).
        const handledAsReoptimizing = (err: any): boolean => {
          if (!isReoptimizing(err)) return false;
          sendNotReady(`Shell capture re-optimizing: ${err.message}`);
          return true;
        };
        // Both entry-import sites (main-server rsc env, temp Node server) fail
        // identically: reoptimize → NOT-READY, else → hard 500.
        const handleShellImportError = (err: any): void => {
          if (handledAsReoptimizing(err)) return;
          res.statusCode = 500;
          res.end(`Shell capture module refresh failed: ${err.message}`);
        };
        // Deterministic boot-race injection for e2e (issue #719 P3): fire ONE
        // reopt-class NOT-READY per pathname through the REAL classifier so the
        // read-through's re-poll path is exercised end-to-end (not just the
        // unit-mocked fetch), then serve normally on the re-poll. Env-gated —
        // inert in every non-test run.
        if (
          process.env.RANGO_E2E_INJECT_SHELL_NOTREADY === "1" &&
          !injectedShellNotReadyPaths.has(pathname)
        ) {
          injectedShellNotReadyPaths.add(pathname);
          const injected = Object.assign(
            new Error("Outdated Optimize Dep (injected boot-race)"),
            { code: "ERR_OUTDATED_OPTIMIZED_DEP" },
          );
          if (handledAsReoptimizing(injected)) return;
        }
        const ttl = Number(ttlRaw);
        const swrRaw = url.searchParams.get("swr");
        const swr = swrRaw === null ? undefined : Number(swrRaw);
        const tagsRaw = url.searchParams.get("tags");
        const tags = tagsRaw ? tagsRaw.split(",") : undefined;
        const maxSnapshotBytesRaw = url.searchParams.get("maxSnapshotBytes");
        const maxSnapshotBytes =
          maxSnapshotBytesRaw === null
            ? undefined
            : Number(maxSnapshotBytesRaw);
        // Boundary revalidation via the SHARED normalizer (shell-serve.ts):
        // the param crossed an HTTP query string, and a garbage value must
        // fall back to the capture default, never reach setTimeout as NaN
        // (which Node clamps to ~1ms — an instant abort).
        const captureTimeout = normalizeCaptureTimeout(
          Number(url.searchParams.get("captureTimeout")),
        );

        // Resolve the capture realms: main-server envs (Node preset) or the
        // shared temp Node server (Cloudflare preset — no main RSC runner).
        // Entry re-import per request picks up HMR edits, exactly like the
        // prerender endpoint above.
        const rscEnvMain = (server.environments as any)?.rsc;
        let rscRealm: any = null;
        let ssrRealm: any = null;
        let ssrEntryId: string;
        // Why the temp-server path returned no runner, if it did: a transient
        // re-optimization is re-pollable (NOT-READY), a terminal create/import
        // fault is not. Carried from getOrCreateTempServer to the readiness
        // check below so only reopt re-polls (issue #719 P2).
        let tempServerError: unknown = null;
        if (rscEnvMain?.runner && s.resolvedEntryPath) {
          try {
            await rscEnvMain.runner.import(s.resolvedEntryPath);
          } catch (err: any) {
            handleShellImportError(err);
            return;
          }
          rscRealm = rscEnvMain;
          ssrRealm = (server.environments as any)?.ssr;
          ssrEntryId =
            (server.environments as any)?.ssr?.config?.build?.rollupOptions
              ?.input?.index ?? VIRTUAL_IDS.ssr;
        } else {
          const tempResult = await getOrCreateTempServer();
          if (tempResult.env) {
            try {
              await importEntryAndRegistry(tempResult.env);
            } catch (err: any) {
              handleShellImportError(err);
              return;
            }
          } else {
            tempServerError = tempResult.error;
          }
          rscRealm = tempResult.env;
          ssrRealm = (prerenderTempServer?.environments as any)?.ssr;
          ssrEntryId = "virtual:entry-ssr";
        }
        if (!rscRealm?.runner || !ssrRealm?.runner) {
          // Reoptimization is the ONLY transient class: re-poll it (NOT-READY).
          // A terminal temp-server create/import fault, or an SSR runner absent
          // after a clean createServer, fails fast with a plain 503 (no
          // NOT-READY header) so the read-through MISSes on its first attempt
          // instead of re-polling a permanently-broken realm for the full
          // readiness deadline (issue #719 P2).
          if (tempServerError && handledAsReoptimizing(tempServerError)) return;
          res.statusCode = 503;
          res.end("Shell capture runners not available");
          return;
        }
        let registry: Map<string, any> | null = null;
        let registryError: unknown = null;
        try {
          const serverMod = await rscRealm.runner.import(
            "@rangojs/router/server",
          );
          registry = serverMod.RouterRegistry ?? null;
        } catch (err: any) {
          registryError = err;
          registry = null;
        }
        if (!registry || registry.size === 0) {
          // Same rule as the runner check: a re-optimization mid-import is
          // re-pollable (NOT-READY); a terminal import fault or a genuinely
          // empty registry (no routers registered) fails fast (issue #719 P2).
          if (registryError && handledAsReoptimizing(registryError)) return;
          res.statusCode = 503;
          res.end("Shell capture registry not available");
          return;
        }

        // Memo sweep FIRST: after request one the common case is a memo HIT
        // (this fetch blocks a foreground document request), and the memoized
        // body needs neither the pre-flight round-trip nor a capture. Keyed
        // per router instance (= HMR generation) like the prerender memo.
        const cacheKey = `shell|${pathname}|r=${routeName}|t=${ttl}|s=${swr ?? ""}|g=${(tags ?? []).join("+")}|c=${captureTimeout ?? ""}|v=${version}`;
        for (const [, routerInstance] of registry) {
          if (typeof routerInstance.match !== "function") continue;
          const cached = devPrerenderCache.get(routerInstance, cacheKey);
          if (cached !== undefined) {
            res.setHeader("content-type", "application/json");
            res.setHeader("x-rango-shell-dev", "HIT");
            res.end(cached);
            return;
          }
        }

        // Pre-flight: the route must be prerender-backed. Warms the payload
        // memo the capture's dev prerender store will fetch, and closes the
        // live-handler-bake hole (a non-pr route 404s here).
        if (s.devServerOrigin) {
          try {
            const probe = await fetch(
              `${s.devServerOrigin}/__rsc_prerender?pathname=${encodeURIComponent(pathname)}&routeName=${encodeURIComponent(routeName)}`,
              { signal: AbortSignal.timeout(DEV_SHELL_PROBE_TIMEOUT_MS) },
            );
            if (!probe.ok) {
              res.statusCode = 404;
              res.end("Route is not prerenderable");
              return;
            }
          } catch {
            res.statusCode = 404;
            res.end("Prerender pre-flight failed");
            return;
          }
        }

        for (const [, routerInstance] of registry) {
          if (typeof routerInstance.match !== "function") continue;
          try {
            const ssrModule = await ssrRealm.runner.import(ssrEntryId);
            if (typeof ssrModule?.captureShellHTML !== "function") {
              res.statusCode = 404;
              res.end("SSR entry has no captureShellHTML");
              return;
            }
            const captureMod = await rscRealm.runner.import(
              "@rangojs/router/build/shell-capture",
            );
            const result = await captureMod.captureShellForBuild({
              router: routerInstance,
              urlPath: pathname,
              routeName,
              key: `${pathname}:shell`,
              ttl,
              swr,
              tags,
              maxSnapshotBytes,
              captureTimeout,
              buildEnv: s.resolvedBuildEnv,
              buildVersion: version,
              captureShellHTML: ssrModule.captureShellHTML,
              debug: !!debugDiscovery,
            });
            if (result.outcome === "route-mismatch") continue;
            if (result.outcome !== "stored" || !result.entry) {
              res.statusCode = 404;
              res.end(`Shell capture ${result.outcome}`);
              return;
            }
            const body = JSON.stringify({
              entry: result.entry,
              ttl,
              swr,
              tags: result.tags,
              routeName,
            });
            devPrerenderCache.set(routerInstance, cacheKey, body);
            res.setHeader("content-type", "application/json");
            res.setHeader("x-rango-shell-dev", "MISS");
            res.end(body);
            return;
          } catch (err: any) {
            // A dep re-optimization mid-capture is a boot-race, not a capture
            // failure: signal NOT-READY so the read-through re-polls instead of
            // conceding a first-request MISS (issue #719).
            if (handledAsReoptimizing(err)) return;
            console.warn(
              `[rango] Dev shell capture error for ${pathname} (route keeps runtime capture): ${err.message}`,
            );
            res.statusCode = 404;
            res.end(`Shell capture error: ${err.message}`);
            return;
          }
        }
        res.statusCode = 404;
        res.end("No router matched");
      });

      // Watch url module and router files for changes and regenerate named-routes.gen.ts.
      // Process files containing urls( or createRouter( to update the combined route map.
      if (opts?.staticRouteTypesGeneration !== false) {
        const isGeneratedRouteFile = (filePath: string): boolean =>
          filePath.endsWith(".gen.ts") &&
          (filePath.includes("named-routes.gen.ts") ||
            filePath.includes("urls.gen.ts"));

        const regenerateGeneratedRouteFiles = () => {
          if (s.perRouterManifests.length > 0) {
            writeRouteTypesFiles(s);
          } else {
            writeCombinedRouteTypesWithTracking(s);
          }
        };
        const routeShapeSignature = () =>
          JSON.stringify(
            s.perRouterManifests.map(
              ({
                id,
                routeManifest,
                routeTrailingSlash,
                routeSearchSchemas,
              }) => ({
                id,
                routeManifest,
                routeTrailingSlash,
                routeSearchSchemas,
              }),
            ),
          );

        const maybeHandleGeneratedRouteFileMutation = (
          filePath: string,
        ): boolean => {
          if (!isGeneratedRouteFile(filePath)) return false;
          if (consumeSelfGenWrite(s, filePath)) return true;
          // In Cloudflare dev (no module runner), perRouterManifests is never
          // refreshed after HMR so regenerateGeneratedRouteFiles() would use
          // stale data and revert user edits. Source files own route state;
          // gen files are derived output. Skip regeneration and let the next
          // source-file change rebuild them from the static parser.
          const hasRunner = !!(server.environments as any)?.rsc?.runner;
          if (!hasRunner) return true;
          regenerateGeneratedRouteFiles();
          return true;
        };

        // Debounce timer for batching rapid route-file changes (e.g. afterEach
        // restoring two files in quick succession). The cheap checks (extension,
        // scanFilter, content sniff) run synchronously to gate non-route files;
        // only the expensive regeneration is debounced.
        let routeChangeTimer: ReturnType<typeof setTimeout> | undefined;

        // Re-run runtime discovery so factory-generated routes that the
        // static parser cannot see are refreshed after source changes.
        // The state-machine concerns (queued/pending/gatePending) are
        // owned by the gate created above (./discovery/gate-state.ts).
        // Here we provide just the env-specific work.
        const refreshRuntimeDiscovery = async () => {
          const rscEnv = (server.environments as any)?.rsc;
          const hasMainRunner = !!rscEnv?.runner;
          // Cloudflare HMR has no main RSC runner (workerd is a separate
          // runtime). When we have a populated runtime manifest from cold
          // start, we can re-discover via the temp Node runner — the same
          // mechanism getOrCreateTempServer() uses at startup. Without a
          // populated manifest there's nothing useful to do, so bail
          // before involving the gate machine at all.
          if (!hasMainRunner && s.perRouterManifests.length === 0) return;
          let previousRouteShape = routeShapeSignature();
          await gate.runRefreshCycle(async () => {
            const hmrStart = performance.now();
            try {
              if (hasMainRunner) {
                await timed(debugDiscovery, "hmr discoverRouters", () =>
                  discoverRouters(s, rscEnv, (server.environments as any)?.ssr),
                );
                timedSync(debugDiscovery, "hmr writeRouteTypesFiles", () =>
                  writeRouteTypesFiles(s),
                );
                await timed(debugDiscovery, "hmr propagateDiscoveryState", () =>
                  propagateDiscoveryState(rscEnv),
                );
              } else {
                // Cloudflare HMR: invalidate the temp server's RSC module
                // graph (or close+recreate as a fallback) so the runner
                // re-reads the freshly edited source. Keeping the same
                // Vite instance alive avoids disrupting workerd's transport
                // during the first post-cold-start module-fetch window.
                const tempRscEnv = await timed(
                  debugDiscovery,
                  "hmr refreshTempRscEnv (cloudflare)",
                  () => refreshTempRscEnv(),
                );
                if (!tempRscEnv) {
                  throw new Error(
                    "temp runner unavailable for cloudflare HMR rediscovery",
                  );
                }
                await timed(
                  debugDiscovery,
                  "hmr discoverRouters (cloudflare)",
                  () =>
                    discoverRouters(
                      s,
                      tempRscEnv,
                      (prerenderTempServer?.environments as any)?.ssr,
                    ),
                );
                timedSync(debugDiscovery, "hmr writeRouteTypesFiles", () =>
                  writeRouteTypesFiles(s),
                );
              }
              if (s.lastDiscoveryError) {
                debugDiscovery?.(
                  "hmr: cleared lastDiscoveryError (%s) after successful rediscovery",
                  s.lastDiscoveryError.message,
                );
                s.lastDiscoveryError = null;
              }
              // Cloudflare dev: on a successful cycle drop the workerd runner's
              // cached worker-entry chain so the next request re-evaluates
              // createRouter() with the new routes. Fired here in the work path
              // (not the caller's .then()) so a queued follow-up cycle that
              // succeeds after an earlier failed cycle still reloads:
              // runRefreshCycle recurses queued work without awaiting it, so the
              // original call already resolved on the failed cycle. A failed
              // cycle throws above and never reaches here, so a broken edit
              // never reloads the worker onto bad source.
              if (rscEnv && !rscEnv.runner) {
                const nextRouteShape = routeShapeSignature();
                let expectedEpoch: number | undefined;
                if (nextRouteShape !== previousRouteShape) {
                  expectedEpoch = Math.max(
                    Date.now(),
                    (s.devDiscoveryEpoch ?? 0) + 1,
                  );
                  s.devDiscoveryEpoch = expectedEpoch;
                }
                previousRouteShape = nextRouteShape;
                forceCloudflareWorkerReload(rscEnv, expectedEpoch);
              }
            } catch (err: any) {
              s.lastDiscoveryError = {
                message: err?.message ?? String(err),
                at: Date.now(),
              };
              console.warn(
                `[rango] Runtime re-discovery failed: ${err.message}`,
              );
              debugDiscovery?.(
                "hmr: lastDiscoveryError set (%s) — manifest preserved at last-good; recovery mode active (any in-scan source change will trigger rediscovery)",
                err?.message,
              );
            } finally {
              debugDiscovery?.(
                "hmr re-discovery done (%sms)",
                (performance.now() - hmrStart).toFixed(1),
              );
            }
          });
        };

        // Cloudflare dev only. workerd serves every request through the
        // runner-worker singleton, which re-resolves the worker entry per
        // request via runner.import("virtual:cloudflare/worker-entry"). The
        // route table lives in the user's createRouter() instance, captured
        // when that entry chain (entry -> router -> urls) was last evaluated
        // and then cached in the runner's evaluatedModules. The route-file
        // watcher refreshes discovery + types on the Node side, but the worker
        // keeps serving the cached (stale) router: route-definition modules
        // have no import.meta.hot boundary, so Vite never sends the worker an
        // HMR update for them and the entry chain is never evicted.
        //
        // Fix: after discovery completes, (1) invalidate the worker env's
        // Node-side module graph, (2) send a full-reload to the worker, then
        // (3) probe until the active router reports the new discovery epoch.
        // Step (2) alone is insufficient: the full-reload handler clears the
        // runner's evaluatedModules and re-imports entrypoints, but each
        // re-import fetches the module back through this Node-side graph, which
        // still holds the pre-edit transform of urls.tsx — so createRouter()
        // rebuilds the stale route table and the new route 404s/hits the
        // catch-all. Invalidating the graph forces a fresh transform on
        // re-fetch (the same mechanism refreshTempRscEnv uses for discovery),
        // so the re-import re-runs createRouter() with the new routes. The probe
        // is detached because the refresh callback still holds the discovery
        // gate; awaiting it here would deadlock the request that proves the new
        // router is active. Once it succeeds, the client hot channel broadcasts
        // readiness to open and newly-booted stale documents.
        const forceCloudflareWorkerReload = (
          rscEnv: any,
          expectedEpoch: number | undefined,
        ) => {
          if (!rscEnv?.hot) return;

          const graph = rscEnv.moduleGraph;
          const reloadWorkerd = () => {
            if (graph?.invalidateAll) {
              graph.invalidateAll();
              debugDiscovery?.("hmr: invalidated workerd rsc module graph");
            }
            rscEnv.hot.send({ type: "full-reload" });
            debugDiscovery?.(
              "hmr: forced workerd rsc env reload (full-reload)",
            );
          };
          reloadWorkerd();

          if (expectedEpoch === undefined) return;
          void (async () => {
            const deadline = Date.now() + 15_000;
            let reloadBackoffMs = 100;
            let nextReloadAt = Date.now() + reloadBackoffMs;
            do {
              if (devServerClosed || expectedEpoch !== s.devDiscoveryEpoch) {
                return;
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 25));
              if (devServerClosed || expectedEpoch !== s.devDiscoveryEpoch) {
                return;
              }
              try {
                const response = await fetch(getDevServerOrigin() + "/", {
                  cache: "no-store",
                  headers: {
                    [DEV_DISCOVERY_PROBE_HEADER]: String(expectedEpoch),
                  },
                  signal: AbortSignal.timeout(1_000),
                });
                if (
                  !devServerClosed &&
                  expectedEpoch === s.devDiscoveryEpoch &&
                  response.headers.get(DEV_DISCOVERY_EPOCH_HEADER) ===
                    String(expectedEpoch)
                ) {
                  publishDevDiscoveryReady(expectedEpoch);
                  return;
                }
                await response.body?.cancel().catch(() => {});
                // A response without the expected epoch proves an older worker
                // evaluation won the race after the initial invalidation. Clear
                // that completed evaluation and retry the reload. Back off the
                // retries: reloading faster than workerd can evaluate prevents
                // convergence and retains overlapping module generations.
                const now = Date.now();
                if (now >= nextReloadAt) {
                  reloadWorkerd();
                  reloadBackoffMs = Math.min(reloadBackoffMs * 2, 1_000);
                  nextReloadAt = now + reloadBackoffMs;
                }
              } catch {}
            } while (Date.now() < deadline);

            debugDiscovery?.(
              "hmr: workerd readiness probe timed out at epoch %d",
              expectedEpoch,
            );
          })();
        };

        const scheduleRouteRegeneration = () => {
          clearTimeout(routeChangeTimer);
          routeChangeTimer = setTimeout(async () => {
            routeChangeTimer = undefined;
            const regenStart = debugDiscovery ? performance.now() : 0;
            const rscEnv = (server.environments as any)?.rsc;
            const skipStaticWrite =
              !rscEnv?.runner && s.perRouterManifests.length > 0;
            // Refresh clientUrls projections + state BEFORE any gen-file
            // write below: the write invalidates the routes-manifest virtual
            // module, whose regenerated code replays state.clientUrlProjectionMap
            // (clear + set). A stale map at that moment bakes stale literals
            // that clobber the runtime registry before the re-discovery entry
            // import materializes the client mount (node HMR served old
            // client-urls patterns until restart). Lenient: import failures
            // keep last-known state; discoverRouters' strict pass reports.
            if (rscEnv?.runner && s.clientUrlSourceByReferenceId?.size) {
              try {
                const serverMod = await rscEnv.runner.import(
                  "@rangojs/router/server",
                );
                await refreshRecordedClientUrlProjections(
                  s,
                  (server.environments as any)?.ssr,
                  serverMod,
                );
                // Force the routes-manifest virtual module to re-transform:
                // its generated code REPLAYS projections (clear + set) on
                // every rsc program reload, and self-gen-write suppression
                // keeps its cached transform alive through this cycle — a
                // stale replay after propagateDiscoveryState would clobber
                // the refreshed registry as the realm's last write and the
                // next router evaluation would materialize the old mount.
                for (const virtualId of [
                  VIRTUAL_ROUTES_MANIFEST_ID,
                  `\0${VIRTUAL_ROUTES_MANIFEST_ID}`,
                ]) {
                  const virtualMod =
                    rscEnv.moduleGraph?.getModuleById?.(virtualId);
                  if (virtualMod) {
                    rscEnv.moduleGraph.invalidateModule(virtualMod);
                  }
                }
              } catch (err: any) {
                debugDiscovery?.(
                  "watcher: clientUrls projection pre-refresh failed: %s",
                  err?.message,
                );
              }
            }
            try {
              // In cloudflare dev with a populated runtime manifest, the
              // static parser produces a strictly smaller (and actively
              // wrong) gen file — supplementGenFilesWithRuntimeRoutes can
              // only restore factory-only prefixes, and apps with mixed
              // static+factory routes under shared prefixes (cf-stress)
              // collapse to the 19-route static view. Skip the static
              // write entirely; runtime rediscovery below will overwrite
              // the gen file with the authoritative manifest.
              if (skipStaticWrite) {
                debugDiscovery?.(
                  "watcher: skipping static write (cloudflare HMR — runtime rediscovery owns gen file)",
                );
              } else {
                writeCombinedRouteTypesWithTracking(s);
                if (s.perRouterManifests.length > 0) {
                  supplementGenFilesWithRuntimeRoutes(s);
                }
              }
            } catch (err: any) {
              console.error(`[rango] Route regeneration error: ${err.message}`);
            }
            debugDiscovery?.(
              "watcher: regenerated gen files (%sms)",
              (performance.now() - regenStart).toFixed(1),
            );
            // Async: re-run runtime discovery to refresh factory-generated
            // routes that the static parser cannot resolve. Resolves the
            // discovery gate when complete.
            if (s.perRouterManifests.length > 0) {
              // The cloudflare workerd reload fires inside refreshRuntimeDiscovery
              // on the successful cycle (see forceCloudflareWorkerReload call
              // there) so queued follow-up cycles also trigger it.
              refreshRuntimeDiscovery().catch((err: any) => {
                console.warn(
                  `[rango] Runtime re-discovery error: ${err.message}`,
                );
                // Even on error, unblock the gate so workerd's reload doesn't
                // hang indefinitely against the previous manifest.
                resolveDiscoveryGate();
              });
            }
          }, 100);
        };

        const handleRouteFileChange = (filePath: string) => {
          if (maybeHandleGeneratedRouteFileMutation(filePath)) return;
          if (
            !filePath.endsWith(".ts") &&
            !filePath.endsWith(".tsx") &&
            !filePath.endsWith(".js") &&
            !filePath.endsWith(".jsx")
          ) {
            if (s.lastDiscoveryError) {
              debugDiscovery?.(
                "watcher: skip non-source %s [LASTERR %s]",
                filePath,
                s.lastDiscoveryError.message,
              );
            }
            return;
          }
          // Apply scan filter as early-exit before reading file
          if (s.scanFilter && !s.scanFilter(filePath)) {
            if (s.lastDiscoveryError) {
              debugDiscovery?.(
                "watcher: skip scan-filter %s [LASTERR %s]",
                filePath,
                s.lastDiscoveryError.message,
              );
            }
            return;
          }
          // Recovery mode: when the previous HMR re-discovery failed, the
          // import graph is incomplete and the manifest is stuck at the
          // last-good state. The fix may land in a non-route file (e.g. a
          // helper imported by the router, a missing module being created,
          // or a "use client" component) that the narrow content sniff
          // would otherwise filter out. While in recovery, treat any
          // in-scan source change as a candidate for rediscovery; the
          // tighter filter resumes once discovery succeeds again.
          const inRecoveryMode = !!s.lastDiscoveryError;
          try {
            const source = readFileSync(filePath, "utf-8");
            const trimmed = source.trimStart();
            const isUseClient =
              trimmed.startsWith('"use client"') ||
              trimmed.startsWith("'use client'");
            // clientUrls() modules are "use client" by contract yet define
            // routes: their edits must re-run discovery (server projection +
            // generated types), so only bail on use-client files WITHOUT a
            // clientUrls() definition. Scar: before this carve-out, editing a
            // clientUrls module's route shape in dev left the serving router on
            // the stale projection — the old pattern kept matching and the new
            // one 404ed until a full restart.
            let hasClientUrls = source.includes("clientUrls(");
            if (hasClientUrls) {
              hasClientUrls =
                firstCodeMatchIndex(source, /\bclientUrls\(/g) >= 0;
            }
            if (!inRecoveryMode && isUseClient && !hasClientUrls) return;
            // Cheap raw pre-check first; only when a candidate token is present
            // do we confirm it occurs in real code (not a comment/string) via a
            // single allocation-free code-region scan. Most saved files contain
            // neither token and skip the scan entirely. This avoids a comment or
            // string mention spuriously marking a file relevant and triggering an
            // unnecessary re-discovery on save.
            let hasUrls = source.includes("urls(");
            let hasCreateRouter = /\bcreateRouter\s*[<(]/.test(source);
            if (hasUrls) hasUrls = firstCodeMatchIndex(source, /urls\(/g) >= 0;
            if (hasCreateRouter) {
              hasCreateRouter =
                firstCodeMatchIndex(source, /\bcreateRouter\s*[<(]/g) >= 0;
            }
            // hasClientUrls counts here too: in a clientUrls() module the only
            // `urls(` token sits INSIDE the `clientUrls(` identifier, which the
            // code scan correctly rejects as a sub-identifier match — so
            // without this the file would silently fail the sniff.
            if (
              !inRecoveryMode &&
              !hasUrls &&
              !hasCreateRouter &&
              !hasClientUrls
            ) {
              return;
            }
            if (inRecoveryMode) {
              debugDiscovery?.(
                "watcher: recovery rediscovery for %s (urls=%s, router=%s, clientUrls=%s, useClient=%s) [LASTERR %s]",
                filePath,
                hasUrls,
                hasCreateRouter,
                hasClientUrls,
                isUseClient,
                s.lastDiscoveryError!.message,
              );
            } else {
              debugDiscovery?.(
                "watcher: %s matches (urls=%s, router=%s, clientUrls=%s)",
                filePath,
                hasUrls,
                hasCreateRouter,
                hasClientUrls,
              );
            }
            // A "use client" clientUrls module is an HMR-accepted client
            // boundary in the rsc graph: its edit never invalidates the router
            // module that materialized its projection, so the re-discovery
            // entry import would cache-hit and keep serving the stale mount
            // (old patterns 200, new patterns 404 until restart). Invalidate
            // the entry + router sources so the import re-creates the routers
            // against the refreshed projection (installed by the pre-entry
            // refresh in discover-routers.ts).
            const mainRscEnv = (server.environments as any)?.rsc;
            if (isUseClient && hasClientUrls && mainRscEnv?.runner) {
              const rscGraph = mainRscEnv.moduleGraph;
              if (rscGraph?.getModulesByFile) {
                // Importers must be invalidated too: the virtual RSC entry
                // holds a live `import { router }` binding, and re-evaluating
                // router.tsx alone leaves that binding on the OLD instance —
                // the request pipeline would keep serving the stale mount.
                // Vite's invalidateModule already walks importers. Share its
                // seen set across roots instead of recursively starting a new
                // traversal at every importer (quadratic on a large graph).
                // Vite's walk skips HMR-accepting importers and soft-invalidates
                // static ones (vs the old unconditional hard walk) — safe here:
                // the entry and every router source are invalidated directly as
                // roots, and ancestors get the exact treatment Vite's own
                // file-change propagation applies on a server urls edit.
                // Cloudflare has no local runner and skips this block: its temp
                // discovery graph and workerd graph are invalidated wholesale
                // by refreshRuntimeDiscovery() after this watcher event.
                const routerSourceFiles = new Set<string>();
                if (s.resolvedEntryPath) {
                  routerSourceFiles.add(resolve(s.resolvedEntryPath));
                }
                for (const entry of s.perRouterManifests) {
                  if (entry.sourceFile) {
                    routerSourceFiles.add(resolve(entry.sourceFile));
                  }
                }
                const seen = new Set<any>();
                for (const file of routerSourceFiles) {
                  const mods = rscGraph.getModulesByFile(
                    file.replaceAll("\\", "/"),
                  );
                  if (!mods) {
                    debugDiscovery?.(
                      "watcher: clientUrls invalidation found no rsc modules for %s",
                      file,
                    );
                    continue;
                  }
                  for (const mod of mods) {
                    rscGraph.invalidateModule(mod, seen);
                  }
                }
                debugDiscovery?.(
                  "watcher: clientUrls edit invalidated %d rsc module(s) for %d router file(s)",
                  seen.size,
                  routerSourceFiles.size,
                );
              }
            }
            // Invalidate cache when a router file changes (new router added/removed)
            if (hasCreateRouter) {
              const nestedRouterConflict = findNestedRouterConflict([
                ...(s.cachedRouterFiles ?? []),
                resolve(filePath),
              ]);
              if (nestedRouterConflict) {
                server.config.logger.error(
                  formatNestedRouterConflictError(nestedRouterConflict),
                );
                return;
              }
              s.cachedRouterFiles = undefined;
            }
            // Note the event in the gate machine IMMEDIATELY (before the
            // 100ms debounce and any downstream HMR fanout). This sets
            // both `pendingEvents` (so refresh's finally holds the gate
            // through the tail window even if no rediscovery is queued)
            // and resets `discoveryDone` to a fresh pending promise (so
            // workerd reloads triggered by the same source change can't
            // observe a stale resolved gate from cold-start). Resolved
            // by the trailing refreshRuntimeDiscovery() cycle.
            if (s.perRouterManifests.length > 0) {
              gate.noteRouteEvent();
            }
            scheduleRouteRegeneration();
          } catch (readErr: any) {
            if (s.lastDiscoveryError) {
              debugDiscovery?.(
                "watcher: read error %s: %s [LASTERR %s]",
                filePath,
                readErr?.message,
                s.lastDiscoveryError.message,
              );
            }
            // Ignore read errors for deleted/moved files
          }
        };

        // Handle both "add" and "change" events: editors with atomic saves
        // (unlink + rename) emit "add" instead of "change", and chokidar's
        // polling mode on CI Linux can also emit "add" for overwrites.
        server.watcher.on("add", handleRouteFileChange);
        server.watcher.on("change", handleRouteFileChange);

        // Regenerate gen files when they are deleted (e.g. manual cleanup).
        // Same no-runner guard as change/add: stale perRouterManifests would
        // reintroduce reverted content.
        server.watcher.on("unlink", (filePath) => {
          if (!isGeneratedRouteFile(filePath)) return;
          const hasRunner = !!(server.environments as any)?.rsc?.runner;
          if (!hasRunner) return;
          regenerateGeneratedRouteFiles();
        });
      }
    },

    // Build mode: create a temporary Vite dev server to access the RSC
    // environment's module runner, then discover routers and generate manifests.
    // The manifest data is stored for the virtual module's load hook.
    async buildStart() {
      if (!s.isBuildMode) return;
      // Only run once across environment builds
      if (s.mergedRouteManifest !== null) {
        debugDiscovery?.(
          "build: skip (already discovered, env=%s)",
          this.environment?.name ?? "?",
        );
        return;
      }
      const buildStartTime = performance.now();
      debugDiscovery?.("build: start (env=%s)", this.environment?.name ?? "?");
      resetStagedBuildAssets(s.projectRoot);
      resetPrerenderCollection(s);

      // Acquire build-time env bindings if configured
      await timed(debugDiscovery, "build acquireBuildEnv", () =>
        acquireBuildEnv(s, viteCommand, viteMode),
      );

      let tempServer: any = null;
      // Signal to user-space code (e.g. reverse.ts) that build-time discovery
      // is active. Uses globalThis because the temp server's module runner
      // creates a separate module context — there is no shared import path
      // between the vite plugin and user code loaded via runner.import().
      (globalThis as any).__rscRouterDiscoveryActive = true;
      try {
        tempServer = await timed(
          debugDiscovery,
          "build createTempRscServer",
          () => createTempRscServer(s, { forceBuild: true }),
        );

        const rscEnv = (tempServer.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          console.warn(
            "[rango] RSC environment runner not available during build, skipping manifest generation",
          );
          return;
        }

        // Point resolvedStaticModules at the temp server's expose-internal-ids
        // plugin so that discoverRouters() can access the static handler module
        // map after the temp server's transforms populate it.
        const tempIdsPlugin = (tempServer as any).config?.plugins?.find(
          (p: any) => p.name === "@rangojs/router:expose-internal-ids",
        );
        if (tempIdsPlugin?.api?.staticHandlerModules) {
          s.resolvedStaticModules = tempIdsPlugin.api.staticHandlerModules;
        }

        await timed(debugDiscovery, "build discoverRouters", () =>
          discoverRouters(s, rscEnv, (tempServer.environments as any)?.ssr),
        );
        // Update named-routes.gen.ts from runtime discovery.
        // The runtime manifest includes dynamically generated routes
        // that the static parser cannot extract from source code.
        timedSync(debugDiscovery, "build writeRouteTypesFiles", () =>
          writeRouteTypesFiles(s),
        );
      } catch (err: any) {
        // Extract the user source file from the stack trace (skip internal frames)
        const sourceFile = err.stack
          ?.split("\n")
          .find(
            (line: string) =>
              line.includes(s.projectRoot) && !line.includes("node_modules"),
          )
          ?.match(/\(([^)]+)\)/)?.[1];
        // Extract the route name from "Unknown route: <name>" errors
        const routeName = err.message?.match(/Unknown route: (.+)/)?.[1];
        const details = [
          routeName ? `  Route name: ${routeName}` : null,
          sourceFile ? `  File: ${sourceFile}` : null,
          err.stack ? `  Stack:\n${err.stack}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        throw new Error(
          `[rango] Build-time router discovery failed:\n${details}`,
          { cause: err },
        );
      } finally {
        delete (globalThis as any).__rscRouterDiscoveryActive;
        if (tempServer && s.shellCandidates?.length) {
          // Prerender+ppr candidates exist: keep the temp server (and its
          // realm — tries installed, registry populated) alive for the
          // post-build shell capture phase (buildApp post, producer B #699).
          // The prelude embeds built client asset URLs, so the capture can
          // only run after the client build; that phase closes the server.
          // buildEnv release is deferred with it — a bake-lane loader
          // executing during the capture may read ctx.env.
          s.shellPhaseTempServer = tempServer;
        } else {
          if (tempServer) {
            await timed(debugDiscovery, "build tempServer.close", () =>
              tempServer.close(),
            );
          }
          await releaseBuildEnv(s);
        }
        debugDiscovery?.(
          "build discovery done (%sms)",
          (performance.now() - buildStartTime).toFixed(1),
        );
      }
    },

    // Post-build PPR shell capture (producer B, #699): runs after EVERY
    // environment bundle is written — the shell prelude embeds built client
    // asset URLs (bootstrap entry), which do not exist at buildStart. The
    // kept temp server and the buildEnv were deferred AS A PAIR in
    // buildStart's finally; this finally is the pair's success-path owner
    // (buildEnd below owns the aborted-build path) — the phase itself is a
    // pure producer and tears down only the globals it installs.
    buildApp: {
      order: "post",
      async handler(builder) {
        try {
          await runShellPrerenderPhase(s, builder as any);
        } finally {
          if (s.isBuildMode) {
            const tempServer = s.shellPhaseTempServer;
            s.shellPhaseTempServer = null;
            if (tempServer) await tempServer.close();
            await releaseBuildEnv(s);
          }
        }
      },
    },

    // An environment build failure aborts the builder before the buildApp
    // post hook — never leak the kept temp server (open handles hang the CLI)
    // or the deferred buildEnv (a live miniflare proxy).
    async buildEnd(error) {
      if (!error || !s.shellPhaseTempServer) return;
      const tempServer = s.shellPhaseTempServer;
      s.shellPhaseTempServer = null;
      try {
        await tempServer.close();
      } finally {
        await releaseBuildEnv(s);
      }
    },

    // Suppress vite's HMR cascade for our own gen-file writes.
    //
    // After every cf HMR cycle, refreshTempRscEnv → writeRouteTypesFiles
    // writes the configured gen files (default `router.named-routes.gen.ts`,
    // but the source filenames and gen suffix are user-configurable). The
    // chokidar watcher then fires twice independently: our
    // `handleRouteFileChange` (already short-circuited by
    // `consumeSelfGenWrite` inside `maybeHandleGeneratedRouteFileMutation`),
    // AND vite's own HMR pipeline (which invalidates the gen file's
    // importers and triggers a second workerd full reload — visible to the
    // user as a duplicate "[Rango] HMR: version changed" on the client).
    //
    // `peekSelfGenWrite` is the authoritative filter: its map only contains
    // paths that `markSelfGenWrite` has registered, so it natively works
    // for any configured gen-file name. It is non-consuming so the chokidar
    // handler that fires later can still consume the same entry. Returning
    // [] tells vite "no modules invalidated by this change" — safe because
    // `s.perRouterManifests` is already up-to-date (the write that just
    // happened is the consequence of our just-completed rediscovery).
    handleHotUpdate(ctx) {
      if (peekSelfGenWrite(s, ctx.file)) {
        debugDiscovery?.(
          "handleHotUpdate: suppressing self-write HMR cascade for %s",
          ctx.file,
        );
        return [];
      }
    },

    // Virtual module: provides the pre-generated route manifest as a JS module
    // that calls setCachedManifest() at import time.
    resolveId(id) {
      if (id === VIRTUAL_ROUTES_MANIFEST_ID) {
        return "\0" + VIRTUAL_ROUTES_MANIFEST_ID;
      }
      // Per-router virtual modules: virtual:rsc-router/routes-manifest/<routerId>
      if (id.startsWith(VIRTUAL_ROUTES_MANIFEST_ID + "/")) {
        return "\0" + id;
      }
      // virtual:rsc-router/prerender-paths removed: prerender data is served through the worker
      return null;
    },

    async load(id) {
      if (id === "\0" + VIRTUAL_ROUTES_MANIFEST_ID) {
        // In dev mode, wait for discovery to complete before emitting module content.
        // This is critical for Cloudflare dev where the worker runs in a separate
        // Miniflare process and can only receive manifest data via the virtual module.
        if (s.discoveryDone) {
          await timed(
            debugRoutes,
            "await discoveryDone (manifest)",
            () => s.discoveryDone,
          );
        }
        const code = await timed(
          debugRoutes,
          "generateRoutesManifestModule",
          () => generateRoutesManifestModule(s),
        );
        debugRoutes?.("manifest module emitted (%d bytes)", code?.length ?? 0);
        return code;
      }
      // Per-router virtual modules: pure data exports (no side effects).
      // ensureRouterManifest() imports the module and stores the data.
      const perRouterPrefix = "\0" + VIRTUAL_ROUTES_MANIFEST_ID + "/";
      if (id.startsWith(perRouterPrefix)) {
        if (s.discoveryDone) {
          await timed(
            debugRoutes,
            "await discoveryDone (per-router)",
            () => s.discoveryDone,
          );
        }
        const routerId = id.slice(perRouterPrefix.length);
        const code = await timed(
          debugRoutes,
          `generatePerRouterModule ${routerId}`,
          () => generatePerRouterModule(s, routerId),
        );
        return code;
      }
      // virtual:rsc-router/prerender-paths load handler removed
      return null;
    },

    // Record handler chunk metadata and RSC entry filename during RSC build.
    // Used by closeBundle for handler code eviction and prerender data injection.
    generateBundle(_options: any, bundle: any) {
      if (this.environment?.name !== "rsc") return;
      const genStart = debugBuild ? performance.now() : 0;

      // Record RSC entry chunk filename for closeBundle injection
      for (const [fileName, chunk] of Object.entries(bundle) as [
        string,
        any,
      ][]) {
        if (chunk.type === "chunk" && chunk.isEntry) {
          s.rscEntryFileName = fileName;
          break;
        }
      }

      if (!s.resolvedPrerenderModules?.size && !s.resolvedStaticModules?.size) {
        debugBuild?.(
          "generateBundle (rsc): no handlers to scan (%sms)",
          (performance.now() - genStart).toFixed(1),
        );
        return;
      }

      // Clear maps at the start of each RSC generateBundle pass.
      // Vite 6 multi-environment builds run RSC twice (analysis + production);
      // clearing prevents stale/duplicate records from the analysis pass.
      s.handlerChunkInfoMap.clear();
      s.staticHandlerChunkInfoMap.clear();

      for (const [fileName, chunk] of Object.entries(bundle) as [
        string,
        any,
      ][]) {
        if (chunk.type !== "chunk") continue;

        // Scan all chunks for handler exports (handlers may land in any chunk)
        if (s.resolvedPrerenderModules?.size) {
          const handlers = extractHandlerExportsFromChunk(
            chunk.code,
            s.resolvedPrerenderModules,
            "Prerender",
            false,
          );
          if (handlers.length > 0) {
            const existing = s.handlerChunkInfoMap.get(fileName);
            if (existing) {
              existing.exports.push(...handlers);
            } else {
              s.handlerChunkInfoMap.set(fileName, {
                fileName,
                exports: handlers,
              });
            }
          }
        }

        if (s.resolvedStaticModules?.size) {
          const handlers = extractHandlerExportsFromChunk(
            chunk.code,
            s.resolvedStaticModules,
            "Static",
            false,
          );
          if (handlers.length > 0) {
            const existing = s.staticHandlerChunkInfoMap.get(fileName);
            if (existing) {
              existing.exports.push(...handlers);
            } else {
              s.staticHandlerChunkInfoMap.set(fileName, {
                fileName,
                exports: handlers,
              });
            }
          }
        }
      }

      debugBuild?.(
        "generateBundle (rsc): scanned %d chunks, %d prerender chunk(s), %d static chunk(s) (%sms)",
        Object.keys(bundle).length,
        s.handlerChunkInfoMap.size,
        s.staticHandlerChunkInfoMap.size,
        (performance.now() - genStart).toFixed(1),
      );
    },

    // Build-time pre-rendering: evict handler code and inject collected prerender data.
    // Collection now happens in-process during discoverRouters() via RSC runner.
    // closeBundle only needs to evict handlers and inject the in-memory data.
    closeBundle: {
      order: "post" as const,
      sequential: true,
      async handler(this: any) {
        if (!s.isBuildMode) return;
        // Only run for the RSC environment — other environments (client, ssr) have
        // no prerender/static data to process and would just do redundant file I/O.
        if (this.environment && this.environment.name !== "rsc") return;
        timedSync(debugBuild, "closeBundle postprocessBundle", () =>
          postprocessBundle(s),
        );
      },
    },
  };
}
