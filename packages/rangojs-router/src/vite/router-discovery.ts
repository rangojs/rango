/**
 * Router Discovery Plugin
 *
 * Vite plugin that discovers router instances at dev/build time via the RSC
 * environment. Its hooks call the phase modules over one DiscoveryState:
 * discovery/dev-server-phase.ts (configureServer),
 * discovery/build-discovery-phase.ts (buildStart, buildApp post, buildEnd) and
 * discovery/bundle-scan-phase.ts (generateBundle). Route types generation,
 * virtual module codegen and bundle post-processing live in their own
 * discovery/ modules.
 */

import type { Plugin } from "vite";
import {
  findRouterFiles,
  createScanFilter,
} from "../build/generate-route-types.js";
import { injectClientDebugFlag } from "./inject-client-debug.js";
import {
  createDiscoveryState,
  VIRTUAL_ROUTES_MANIFEST_ID,
  type PluginOptions,
} from "./discovery/state.js";
import { peekSelfGenWrite } from "./discovery/self-gen-tracking.js";
import { recordClientUrlsModule } from "./discovery/client-urls-projection.js";
import { writeCombinedRouteTypesWithTracking } from "./discovery/route-types-writer.js";
import {
  generateRoutesManifestModule,
  generatePerRouterModule,
} from "./discovery/virtual-module-codegen.js";
import { postprocessBundle } from "./discovery/bundle-postprocess.js";
import { devServerPhase } from "./discovery/dev-server-phase.js";
import {
  buildDiscoveryPhase,
  buildEndPhase,
  postBuildPhase,
} from "./discovery/build-discovery-phase.js";
import { bundleScanPhase } from "./discovery/bundle-scan-phase.js";
import { resolveRscEntryFromConfig } from "./utils/shared-utils.js";
import {
  pickForwardedRunnerConfig,
  selectForwardableResolvePlugins,
} from "./utils/forward-user-plugins.js";
import { createRangoDebugger, timed, timedSync, NS } from "./debug.js";

const debugDiscovery = createRangoDebugger(NS.discovery);
const debugRoutes = createRangoDebugger(NS.routes);
const debugBuild = createRangoDebugger(NS.build);

export { VIRTUAL_ROUTES_MANIFEST_ID };

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
      s.viteCommand = config.command as "serve" | "build";
      s.viteMode = config.mode;
      // Capture user's resolve aliases for the temp server
      s.userResolveAlias = config.resolve.alias;
      // Capture the data-only resolution config (resolve.*, define, oxc) and
      // the user's resolution plugins (resolveId/load, plus import rewriters'
      // transform) so the discovery temp server resolves modules the same way
      // the real environment does.
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

    configureServer(server) {
      devServerPhase(s, server);
    },

    buildStart() {
      return buildDiscoveryPhase(s, this);
    },

    buildApp: {
      order: "post",
      handler(builder) {
        return postBuildPhase(s, builder);
      },
    },

    buildEnd(error) {
      return buildEndPhase(s, error);
    },

    // Suppress vite's HMR cascade for our own gen-file writes.
    //
    // After every cf HMR cycle, refreshTempRscEnv → writeRouteTypesFiles
    // writes the configured gen files (default `router.named-routes.gen.ts`,
    // but the source filenames and gen suffix are user-configurable). The
    // chokidar watcher then fires twice independently: our
    // `handleRouteFileChange` (dev-server-phase.ts, already short-circuited by
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
        // Only ever a bare import (the RSC entry's), so a build whose
        // treeshake.moduleSideEffects is false would drop it; load outranks it.
        return { code, moduleSideEffects: "no-treeshake" };
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

    generateBundle(_options: any, bundle: any) {
      bundleScanPhase(s, this, bundle);
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
