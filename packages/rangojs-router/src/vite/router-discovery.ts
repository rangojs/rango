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
import {
  formatNestedRouterConflictError,
  findNestedRouterConflict,
  findRouterFiles,
} from "../build/generate-route-types.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import { createVirtualStubPlugin } from "./plugins/virtual-stub-plugin.js";
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
import { consumeSelfGenWrite } from "./discovery/self-gen-tracking.js";
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
import { resetStagedBuildAssets } from "./utils/prerender-utils.js";

export { VIRTUAL_ROUTES_MANIFEST_ID };

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
  const { default: rsc } = await import("@vitejs/plugin-rsc");
  return createViteServer({
    root: state.projectRoot,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: state.userResolveAlias },
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
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
      // Dev prerender must use dev-mode IDs (path-based) to match the workerd
      // runtime. forceBuild produces hashed IDs for production bundle consistency.
      exposeInternalIds(options.forceBuild ? { forceBuild: true } : undefined),
      exposeRouterId(),
    ],
  });
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
      // Capture user's resolve aliases for the temp server
      s.userResolveAlias = config.resolve.alias;
      // Node preset: pick up auto-discovered router path from the config() hook.
      // The auto-discover plugin runs in config() using Vite's resolved root,
      // populating the mutable ref before configResolved fires.
      if (!s.resolvedEntryPath && opts?.routerPathRef?.path) {
        s.resolvedEntryPath = opts.routerPathRef.path;
      }
      // Cloudflare preset: read entry from resolved environment config.
      // The @cloudflare/vite-plugin reads wrangler config (toml/json/jsonc)
      // and sets optimizeDeps.entries on the RSC environment.
      if (!s.resolvedEntryPath) {
        const rscEnvConfig = (config.environments as any)?.["rsc"];
        const entries = rscEnvConfig?.optimizeDeps?.entries;
        if (typeof entries === "string") {
          s.resolvedEntryPath = entries;
        } else if (Array.isArray(entries) && entries.length > 0) {
          s.resolvedEntryPath = entries[0];
        }
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

      // Clean up the temporary server when the dev server shuts down
      server.httpServer?.on("close", () => {
        if (prerenderTempServer) {
          prerenderTempServer.close().catch(() => {});
          prerenderTempServer = null;
        }
      });

      async function getOrCreateTempServer(): Promise<any | null> {
        if (prerenderNodeRegistry) {
          return (prerenderTempServer.environments as any)?.rsc ?? null;
        }
        try {
          prerenderTempServer = await createTempRscServer(s, {
            cacheDir: "node_modules/.vite_prerender",
          });

          const tempRscEnv = (prerenderTempServer.environments as any)?.rsc;
          if (tempRscEnv?.runner) {
            await tempRscEnv.runner.import(s.resolvedEntryPath!);
            const serverMod = await tempRscEnv.runner.import(
              "@rangojs/router/server",
            );
            prerenderNodeRegistry = serverMod.RouterRegistry;
            return tempRscEnv;
          }
        } catch (err: any) {
          console.warn(
            `[rsc-router] Failed to create temp runner: ${err.message}`,
          );
        }
        return null;
      }

      const discover = async () => {
        const rscEnv = (server.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          // Cloudflare dev: no module runner available (workerd-based RSC env).
          // Set devServerOrigin so the virtual module can inject __PRERENDER_DEV_URL
          // for on-demand prerender via the /__rsc_prerender endpoint.
          s.devServerOrigin = getDevServerOrigin();

          // Create a temp Node.js server to run runtime discovery and generate
          // named route types (static parser can't resolve factory calls).
          try {
            const tempRscEnv = await getOrCreateTempServer();
            if (tempRscEnv) {
              await discoverRouters(s, tempRscEnv);
              writeRouteTypesFiles(s);
            }
          } catch (err: any) {
            console.warn(
              `[rsc-router] Cloudflare dev discovery failed: ${err.message}\n${err.stack}`,
            );
          }

          resolveDiscovery!();
          return;
        }

        try {
          // Set the readiness gate BEFORE discovery so early requests
          // block until manifest is populated
          const serverMod = await rscEnv.runner.import(
            "@rangojs/router/server",
          );
          if (serverMod?.setManifestReadyPromise) {
            serverMod.setManifestReadyPromise(discoveryPromise);
          }

          await discoverRouters(s, rscEnv);

          // Store server origin for dev prerender endpoint (virtual module injection)
          s.devServerOrigin = getDevServerOrigin();

          // Update named-routes.gen.ts from runtime discovery.
          // The runtime manifest is the source of truth: it evaluates dynamic
          // routes (e.g. Array.from loops) that the static parser cannot see.
          // writeRouteTypesFiles() only writes when content changes, so this
          // won't cause unnecessary HMR triggers.
          writeRouteTypesFiles(s);

          // Populate the route map and per-router data in the RSC env
          await propagateDiscoveryState(rscEnv);
        } catch (err: any) {
          console.warn(
            `[rsc-router] Router discovery failed: ${err.message}\n${err.stack}`,
          );
        } finally {
          resolveDiscovery!();
        }
      };

      // Schedule after all plugins have finished configureServer.
      // Store the promise so the virtual module's load hook can await it.
      s.discoveryDone = new Promise<void>((resolve) => {
        setTimeout(() => discover().then(resolve, resolve), 0);
      });

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
        if (serverMod.setRouterManifest) {
          for (const [routerId, manifest] of s.perRouterManifestDataMap) {
            serverMod.setRouterManifest(routerId, manifest);
          }
        }
        if (serverMod.setRouterTrie) {
          for (const [routerId, trie] of s.perRouterTrieMap) {
            serverMod.setRouterTrie(routerId, trie);
          }
        }
        if (serverMod.setRouterPrecomputedEntries) {
          for (const [routerId, entries] of s.perRouterPrecomputedMap) {
            serverMod.setRouterPrecomputedEntries(routerId, entries);
          }
        }
      };

      server.middlewares.use("/__rsc_prerender", async (req: any, res: any) => {
        if (s.discoveryDone) await s.discoveryDone;

        const url = new URL(req.url || "/", "http://localhost");
        const pathname = url.searchParams.get("pathname");
        if (!pathname) {
          res.statusCode = 400;
          res.end("Missing pathname");
          return;
        }

        // Prefer the main server's registry (Node.js preset: module runner available).
        // Fall back to a temp server for Cloudflare where the main RSC env uses workerd.
        let registry = mainRegistry;

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
            return;
          } catch (err: any) {
            console.warn(
              `[rsc-router] Dev prerender failed for ${pathname}: ${err.message}`,
            );
          }
        }

        res.statusCode = 404;
        res.end("No prerender match");
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
        let runtimeRediscoveryInProgress = false;
        const refreshRuntimeDiscovery = async () => {
          const rscEnv = (server.environments as any)?.rsc;
          if (!rscEnv?.runner || runtimeRediscoveryInProgress) return;
          runtimeRediscoveryInProgress = true;
          try {
            await discoverRouters(s, rscEnv);
            writeRouteTypesFiles(s);
            await propagateDiscoveryState(rscEnv);
          } catch (err: any) {
            console.warn(
              `[rsc-router] Runtime re-discovery failed: ${err.message}`,
            );
          } finally {
            runtimeRediscoveryInProgress = false;
          }
        };

        const scheduleRouteRegeneration = () => {
          clearTimeout(routeChangeTimer);
          routeChangeTimer = setTimeout(() => {
            routeChangeTimer = undefined;
            try {
              writeCombinedRouteTypesWithTracking(s);
              if (s.perRouterManifests.length > 0) {
                supplementGenFilesWithRuntimeRoutes(s);
              }
            } catch (err: any) {
              console.error(
                `[rsc-router] Route regeneration error: ${err.message}`,
              );
            }
            // Async: re-run runtime discovery to refresh factory-generated
            // routes that the static parser cannot resolve.
            if (s.perRouterManifests.length > 0) {
              refreshRuntimeDiscovery().catch((err: any) => {
                console.warn(
                  `[rsc-router] Runtime re-discovery error: ${err.message}`,
                );
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
          )
            return;
          // Apply scan filter as early-exit before reading file
          if (s.scanFilter && !s.scanFilter(filePath)) return;
          try {
            const source = readFileSync(filePath, "utf-8");
            const trimmed = source.trimStart();
            if (
              trimmed.startsWith('"use client"') ||
              trimmed.startsWith("'use client'")
            )
              return;
            const hasUrls = source.includes("urls(");
            const hasCreateRouter = /\bcreateRouter\s*[<(]/.test(source);
            if (!hasUrls && !hasCreateRouter) return;
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
            scheduleRouteRegeneration();
          } catch {
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
      if (s.mergedRouteManifest !== null) return;
      resetStagedBuildAssets(s.projectRoot);
      s.prerenderManifestEntries = null;
      s.staticManifestEntries = null;

      let tempServer: any = null;
      // Signal to user-space code (e.g. reverse.ts) that build-time discovery
      // is active. Uses globalThis because the temp server's module runner
      // creates a separate module context — there is no shared import path
      // between the vite plugin and user code loaded via runner.import().
      (globalThis as any).__rscRouterDiscoveryActive = true;
      try {
        tempServer = await createTempRscServer(s, { forceBuild: true });

        const rscEnv = (tempServer.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          console.warn(
            "[rsc-router] RSC environment runner not available during build, skipping manifest generation",
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

        await discoverRouters(s, rscEnv);
        // Update named-routes.gen.ts from runtime discovery.
        // The runtime manifest includes dynamically generated routes
        // that the static parser cannot extract from source code.
        writeRouteTypesFiles(s);
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
          `[rsc-router] Build-time router discovery failed:\n${details}`,
        );
      } finally {
        delete (globalThis as any).__rscRouterDiscoveryActive;
        if (tempServer) {
          await tempServer.close();
        }
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
          await s.discoveryDone;
        }
        return generateRoutesManifestModule(s);
      }
      // Per-router virtual modules: pure data exports (no side effects).
      // ensureRouterManifest() imports the module and stores the data.
      const perRouterPrefix = "\0" + VIRTUAL_ROUTES_MANIFEST_ID + "/";
      if (id.startsWith(perRouterPrefix)) {
        if (s.discoveryDone) {
          await s.discoveryDone;
        }
        const routerId = id.slice(perRouterPrefix.length);
        return generatePerRouterModule(s, routerId);
      }
      // virtual:rsc-router/prerender-paths load handler removed
      return null;
    },

    // Record handler chunk metadata and RSC entry filename during RSC build.
    // Used by closeBundle for handler code eviction and prerender data injection.
    generateBundle(_options: any, bundle: any) {
      if (this.environment?.name !== "rsc") return;

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

      if (!s.resolvedPrerenderModules?.size && !s.resolvedStaticModules?.size)
        return;

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
            true,
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
        postprocessBundle(s);
      },
    },
  };
}
