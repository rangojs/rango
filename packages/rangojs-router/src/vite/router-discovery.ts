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
} from "../build/generate-route-types.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
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
  options: { forceBuild?: boolean; cacheDir?: string } = {},
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
      }),
      // hashClientRefs only in build mode — production bundles need hashed refs
      ...(options.forceBuild ? [hashClientRefs(state.projectRoot)] : []),
      createVersionPlugin(),
      createVirtualStubPlugin(),
      createCloudflareProtocolStubPlugin(),
      // Dev prerender must use dev-mode IDs (path-based) to match the workerd
      // runtime. forceBuild produces hashed IDs for production bundle consistency.
      exposeInternalIds(options.forceBuild ? { forceBuild: true } : undefined),
      exposeRouterId(),
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

    config() {
      const config: any = {
        define: {
          __RANGO_DEBUG__: JSON.stringify(!!process.env.INTERNAL_RANGO_DEBUG),
        },
      };
      // Prerender/static handler modules are bundled naturally with the
      // rest of the RSC entry.  A previous design forced them into dedicated
      // __prerender-handlers / __static-handlers chunks via manualChunks,
      // but Rollup hoisted all shared dependencies into those chunks,
      // inflating them to ~1 MB with active runtime code.  Handler code is
      // evicted in closeBundle regardless of which chunk it lands in.
      return config;
    },

    configResolved(config) {
      s.projectRoot = config.root;
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

      // Shared temp server for Cloudflare dev (no module runner in workerd).
      // Used by both discover() (route type generation) and the prerender
      // middleware (on-demand prerender evaluation). Created lazily, closed on
      // server shutdown.
      let prerenderTempServer: any = null;
      let prerenderNodeRegistry: Map<string, any> | null = null;

      // Clean up the temporary server and build env when the dev server shuts down
      server.httpServer?.on("close", () => {
        if (prerenderTempServer) {
          prerenderTempServer.close().catch(() => {});
          prerenderTempServer = null;
        }
        releaseBuildEnv(s).catch(() => {});
      });

      // Mirror the build-path contract (router-discovery.ts ~line 878):
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

      async function getOrCreateTempServer(): Promise<any | null> {
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
              return existingEnv;
            }
            // Server alive but registry missing — likely after a prior
            // refresh's invalidate + import threw. Try to re-import.
            debugDiscovery?.(
              "getOrCreateTempServer: server alive but registry missing — re-importing",
            );
            try {
              await importEntryAndRegistry(existingEnv);
              return existingEnv;
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
        try {
          prerenderTempServer = await createTempRscServer(s, {
            cacheDir: "node_modules/.vite_prerender",
          });

          const tempRscEnv = (prerenderTempServer.environments as any)?.rsc;
          if (tempRscEnv?.runner) {
            await importEntryAndRegistry(tempRscEnv);
            return tempRscEnv;
          }
          debugDiscovery?.(
            "getOrCreateTempServer: tempRscEnv.runner unavailable",
          );
        } catch (err: any) {
          debugDiscovery?.(
            "getOrCreateTempServer: FAILED message=%s",
            err.message,
          );
          console.warn(`[rango] Failed to create temp runner: ${err.message}`);
        }
        return null;
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
        let tempRscEnv = await getOrCreateTempServer();
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
          return await getOrCreateTempServer();
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
          try {
            // Acquire build-time env bindings for dev prerender
            await timed(debugDiscovery, "acquireBuildEnv", () =>
              acquireBuildEnv(s, viteCommand, viteMode),
            );

            const tempRscEnv = await timed(
              debugDiscovery,
              "getOrCreateTempServer",
              () => getOrCreateTempServer(),
            );
            if (tempRscEnv) {
              await timed(debugDiscovery, "discoverRouters (cloudflare)", () =>
                discoverRouters(s, tempRscEnv),
              );
              timedSync(debugDiscovery, "writeRouteTypesFiles", () =>
                writeRouteTypesFiles(s),
              );
            }
          } catch (err: any) {
            console.warn(
              `[rango] Cloudflare dev discovery failed: ${err.message}\n${err.stack}`,
            );
          }

          debugDiscovery?.(
            "dev discovery done (%sms)",
            (performance.now() - discoverStart).toFixed(1),
          );
          resolveDiscovery!();
          return;
        }

        try {
          // Acquire build-time env bindings for dev prerender (Node.js path)
          debugDiscovery?.("dev: node path start");
          await timed(debugDiscovery, "acquireBuildEnv", () =>
            acquireBuildEnv(s, viteCommand, viteMode),
          );

          // Set the readiness gate BEFORE discovery so early requests
          // block until manifest is populated
          const serverMod = await timed(
            debugDiscovery,
            "import @rangojs/router/server",
            () => rscEnv.runner.import("@rangojs/router/server"),
          );
          if (serverMod?.setManifestReadyPromise) {
            serverMod.setManifestReadyPromise(discoveryPromise);
          }

          await timed(debugDiscovery, "discoverRouters", () =>
            discoverRouters(s, rscEnv),
          );

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
          console.warn(
            `[rango] Router discovery failed: ${err.message}\n${err.stack}`,
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
        if (
          s.mergedPrecomputedEntries &&
          s.mergedPrecomputedEntries.length > 0 &&
          serverMod.setPrecomputedEntries
        ) {
          serverMod.setPrecomputedEntries(s.mergedPrecomputedEntries);
        }
        if (s.mergedRouteTrie && serverMod.setRouteTrie) {
          serverMod.setRouteTrie(s.mergedRouteTrie);
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
          // Lazily create a Node.js temp server for prerender evaluation.
          if (!prerenderNodeRegistry) {
            await getOrCreateTempServer();
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

        for (const [, routerInstance] of registry) {
          if (!routerInstance.matchForPrerender) continue;
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
            res.setHeader("content-type", "application/json");
            let payload: Record<string, unknown>;
            if (wantIntercept && result.interceptSegments?.length) {
              payload = {
                segments: [...result.segments, ...result.interceptSegments],
                handles: {
                  ...result.handles,
                  ...(result.interceptHandles || {}),
                },
              };
            } else {
              payload = { segments: result.segments, handles: result.handles };
            }
            res.end(JSON.stringify(payload));
            logResult(200, `match ${result.routeName}`);
            return;
          } catch (err: any) {
            console.warn(
              `[rango] Dev prerender failed for ${pathname}: ${err.message}`,
            );
          }
        }

        res.statusCode = 404;
        res.end("No prerender match");
        logResult(404, "no match");
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
          await gate.runRefreshCycle(async () => {
            const hmrStart = performance.now();
            try {
              if (hasMainRunner) {
                await timed(debugDiscovery, "hmr discoverRouters", () =>
                  discoverRouters(s, rscEnv),
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
                  () => discoverRouters(s, tempRscEnv),
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

        const scheduleRouteRegeneration = () => {
          clearTimeout(routeChangeTimer);
          routeChangeTimer = setTimeout(() => {
            routeChangeTimer = undefined;
            const regenStart = debugDiscovery ? performance.now() : 0;
            const rscEnv = (server.environments as any)?.rsc;
            const skipStaticWrite =
              !rscEnv?.runner && s.perRouterManifests.length > 0;
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
              refreshRuntimeDiscovery().catch((err: any) => {
                console.warn(
                  `[rango] Runtime re-discovery error: ${err.message}`,
                );
                // Even on error, unblock the gate so workerd's reload
                // doesn't hang indefinitely against the previous manifest.
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
            if (!inRecoveryMode && isUseClient) return;
            const hasUrls = source.includes("urls(");
            const hasCreateRouter = /\bcreateRouter\s*[<(]/.test(source);
            if (!inRecoveryMode && !hasUrls && !hasCreateRouter) return;
            if (inRecoveryMode) {
              debugDiscovery?.(
                "watcher: recovery rediscovery for %s (urls=%s, router=%s, useClient=%s) [LASTERR %s]",
                filePath,
                hasUrls,
                hasCreateRouter,
                isUseClient,
                s.lastDiscoveryError!.message,
              );
            } else {
              debugDiscovery?.(
                "watcher: %s matches (urls=%s, router=%s)",
                filePath,
                hasUrls,
                hasCreateRouter,
              );
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
      s.prerenderManifestEntries = null;
      s.staticManifestEntries = null;

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
          discoverRouters(s, rscEnv),
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
        if (tempServer) {
          await timed(debugDiscovery, "build tempServer.close", () =>
            tempServer.close(),
          );
        }
        await releaseBuildEnv(s);
        debugDiscovery?.(
          "build discovery done (%sms)",
          (performance.now() - buildStartTime).toFixed(1),
        );
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
