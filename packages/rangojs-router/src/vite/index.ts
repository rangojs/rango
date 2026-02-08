import type { Plugin, PluginOption } from "vite";
import { createServer as createViteServer } from "vite";
import * as Vite from "vite";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { exposeActionId } from "./expose-action-id.ts";
import { exposeLoaderId } from "./expose-loader-id.ts";
import { exposeHandleId } from "./expose-handle-id.ts";
import { exposeLocationStateId } from "./expose-location-state-id.ts";
import { exposePrerenderHandlerId, prerenderHandlerModules } from "./expose-prerender-handler-id.ts";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  getVirtualVersionContent,
  VIRTUAL_IDS,
} from "./virtual-entries.ts";
import {
  getExcludeDeps,
  getPackageAliases,
  getPublishedPackageName,
  isWorkspaceDevelopment,
} from "./package-resolution.ts";

// Shared state for handler chunk eviction.
// Populated by cloudflare-integration's generateBundle, consumed by discovery's closeBundle.
let handlerChunkInfo: {
  fileName: string;
  exports: Array<{ name: string; handlerId: string }>;
} | null = null;

// Re-export plugins
export { exposeActionId } from "./expose-action-id.ts";
export { exposeLoaderId } from "./expose-loader-id.ts";
export { exposeHandleId } from "./expose-handle-id.ts";
export { exposeLocationStateId } from "./expose-location-state-id.ts";
export { exposePrerenderHandlerId } from "./expose-prerender-handler-id.ts";

// Virtual module type declarations in ./version.d.ts

/**
 * esbuild plugin to provide rsc-router:version virtual module during optimization.
 * This is needed because esbuild runs during Vite's dependency optimization phase,
 * before Vite's plugin system can handle virtual modules.
 */
const versionEsbuildPlugin = {
  name: "@rangojs/router-version",
  setup(build: any) {
    build.onResolve({ filter: /^rsc-router:version$/ }, (args: any) => ({
      path: args.path,
      namespace: "@rangojs/router-virtual",
    }));
    build.onLoad({ filter: /.*/, namespace: "@rangojs/router-virtual" }, () => ({
      contents: `export const VERSION = "dev";`,
      loader: "js",
    }));
  },
};

/**
 * Shared esbuild options for dependency optimization.
 * Includes the version stub plugin for all environments.
 */
const sharedEsbuildOptions = {
  plugins: [versionEsbuildPlugin],
};

/**
 * RSC plugin entry points configuration.
 * All entries use virtual modules by default. Specify a path to use a custom entry file.
 */
export interface RscEntries {
  /**
   * Path to a custom browser/client entry file.
   * If not specified, a default virtual entry is used.
   */
  client?: string;

  /**
   * Path to a custom SSR entry file.
   * If not specified, a default virtual entry is used.
   */
  ssr?: string;

  /**
   * Path to a custom RSC entry file.
   * If not specified, a default virtual entry is used that imports the router from the `entry` option.
   */
  rsc?: string;
}

/**
 * Options for @vitejs/plugin-rsc integration
 */
export interface RscPluginOptions {
  /**
   * Entry points for client, ssr, and rsc environments.
   * All entries use virtual modules by default.
   * Specify paths only when you need custom entry files.
   */
  entries?: RscEntries;
}

/**
 * Base options shared by all presets
 */
interface RangoBaseOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;

  /**
   * Show startup banner. Set to false to disable.
   * @default true
   */
  banner?: boolean;

}

/**
 * Options for Node.js deployment (default)
 */
export interface RangoNodeOptions extends RangoBaseOptions {
  /**
   * Deployment preset. Defaults to 'node' when not specified.
   */
  preset?: "node";

  /**
   * Path to your router configuration file that exports the route tree.
   * This file must export a `router` object created with `createRouter()`.
   *
   * @example
   * ```ts
   * rango({ router: './src/router.tsx' })
   * ```
   */
  router: string;

  /**
   * RSC plugin configuration. By default, rsc-router includes @vitejs/plugin-rsc
   * with sensible defaults.
   *
   * Entry files (browser, ssr, rsc) are optional - if they don't exist,
   * virtual defaults are used.
   *
   * - Omit or pass `true`/`{}` to use defaults (recommended)
   * - Pass `{ entries: {...} }` to customize entry paths
   * - Pass `false` to disable (for manual @vitejs/plugin-rsc configuration)
   *
   * @default true
   */
  rsc?: boolean | RscPluginOptions;
}

/**
 * Options for Cloudflare Workers deployment
 */
export interface RangoCloudflareOptions extends RangoBaseOptions {
  /**
   * Deployment preset for Cloudflare Workers.
   * When using cloudflare preset:
   * - @vitejs/plugin-rsc is NOT added (cloudflare plugin adds it)
   * - Your worker entry (e.g., worker.rsc.tsx) imports the router directly
   * - Browser and SSR use virtual entries
   * - Build-time manifest generation is auto-detected from wrangler.json main entry
   */
  preset: "cloudflare";
}

/**
 * Options for rango() Vite plugin
 */
export type RangoOptions = RangoNodeOptions | RangoCloudflareOptions;

/**
 * Create a virtual modules plugin for default entry files.
 * Provides virtual module content when entries use VIRTUAL_IDS (no custom entry configured).
 */
function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  routerPath?: string
): Plugin {

  // Build virtual modules map based on which entries use virtual IDs
  const virtualModules: Record<string, string> = {};

  if (entries.client === VIRTUAL_IDS.browser) {
    virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
  }
  if (entries.ssr === VIRTUAL_IDS.ssr) {
    virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
  }
  if (entries.rsc === VIRTUAL_IDS.rsc && routerPath) {
    // Convert relative path to absolute for virtual module imports
    const absoluteRouterPath = routerPath.startsWith(".")
      ? "/" + routerPath.slice(2) // ./src/router.tsx -> /src/router.tsx
      : routerPath;
    virtualModules[VIRTUAL_IDS.rsc] = getVirtualEntryRSC(absoluteRouterPath);
  }

  return {
    name: "@rangojs/router:virtual-entries",
    enforce: "pre",

    resolveId(id) {
      if (id in virtualModules) {
        return "\0" + id;
      }
      // Handle if the id already has the null prefix (RSC plugin wrapper imports)
      if (id.startsWith("\0") && id.slice(1) in virtualModules) {
        return id;
      }
      return null;
    },

    load(id) {
      if (id.startsWith("\0virtual:rsc-router/")) {
        const virtualId = id.slice(1);
        if (virtualId in virtualModules) {
          return virtualModules[virtualId];
        }
      }
      return null;
    },
  };
}

/**
 * Manual chunks configuration for client build.
 * Splits React and router packages into separate chunks for better caching.
 */
function getManualChunks(id: string): string | undefined {
  const normalized = Vite.normalizePath(id);

  if (
    normalized.includes("node_modules/react/") ||
    normalized.includes("node_modules/react-dom/") ||
    normalized.includes("node_modules/react-server-dom-webpack/") ||
    normalized.includes("node_modules/@vitejs/plugin-rsc/")
  ) {
    return "react";
  }
  // Use dynamic package name from package.json
  // Check both npm install path and workspace symlink resolved path
  const packageName = getPublishedPackageName();
  if (
    normalized.includes(`node_modules/${packageName}/`) ||
    normalized.includes("packages/rsc-router/") ||
    normalized.includes("packages/rangojs-router/")
  ) {
    return "router";
  }
  return undefined;
}

/**
 * Plugin providing rsc-router:version virtual module.
 * Exports VERSION that changes when RSC modules change (dev) or at build time (production).
 *
 * The version is used for:
 * 1. Cache invalidation - CFCacheStore uses VERSION to invalidate stale cache
 * 2. Version mismatch detection - client sends version, server reloads on mismatch
 *
 * In dev mode, the version updates when:
 * - Server starts (initial version)
 * - RSC modules change via HMR (triggers version module invalidation)
 *
 * Client-only HMR changes don't update the version since they don't affect
 * server-rendered content or cached RSC payloads.
 * @internal
 */
function createVersionPlugin(): Plugin {
  // Generate version at plugin creation time (build/server start)
  const buildVersion = Date.now().toString(16);
  let currentVersion = buildVersion;
  let isDev = false;
  let server: any = null;

  return {
    name: "@rangojs/router:version",
    enforce: "pre",

    configResolved(config) {
      isDev = config.command === "serve";
    },

    configureServer(devServer) {
      server = devServer;
    },

    resolveId(id) {
      if (id === VIRTUAL_IDS.version) {
        return "\0" + id;
      }
      return null;
    },

    load(id) {
      if (id === "\0" + VIRTUAL_IDS.version) {
        return getVirtualVersionContent(currentVersion);
      }
      return null;
    },

    // Track RSC module changes and update version
    hotUpdate(ctx) {
      if (!isDev) return;

      // Check if this is an RSC environment update (not client/ssr)
      // RSC modules affect server-rendered content and cached payloads
      // In Vite 6, environment is accessed via `this.environment`
      const isRscModule = this.environment?.name === "rsc";

      if (isRscModule && ctx.modules.length > 0) {
        // Update version when RSC modules change
        currentVersion = Date.now().toString(16);
        console.log(
          `[rsc-router] RSC module changed, version updated: ${currentVersion}`
        );

        // Invalidate the version module so it gets reloaded with new version
        if (server) {
          const rscEnv = server.environments?.rsc;
          if (rscEnv?.moduleGraph) {
            const versionMod = rscEnv.moduleGraph.getModuleById(
              "\0" + VIRTUAL_IDS.version
            );
            if (versionMod) {
              rscEnv.moduleGraph.invalidateModule(versionMod);
            }
          }
        }
      }
    },
  };
}

/**
 * Flatten prefix tree leaf nodes into precomputed route entries.
 * Leaf nodes have no children (no nested includes), so their routes can be
 * used directly by evaluateLazyEntry() without running the handler.
 * Non-leaf nodes are skipped because they have nested lazy includes that
 * require the handler to run for discovery.
 */
function flattenLeafEntries(
  prefixTree: Record<string, any>,
  routeManifest: Record<string, string>,
  result: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): void {
  function visit(node: any): void {
    const children = node.children || {};
    if (Object.keys(children).length === 0 && node.routes && node.routes.length > 0) {
      // Leaf node: collect its routes from the manifest
      const routes: Record<string, string> = {};
      for (const name of node.routes) {
        if (name in routeManifest) {
          routes[name] = routeManifest[name];
        }
      }
      result.push({ staticPrefix: node.staticPrefix, routes });
    } else {
      // Non-leaf: recurse into children
      for (const child of Object.values(children)) {
        visit(child);
      }
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
}

/**
 * Walk prefix tree to map each route name to its scope's staticPrefix.
 */
function buildRouteToStaticPrefix(
  prefixTree: Record<string, any>,
  result: Record<string, string>,
): void {
  function visit(node: any): void {
    const sp = node.staticPrefix || "";
    for (const name of (node.routes || [])) {
      result[name] = sp;
    }
    for (const child of Object.values(node.children || {})) {
      visit(child);
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
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
function createRouterDiscoveryPlugin(
  entryPath: string,
  opts?: { enableBuildPrerender?: boolean },
): Plugin {
  let projectRoot = "";
  let isBuildMode = false;
  let userResolveAlias: any = undefined;

  // Merged route manifest from all discovered routers.
  // Populated during discovery (dev: configureServer, build: buildStart).
  // Read by the virtual module's load hook to emit setCachedManifest() call.
  let mergedRouteManifest: Record<string, string> | null = null;

  // Concrete URLs to pre-render at build time (populated during buildStart).
  // Only used when enableBuildPrerender is true.
  let prerenderBuildUrls: string[] | null = null;
  // Maps route name -> router hash for prerender storage keys
  let prerenderRouteHashMap: Record<string, string> = {};

  // Reference to @vitejs/plugin-rsc's RscPluginManager for early manifest writes.
  // Populated during configResolved, used in closeBundle to write the assets
  // manifest before the child prerender process starts.
  let rscPluginManager: any = null;

  // Promise that resolves when dev-mode discovery completes.
  // The virtual module's load hook awaits this to ensure data is available.
  let discoveryDone: Promise<void> | null = null;

  // Pre-computed route entries from prefix tree leaf nodes.
  // Leaf nodes have no nested includes, so their routes can be used directly
  // by evaluateLazyEntry() without running the handler.
  let mergedPrecomputedEntries: Array<{
    staticPrefix: string;
    routes: Record<string, string>;
  }> | null = null;

  // Route trie for O(path_length) matching at runtime.
  let mergedRouteTrie: any = null;

  // Shared discovery logic: import entry via RSC runner, generate manifests,
  // write static files, and populate mergedRouteManifest.
  async function discoverRouters(rscEnv: any) {
    // Import the entry file via RSC environment.
    // For node preset: this is the router file (createRouter() registers in RouterRegistry).
    // For cloudflare preset: this is the worker entry (which imports the router).
    await rscEnv.runner.import(entryPath);

    // Import the router package to access the registry
    const serverMod = await rscEnv.runner.import("@rangojs/router/server");
    let registry: Map<string, any> = serverMod.RouterRegistry;

    if (!registry || registry.size === 0) {
      // No RSC routers found directly. Check for host routers with lazy handlers
      // that need to be resolved to trigger sub-app createRouter() calls.
      try {
        const hostMod = await rscEnv.runner.import("@rangojs/router/host");
        const hostRegistry: Map<string, any> | undefined = hostMod.HostRouterRegistry;

        if (hostRegistry && hostRegistry.size > 0) {
          console.log(
            `[rsc-router] Found ${hostRegistry.size} host router(s), resolving lazy handlers...`
          );

          for (const [, entry] of hostRegistry) {
            for (const route of entry.routes) {
              if (typeof route.handler === 'function') {
                try {
                  await route.handler();
                } catch {
                  // Lazy handler may fail in temp server context, that's OK
                }
              }
            }
            if (entry.fallback && typeof entry.fallback.handler === 'function') {
              try {
                await entry.fallback.handler();
              } catch {
                // Fallback handler may fail in temp server context
              }
            }
          }

          // Re-read RouterRegistry - sub-app createRouter() calls should have populated it
          const freshServerMod = await rscEnv.runner.import("@rangojs/router/server");
          const freshRegistry: Map<string, any> = freshServerMod.RouterRegistry;

          if (freshRegistry && freshRegistry.size > 0) {
            // Update references so the manifest generation below uses the fresh data
            Object.assign(serverMod, freshServerMod);
            registry = freshRegistry;
          }
        }
      } catch {
        // @rangojs/router/host not available or import failed, skip
      }

      // If still no routers after host router resolution, fail
      if (!registry || registry.size === 0) {
        throw new Error(
          `[rsc-router] No routers found in registry after importing ${entryPath}`
        );
      }
    }

    // Import build utilities for manifest generation
    const buildMod = await rscEnv.runner.import("@rangojs/router/build");
    const generateManifest = buildMod.generateManifest;

    mergedRouteManifest = {};
    mergedPrecomputedEntries = [];
    let mergedRouteAncestry: Record<string, string[]> = {};
    let mergedRouteTrailingSlash: Record<string, string> = {};

    let routerMountIndex = 0;
    // Collect all manifests for trie building (avoid re-running generateManifest)
    const allManifests: Array<{ id: string; manifest: any }> = [];

    for (const [id, router] of registry) {
      if (!router.urlpatterns || !generateManifest) {
        continue;
      }

      const manifest = generateManifest(router.urlpatterns, routerMountIndex);
      routerMountIndex++;
      allManifests.push({ id, manifest });
      const routeCount = Object.keys(manifest.routeManifest).length;
      const staticRoutes = Object.values(manifest.routeManifest).filter(
        (p: any) => !p.includes(":") && !p.includes("*")
      ).length;
      const dynamicRoutes = routeCount - staticRoutes;

      // Merge into the combined manifest
      Object.assign(mergedRouteManifest, manifest.routeManifest);

      // Merge ancestry (internal field, used only for trie building)
      if (manifest._routeAncestry) {
        Object.assign(mergedRouteAncestry, manifest._routeAncestry);
      }
      // Merge trailing slash config
      if (manifest.routeTrailingSlash) {
        Object.assign(mergedRouteTrailingSlash, manifest.routeTrailingSlash);
      }

      // Flatten prefix tree leaf nodes into precomputed entries.
      // Leaf nodes (no children) can have their routes used directly by
      // evaluateLazyEntry() without running the handler at runtime.
      flattenLeafEntries(manifest.prefixTree, manifest.routeManifest, mergedPrecomputedEntries);

      // Write static files for this router
      const hash = hashRouterId(id);
      const outDir = join(projectRoot, "dist", "static", `__${hash}`);
      mkdirSync(outDir, { recursive: true });

      writeFileSync(
        join(outDir, "routes.json"),
        JSON.stringify(manifest.routeManifest, null, 2) + "\n"
      );

      writeFileSync(
        join(outDir, "prefixes.json"),
        JSON.stringify(manifest.prefixTree, null, 2) + "\n"
      );

      console.log(
        `[rsc-router] Router "${id}" -> ${routeCount} routes ` +
        `(${staticRoutes} static, ${dynamicRoutes} dynamic) ` +
        `-> dist/static/__${hash}/`
      );
    }

    // Build route trie from merged manifest + ancestry
    if (mergedRouteManifest && Object.keys(mergedRouteManifest).length > 0) {
      const buildRouteTrie = buildMod.buildRouteTrie;
      if (buildRouteTrie && mergedRouteAncestry) {
        // Build routeToStaticPrefix from saved manifests
        const routeToStaticPrefix: Record<string, string> = {};
        for (const { manifest } of allManifests) {
          // Root-level routes have empty static prefix
          for (const name of Object.keys(manifest.routeManifest)) {
            if (!(name in routeToStaticPrefix)) {
              routeToStaticPrefix[name] = "";
            }
          }
          buildRouteToStaticPrefix(manifest.prefixTree, routeToStaticPrefix);
        }

        // Collect prerender route names from all manifests
        const prerenderRouteNames = new Set<string>();
        for (const { manifest } of allManifests) {
          if (manifest.prerenderRoutes) {
            for (const name of manifest.prerenderRoutes) {
              prerenderRouteNames.add(name);
            }
          }
        }

        mergedRouteTrie = buildRouteTrie(
          mergedRouteManifest,
          mergedRouteAncestry,
          routeToStaticPrefix,
          Object.keys(mergedRouteTrailingSlash).length > 0 ? mergedRouteTrailingSlash : undefined,
          prerenderRouteNames.size > 0 ? prerenderRouteNames : undefined,
        );
        // Trie built successfully
      }
    }

    // Expand prerender routes into concrete URLs for build-time rendering.
    // Static routes use pattern as-is; dynamic routes call getParams() to enumerate.
    if (opts?.enableBuildPrerender) {
      const urls: string[] = [];
      const routeHashMap: Record<string, string> = {};
      for (const { id, manifest } of allManifests) {
        if (!manifest.prerenderRoutes) continue;
        const rHash = hashRouterId(id);
        const defs = manifest._prerenderDefs || {};
        for (const routeName of manifest.prerenderRoutes) {
          routeHashMap[routeName] = rHash;
          const pattern = manifest.routeManifest[routeName];
          if (!pattern) continue;
          const hasDynamic = pattern.includes(":") || pattern.includes("*");
          if (!hasDynamic) {
            // Static route: use pattern directly (strip trailing slash for URL)
            urls.push(pattern.replace(/\/$/, "") || "/");
          } else {
            // Dynamic route: call getParams() to enumerate param combinations
            const def = defs[routeName];
            if (def?.getParams) {
              try {
                const paramsList = await def.getParams();
                for (const params of paramsList) {
                  let url = pattern;
                  for (const [key, value] of Object.entries(params as Record<string, string>)) {
                    url = url.replace(`:${key}`, encodeURIComponent(String(value)));
                  }
                  urls.push(url.replace(/\/$/, "") || "/");
                }
              } catch (err: any) {
                console.warn(
                  `[rsc-router] Failed to get params for prerender route "${routeName}": ${err.message}`
                );
              }
            } else {
              console.warn(
                `[rsc-router] Dynamic prerender route "${routeName}" has no getParams(), skipping`
              );
            }
          }
        }
      }
      if (urls.length > 0) {
        prerenderBuildUrls = urls;
        prerenderRouteHashMap = routeHashMap;
        console.log(
          `[rsc-router] Pre-render URLs: ${urls.join(", ")}`
        );
      }
    }

    return serverMod;
  }

  return {
    name: "@rangojs/router:discovery",

    configResolved(config) {
      projectRoot = config.root;
      isBuildMode = config.command === "build";
      // Capture user's resolve aliases for the temp server
      userResolveAlias = config.resolve.alias;
      // Capture @vitejs/plugin-rsc manager for early manifest writes during prerender.
      // The manager's buildAssetsManifest is populated during client generateBundle,
      // but writeAssetsManifest is called after all closeBundle hooks complete.
      // We call it early in our closeBundle so the child process can import it.
      if (opts?.enableBuildPrerender) {
        const rscPlugin = config.plugins.find((p: any) => p.name === "rsc:minimal");
        if (rscPlugin?.api?.manager) {
          rscPluginManager = rscPlugin.api.manager;
        }
      }
    },

    // Dev mode: discover routers and populate manifest in memory.
    // Skipped in build mode (buildStart handles it).
    configureServer(server) {
      if (isBuildMode) return;
      // Skip if this is a temp server created by buildStart
      if ((globalThis as any).__rscRouterDiscoveryActive) return;

      // Discovery promise that the handler can await if requests arrive
      // before discovery completes
      let resolveDiscovery: () => void;
      const discoveryPromise = new Promise<void>((resolve) => {
        resolveDiscovery = resolve;
      });

      const discover = async () => {
        const rscEnv = (server.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          resolveDiscovery!();
          return;
        }

        try {
          // Set the readiness gate BEFORE discovery so early requests
          // block until manifest is populated
          const serverMod = await rscEnv.runner.import("@rangojs/router/server");
          if (serverMod?.setManifestReadyPromise) {
            serverMod.setManifestReadyPromise(discoveryPromise);
          }

          await discoverRouters(rscEnv);

          // Populate the route map in the RSC env
          if (mergedRouteManifest && serverMod?.setCachedManifest) {
            serverMod.setCachedManifest(mergedRouteManifest);
          }
          if (mergedPrecomputedEntries && mergedPrecomputedEntries.length > 0 && serverMod?.setPrecomputedEntries) {
            serverMod.setPrecomputedEntries(mergedPrecomputedEntries);
          }
          if (mergedRouteTrie && serverMod?.setRouteTrie) {
            serverMod.setRouteTrie(mergedRouteTrie);
          }
        } catch (err: any) {
          console.warn(
            `[rsc-router] Router discovery failed: ${err.message}\n${err.stack}`
          );
        } finally {
          resolveDiscovery!();
        }
      };

      // Schedule after all plugins have finished configureServer.
      // Store the promise so the virtual module's load hook can await it.
      discoveryDone = new Promise<void>((resolve) => {
        setTimeout(() => discover().then(resolve, resolve), 0);
      });
    },

    // Build mode: create a temporary Vite dev server to access the RSC
    // environment's module runner, then discover routers and generate manifests.
    // The manifest data is stored for the virtual module's load hook.
    async buildStart() {
      if (!isBuildMode) return;
      // Only run once across environment builds
      if (mergedRouteManifest !== null) return;

      let tempServer: any = null;
      try {
        // Prevent the temp server's plugin instances from running discovery
        (globalThis as any).__rscRouterDiscoveryActive = true;

        // Create a minimal Vite server with just the RSC plugin.
        // We bypass the user's config file because:
        // - Custom environments (e.g., CloudflareDevEnvironment) may not expose
        //   a module runner compatible with runner.import()
        // - The temp server only needs RSC conditions to import the router
        const { default: rsc } = await import("@vitejs/plugin-rsc");
        tempServer = await createViteServer({
          root: projectRoot,
          configFile: false,
          server: { middlewareMode: true },
          appType: "custom",
          logLevel: "silent",
          // Use the resolved aliases from the real config (includes user's path aliases
          // like @/ -> src/ AND package aliases from rsc-router)
          resolve: { alias: userResolveAlias },
          // Enable automatic JSX runtime so .tsx files don't need `import React`.
          // Without this, esbuild defaults to classic mode (React.createElement)
          // which fails when lazy host-router handlers load sub-app modules with JSX.
          esbuild: { jsx: "automatic", jsxImportSource: "react" },
          plugins: [
            rsc({ entries: { client: "virtual:entry-client", ssr: "virtual:entry-ssr", rsc: entryPath } }),
            createVersionPlugin(),
            // Stub virtual modules that the RSC entry may import
            // (e.g., virtual:rsc-router/routes-manifest, virtual:rsc-router/loader-manifest)
            createVirtualStubPlugin(),
          ],
        });

        const rscEnv = (tempServer.environments as any)?.rsc;
        if (!rscEnv?.runner) {
          console.warn(
            "[rsc-router] RSC environment runner not available during build, skipping manifest generation"
          );
          return;
        }

        await discoverRouters(rscEnv);
      } catch (err: any) {
        // Clean up before re-throwing so the temp server doesn't leak
        delete (globalThis as any).__rscRouterDiscoveryActive;
        if (tempServer) {
          await tempServer.close();
        }
        throw new Error(
          `[rsc-router] Build-time router discovery failed: ${err.message}`
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
      // virtual:rsc-router/prerender-paths removed: prerender data is served through the worker
      return null;
    },

    async load(id) {
      if (id === "\0" + VIRTUAL_ROUTES_MANIFEST_ID) {
        // In dev mode, wait for discovery to complete before emitting module content.
        // This is critical for Cloudflare dev where the worker runs in a separate
        // Miniflare process and can only receive manifest data via the virtual module.
        if (discoveryDone) {
          await discoveryDone;
          console.log(`[rsc-router] Virtual module loaded after discovery (${mergedRouteManifest ? Object.keys(mergedRouteManifest).length + ' routes' : 'no data'})`);
        }
        const hasManifest = mergedRouteManifest && Object.keys(mergedRouteManifest).length > 0;
        if (hasManifest) {
          const lines = [
            `import { setCachedManifest, setPrecomputedEntries, setRouteTrie } from "@rangojs/router/server";`,
            `setCachedManifest(${JSON.stringify(mergedRouteManifest)});`,
          ];
          if (mergedPrecomputedEntries && mergedPrecomputedEntries.length > 0) {
            lines.push(`setPrecomputedEntries(${JSON.stringify(mergedPrecomputedEntries)});`);
          }
          if (mergedRouteTrie) {
            lines.push(`setRouteTrie(${JSON.stringify(mergedRouteTrie)});`);
          }
          return lines.join("\n");
        }
        // No manifest available yet (dev mode: discovery hasn't completed)
        return `// Route manifest will be populated at runtime`;
      }
      // virtual:rsc-router/prerender-paths load handler removed
      return null;
    },

    // Build-time pre-rendering: spawn a child Node.js process to import the
    // built worker and render each prerender URL to static HTML.
    // A separate process is needed because Vite registers module resolution
    // hooks that interfere with importing the bundled worker.
    // closeBundle fires for each environment build. We wait until the SSR
    // build (last in sequence) completes before pre-rendering, because the
    // client build (step 4/5) clears dist/client/ via emptyOutDir.
    closeBundle: {
      order: "post" as const,
      sequential: true,
      async handler() {
      if (!isBuildMode || !prerenderBuildUrls?.length) return;

      // The assets manifest is populated during the client build (step 4/5).
      // If it's not set yet, we're in an earlier build step — bail out without
      // consuming prerenderBuildUrls so we can retry on the next closeBundle call.
      if (!rscPluginManager?.buildAssetsManifest) return;

      // The SSR bundle must exist (written during step 5/5). Without it the
      // worker import will fail. Bail without consuming urls so the next
      // closeBundle call (after SSR build) can proceed.
      const ssrPath = resolve(projectRoot, "dist/rsc/ssr/index.js");
      if (!existsSync(ssrPath)) return;

      // Guard: only run once across environment builds
      if (prerenderBuildUrls === null) return;
      const urlsToRender = prerenderBuildUrls;
      prerenderBuildUrls = null;

      // Write the assets manifest early. @vitejs/plugin-rsc populates
      // buildAssetsManifest during the client build's generateBundle hook,
      // but calls writeAssetsManifest() AFTER builder.build(ssr) returns.
      // Since closeBundle fires DURING builder.build(ssr), the file doesn't
      // exist yet. We call writeAssetsManifest ourselves so the child
      // prerender process can import it. The RSC plugin overwrites it
      // with identical data later.
      try {
        rscPluginManager.writeAssetsManifest(["ssr", "rsc"]);
      } catch (err: any) {
        console.warn(
          `[rsc-router] Failed to write assets manifest early: ${err.message}`
        );
      }

      console.log(
        `[rsc-router] Pre-rendering ${urlsToRender.length} route(s)...`
      );

      // Generate a temporary script that runs in a clean Node.js process.
      // This avoids Vite's module resolution hooks interfering with imports.
      const scriptPath = resolve(projectRoot, "dist/.prerender.mjs");
      const scriptContent = generatePrerenderScript(projectRoot, urlsToRender, prerenderRouteHashMap);
      writeFileSync(scriptPath, scriptContent);

      try {
        const { execFileSync } = await import("node:child_process");
        // Clear NODE_OPTIONS and tsx loader flags to prevent Vite's module
        // resolution hooks from being inherited by the child process.
        const cleanEnv = { ...process.env };
        delete cleanEnv.NODE_OPTIONS;
        delete cleanEnv.TSX;
        execFileSync(process.execPath, ["--no-warnings", scriptPath], {
          stdio: "inherit",
          cwd: projectRoot,
          env: cleanEnv,
        });

        // Surgically replace handler function bodies with stubs in the chunk.
        // The chunk also contains framework code (shared deps) that must stay intact.
        // We replace each createPrerenderHandler(...) call with a stub object and
        // remove the $$id assignment line.
        if (handlerChunkInfo) {
          const chunkPath = resolve(projectRoot, "dist/rsc", handlerChunkInfo.fileName);
          try {
            let code = readFileSync(chunkPath, "utf-8");
            const originalSize = Buffer.byteLength(code);

            for (const { name, handlerId } of handlerChunkInfo.exports) {
              // Find start: "const Name = createPrerenderHandler"
              const callStartRe = new RegExp(
                `const\\s+${name}\\s*=\\s*createPrerenderHandler`,
              );
              const startMatch = callStartRe.exec(code);
              if (!startMatch) continue;

              // The $$id string is always the last argument in the call.
              // Find it to locate the end: "handlerId"\s*);
              const escapedId = handlerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const endRe = new RegExp(
                `"${escapedId}"\\s*\\);`,
              );
              const endMatch = endRe.exec(code.slice(startMatch.index));
              if (!endMatch) continue;

              const rangeEnd = startMatch.index + endMatch.index + endMatch[0].length;
              const stub = `const ${name} = { __brand: "prerenderHandler", $$id: "${handlerId}" };`;
              code = code.slice(0, startMatch.index) + stub + code.slice(rangeEnd);

              // Remove the $$id assignment line (now redundant)
              code = code.replace(
                new RegExp(`\\n${name}\\.\\$\\$id\\s*=\\s*"[^"]+";`),
                "",
              );
            }

            writeFileSync(chunkPath, code);
            const newSize = Buffer.byteLength(code);
            const savedKB = ((originalSize - newSize) / 1024).toFixed(1);
            console.log(
              `[rsc-router] Evicted handler code from RSC bundle (${savedKB} KB saved): ${handlerChunkInfo.fileName}`,
            );
          } catch (replaceErr: any) {
            console.warn(
              `[rsc-router] Failed to evict handler code: ${replaceErr.message}`,
            );
          }
        }
        // Inject pre-rendered data into the RSC worker bundle.
        // Read all .flight files written by the child process and embed them
        // as globalThis.__PRERENDER_DATA so the worker can serve them at runtime.
        try {
          const { readdirSync: readDir } = await import("node:fs");
          const prerenderData: Record<string, any> = {};
          const staticDir = resolve(projectRoot, "dist/static");
          for (const hashDir of readDir(staticDir).filter((d: string) => d.startsWith("__"))) {
            const prerenderDir = resolve(staticDir, hashDir, "prerender");
            if (!existsSync(prerenderDir)) continue;
            for (const routeDir of readDir(prerenderDir)) {
              const routePath = resolve(prerenderDir, routeDir);
              for (const file of readDir(routePath).filter((f: string) => f.endsWith(".flight"))) {
                const paramHash = file.slice(0, -7); // strip ".flight"
                const key = `${routeDir}/${paramHash}`;
                const content = readFileSync(resolve(routePath, file), "utf-8");
                prerenderData[key] = JSON.parse(content);
              }
            }
          }

          if (Object.keys(prerenderData).length > 0) {
            const rscEntryPath = resolve(projectRoot, "dist/rsc/index.js");
            if (existsSync(rscEntryPath)) {
              let rscCode = readFileSync(rscEntryPath, "utf-8");
              const injection = `globalThis.__PRERENDER_DATA = ${JSON.stringify(prerenderData)};\n`;
              rscCode = injection + rscCode;
              writeFileSync(rscEntryPath, rscCode);
              const dataSize = (Buffer.byteLength(injection) / 1024).toFixed(1);
              console.log(
                `[rsc-router] Injected prerender data into RSC bundle (${dataSize} KB, ${Object.keys(prerenderData).length} entries)`,
              );
            }
          }
        } catch (injectErr: any) {
          console.warn(
            `[rsc-router] Failed to inject prerender data: ${injectErr.message}`,
          );
        }
      } catch (err: any) {
        console.warn(
          `[rsc-router] Build-time pre-rendering failed: ${err.message}`
        );
      } finally {
        // Clean up the temporary script
        try {
          const { rmSync } = await import("node:fs");
          rmSync(scriptPath, { force: true });
        } catch {}
      }
      },
    },
  };
}

/**
 * Generate a standalone Node.js script that collects serialized segment data
 * for pre-rendered routes. Writes .flight JSON files to dist/static/.
 * The script runs in a separate process to avoid Vite's module resolution hooks.
 */
function generatePrerenderScript(
  projectRoot: string,
  urls: string[],
  routeHashMap: Record<string, string>,
): string {
  return `
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = ${JSON.stringify(projectRoot)};
const urls = ${JSON.stringify(urls)};
const routeHashMap = ${JSON.stringify(routeHashMap)};

// DJB2 hash matching the runtime param-hash utility
function djb2Hex(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hashParams(params) {
  const entries = Object.entries(params);
  if (entries.length === 0) return "_";
  const sorted = entries.sort(([a], [b]) => a.localeCompare(b));
  const str = sorted.map(([k, v]) => k + "=" + v).join("&");
  return djb2Hex(str);
}

// Extract params from a URL by matching against the route pattern.
// The route pattern uses :paramName syntax.
function extractParams(urlPath, pattern) {
  const urlParts = urlPath.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      const paramName = patternParts[i].slice(1);
      params[paramName] = decodeURIComponent(urlParts[i] || "");
    }
  }
  return params;
}

// Mock workerd globals (bundled worker accesses globalThis.Cloudflare.compatibilityFlags)
globalThis.Cloudflare = { compatibilityFlags: { enable_nodejs_process_v2: false } };

// Create symlinks for project root directories under dist/ so that relative
// paths from import.meta.dirname (dist/rsc/assets/) resolve correctly.
const symlinks = [];
try {
  for (const entry of readdirSync(projectRoot)) {
    if (entry === "dist" || entry === "node_modules" || entry.startsWith(".")) continue;
    const target = resolve(projectRoot, entry);
    const link = resolve(projectRoot, "dist", entry);
    try {
      if (!existsSync(link) && statSync(target).isDirectory()) {
        symlinkSync(target, link);
        symlinks.push(link);
      }
    } catch {}
  }
} catch {}

const mockEnv = new Proxy({}, {
  get(_, prop) {
    if (prop === "toString" || prop === Symbol.toPrimitive) return () => "[PrerenderEnv]";
    if (prop === Symbol.toStringTag) return "PrerenderEnv";
    if (prop === "Variables") return {};
    if (prop === "ASSETS") return { fetch: () => new Response("", { status: 404 }) };
    throw new Error("Cloudflare binding \\"" + String(prop) + "\\" not available in prerender");
  },
});
const mockCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

try {
  const mod = await import(resolve(projectRoot, "dist/rsc/index.js"));
  const worker = mod.default;
  if (!worker?.fetch) {
    console.warn("[rsc-router] Built worker has no fetch handler, skipping pre-render");
    process.exit(0);
  }

  let rendered = 0;
  for (const urlPath of urls) {
    try {
      // Collect serialized segments for this route
      const response = await worker.fetch(
        new Request("http://localhost" + urlPath + "?__no_cache&__prerender_collect", {
          headers: { Accept: "text/html" },
        }),
        mockEnv,
        mockCtx,
      );
      if (response.status !== 200) {
        console.warn("[rsc-router] Pre-render collect " + urlPath + " returned " + response.status + ", skipping");
        continue;
      }
      const data = await response.json();
      const { segments, handles, routeName } = data;
      if (!routeName || !segments) {
        console.warn("[rsc-router] Pre-render collect " + urlPath + " missing routeName or segments, skipping");
        continue;
      }

      const routerHash = routeHashMap[routeName];
      if (!routerHash) {
        console.warn("[rsc-router] No router hash for route " + routeName + ", skipping");
        continue;
      }

      // Compute param hash from the matched route params
      // The response carries routeName; we compute params from the URL
      // using the route manifest pattern. For static routes, paramHash is "_".
      const paramHash = hashParams(data.params || {});

      // Write .flight file
      const flightDir = resolve(projectRoot, "dist", "static",
        "__" + routerHash, "prerender", routeName);
      mkdirSync(flightDir, { recursive: true });
      const flightPath = resolve(flightDir, paramHash + ".flight");
      writeFileSync(flightPath, JSON.stringify({ segments, handles }));

      rendered++;
      console.log("[rsc-router] Pre-rendered: " + routeName + " (" + urlPath + ") -> " + paramHash + ".flight");
    } catch (err) {
      console.warn("[rsc-router] Pre-render failed for " + urlPath + ": " + err.message);
    }
  }

  if (rendered > 0) {
    console.log("[rsc-router] Pre-rendered " + rendered + "/" + urls.length + " route(s) to dist/static/");
  }
} finally {
  for (const link of symlinks) {
    try { rmSync(link); } catch {}
  }
}
`.trim();
}

const VIRTUAL_ROUTES_MANIFEST_ID = "virtual:rsc-router/routes-manifest";
// VIRTUAL_PRERENDER_PATHS_ID removed: prerender data is served through the worker

/**
 * Resolve the entry path for build-time router discovery.
 * - Node preset: uses the required `router` option.
 * - Cloudflare preset: reads the `main` field from wrangler.json.
 */
function resolveDiscoveryEntryPath(options: RangoOptions): string | undefined {
  if (options.preset === "cloudflare") {
    // Auto-detect from wrangler.json
    const wranglerPaths = ["wrangler.json", "wrangler.jsonc"];
    for (const filename of wranglerPaths) {
      if (existsSync(filename)) {
        try {
          const raw = readFileSync(filename, "utf-8");
          // Strip JSON comments for .jsonc
          const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
          const config = JSON.parse(cleaned);
          if (config.main) {
            return config.main;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    return undefined;
  }
  // Node preset: router is required
  return (options as RangoNodeOptions).router;
}

/**
 * Stub plugin for virtual modules in the temp discovery server.
 * The RSC entry may import virtual modules (routes-manifest, loader-manifest)
 * that aren't available in the temp server. The RSC plugin also requires
 * client/ssr entries which don't need real content for discovery.
 */
function createVirtualStubPlugin(): Plugin {
  const STUB_PREFIXES = [
    "virtual:rsc-router/",
    "virtual:entry-",
    "virtual:vite-rsc/",
  ];
  return {
    name: "@rangojs/router:virtual-stubs",
    resolveId(id) {
      if (STUB_PREFIXES.some((p) => id.startsWith(p))) {
        return "\0stub:" + id;
      }
      return null;
    },
    load(id) {
      if (id.startsWith("\0stub:")) {
        return "export default {}";
      }
      return null;
    },
  };
}

/**
 * Generate a deterministic 12-char hex hash from a router id.
 * Used to create collision-free directory names for per-router static output.
 */
function hashRouterId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/**
 * Plugin that auto-injects VERSION and routes-manifest into custom entry.rsc files.
 * If a custom entry.rsc file uses createRSCHandler but doesn't pass version,
 * this transform adds the import and property automatically.
 * Also ensures the routes-manifest virtual module is always imported.
 * @internal
 */
function createVersionInjectorPlugin(rscEntryPath: string): Plugin {
  let projectRoot = "";
  let resolvedEntryPath = "";

  return {
    name: "@rangojs/router:version-injector",
    enforce: "pre",

    configResolved(config) {
      projectRoot = config.root;
      resolvedEntryPath = resolve(projectRoot, rscEntryPath);
    },

    transform(code, id) {
      // Only transform the RSC entry file
      const normalizedId = Vite.normalizePath(id);
      const normalizedEntry = Vite.normalizePath(resolvedEntryPath);

      if (normalizedId !== normalizedEntry) {
        return null;
      }

      let newCode = code;
      let changed = false;

      // Auto-inject routes-manifest import if not already present.
      // This ensures the build-time manifest is always loaded at startup,
      // regardless of whether the user uses virtual entries or a custom worker entry.
      if (!newCode.includes("virtual:rsc-router/routes-manifest")) {
        const lastImportIndex = newCode.lastIndexOf("import ");
        if (lastImportIndex !== -1) {
          const afterLastImport = newCode.indexOf("\n", lastImportIndex);
          if (afterLastImport !== -1) {
            let insertIndex = afterLastImport + 1;
            while (
              insertIndex < newCode.length &&
              (newCode.slice(insertIndex).match(/^\s*(from|import)\s/) ||
                newCode[insertIndex] === "\n")
            ) {
              const nextNewline = newCode.indexOf("\n", insertIndex);
              if (nextNewline === -1) break;
              insertIndex = nextNewline + 1;
            }
            const manifestImport = `import "virtual:rsc-router/routes-manifest";\n`;
            newCode = newCode.slice(0, insertIndex) + manifestImport + newCode.slice(insertIndex);
            changed = true;
          }
        }
      }

      // Auto-inject VERSION if file uses createRSCHandler without version
      if (
        newCode.includes("createRSCHandler") &&
        !newCode.includes("@rangojs/router:version") &&
        newCode.match(/createRSCHandler\s*\(\s*\{/)
      ) {
        const lastImportIndex = newCode.lastIndexOf("import ");
        if (lastImportIndex !== -1) {
          const afterLastImport = newCode.indexOf("\n", lastImportIndex);
          if (afterLastImport !== -1) {
            let insertIndex = afterLastImport + 1;
            while (
              insertIndex < newCode.length &&
              (newCode.slice(insertIndex).match(/^\s*(from|import)\s/) ||
                newCode[insertIndex] === "\n")
            ) {
              const nextNewline = newCode.indexOf("\n", insertIndex);
              if (nextNewline === -1) break;
              insertIndex = nextNewline + 1;
            }
            const versionImport = `import { VERSION } from "@rangojs/router:version";\n`;
            newCode = newCode.slice(0, insertIndex) + versionImport + newCode.slice(insertIndex);
          }
        }

        newCode = newCode.replace(
          /createRSCHandler\s*\(\s*\{/,
          "createRSCHandler({\n  version: VERSION,"
        );
        changed = true;
      }

      if (!changed) return null;

      return {
        code: newCode,
        map: null,
      };
    },
  };
}

const _require = createRequire(import.meta.url);
const _rangoVersion: string = _require("../../package.json").version;

let _bannerPrinted = false;

function printBanner(
  mode: "dev" | "build" | "preview",
  preset: string,
  version: string
): void {
  if (_bannerPrinted) return;
  _bannerPrinted = true;

  // ANSI codes
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  const banner = `
${dim}  ✦        ✦          ✧.           .          .${reset}
${dim} ╱${reset}    ${bold}╔═╗${reset}${dim}      *      ╱                   ✦             *${reset}
${dim}      ${reset}${bold}║ ║${reset} ${bold}╔═╗${reset}${dim}                    *                ✧.   ╱${reset}
${dim}   ${reset}${bold}╔╗ ║ ║ ║ ║${reset}${dim}                          *               ╱${reset}
${dim}   ${reset}${bold}║║ ║ ║ ║ ║  ╦═╗╔═╗╔╗╔╔═╗╔═╗${reset}${dim}             ✧              ✦${reset}
${dim}  ${reset}${bold}═╣║ ║ ╠═╝ ║  ╠╦╝╠═╣║║║║ ╦║ ║${reset}${dim}        *           ✧${reset}
${dim}   ${reset}${bold}║╚═╝ ╔═══╝  ╩╚═╩ ╩╝╚╝╚═╝╚═╝${reset}${dim}            ✦          .      *${reset}
${dim}   ${reset}${bold}╚══╗ ║${reset}${dim} *      RSC Wrangler         ✧                ✦${reset}
${dim}  *   ${reset}${bold}║ ╠═${reset}${dim}                         *            ✧.    ╱${reset}
${bold}══════╝ ╚═════════╩═══${reset}${dim}                  ✦            *${reset}

   v${version} · ${preset} · ${mode}
`;

  console.log(banner);
}

/**
 * Vite plugin for @rangojs/router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rango({ router: './src/router.tsx' })],
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rango({ preset: 'cloudflare' }),
 *     cloudflare({ viteEnvironment: { name: 'rsc' } }),
 *   ],
 * });
 * ```
 */
export async function rango(
  options: RangoOptions
): Promise<PluginOption[]> {
  const preset = options.preset ?? "node";
  const enableExposeActionId = options.exposeActionId ?? true;
  const showBanner = options.banner ?? true;

  const plugins: PluginOption[] = [];

  // Get package resolution info (workspace vs npm install)
  const rangoAliases = getPackageAliases();
  const excludeDeps = getExcludeDeps();

  // Track RSC entry path for version injection
  let rscEntryPath: string | null = null;

  // Build-time prerendering is always enabled for cloudflare preset.
  // Handlers now run in the RSC env directly (no separate Node.js server needed).
  const prerenderEnabled = preset === "cloudflare";

  if (preset === "cloudflare") {
    // Cloudflare preset: configure entries for cloudflare worker setup
    // Router is not needed here - worker.rsc.tsx imports it directly

    // Dynamically import @vitejs/plugin-rsc
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    // Only client and ssr entries - rsc entry is handled by cloudflare plugin
    // Always use virtual modules for cloudflare preset
    const finalEntries: { client: string; ssr: string } = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
    };

    plugins.push({
      name: "@rangojs/router:cloudflare-integration",
      enforce: "pre",
      config() {
        // Configure environments for cloudflare deployment
        return {
          // Exclude rsc-router modules from optimization to prevent module duplication
          // This ensures the same Context instance is used by both browser entry and RSC proxy modules
          optimizeDeps: {
            exclude: excludeDeps,
            esbuildOptions: sharedEsbuildOptions,
          },
          resolve: {
            alias: rangoAliases,
          },
          environments: {
            client: {
              build: {
                rollupOptions: {
                  output: {
                    manualChunks: getManualChunks,
                  },
                },
              },
              // Pre-bundle rsc-html-stream to prevent discovery during first request
              // Exclude rsc-router modules to ensure same Context instance
              optimizeDeps: {
                include: ["rsc-html-stream/client"],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            ssr: {
              // Build SSR inside RSC directory so wrangler can deploy self-contained dist/rsc
              build: {
                outDir: "./dist/rsc/ssr",
              },
              resolve: {
                // Ensure single React instance in SSR child environment
                dedupe: ["react", "react-dom"],
              },
              // Pre-bundle SSR entry and React for proper module linking with childEnvironments
              // Exclude rsc-router modules to ensure same Context instance
              optimizeDeps: {
                entries: [finalEntries.ssr],
                include: [
                  "react",
                  "react-dom/server.edge",
                  "react/jsx-runtime",
                  "rsc-html-stream/server",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            rsc: {
              build: {
                rollupOptions: {
                  output: {
                    manualChunks(id) {
                      if (prerenderHandlerModules.has(id)) {
                        return "__prerender-handlers";
                      }
                    },
                  },
                },
              },
              // RSC environment needs exclude list and esbuild options
              // Exclude rsc-router modules to prevent createContext in RSC environment
              optimizeDeps: {
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
          },
        };
      },

      configResolved(config) {
        if (showBanner) {
          const mode = config.command === "serve" ? (process.argv.includes("preview") ? "preview" : "dev") : "build";
          printBanner(mode, "cloudflare", _rangoVersion);
        }
      },

      // Record handler chunk metadata during RSC build for post-prerender replacement.
      // Rollup minifies EXPORT names (e.g. ArticlesIndex -> r) but keeps internal
      // variable names intact. We search for original names from prerenderHandlerModules.
      generateBundle(_options, bundle) {
        if (this.environment?.name !== "rsc") return;

        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== "chunk") continue;
          if (!fileName.includes("__prerender-handlers")) continue;

          const handlers: Array<{ name: string; handlerId: string }> = [];
          // Use original handler names (internal variable names are NOT minified)
          for (const [, handlerNames] of prerenderHandlerModules) {
            for (const name of handlerNames) {
              const idPattern = new RegExp(
                `\\b${name}\\.\\$\\$id\\s*=\\s*"([^"]+)"`,
              );
              const match = chunk.code.match(idPattern);
              if (match) {
                handlers.push({ name, handlerId: match[1] });
              }
            }
          }

          if (handlers.length > 0) {
            handlerChunkInfo = { fileName, exports: handlers };
          }
          break;
        }
      },

    });

    plugins.push(createVirtualEntriesPlugin(finalEntries));

    // Add RSC plugin with cloudflare-specific options
    // Note: loadModuleDevProxy should NOT be used with childEnvironments
    // since SSR runs in workerd alongside RSC
    plugins.push(
      rsc({
        get entries() {
          return finalEntries;
        },
        serverHandler: false,
      }) as PluginOption
    );
  } else {
    // Node preset: full RSC plugin integration
    const nodeOptions = options as RangoNodeOptions;
    const routerPath = nodeOptions.router;
    const rscOption = nodeOptions.rsc ?? true;

    // Add RSC plugin by default (can be disabled with rsc: false)
    if (rscOption !== false) {
      // Dynamically import @vitejs/plugin-rsc
      const { default: rsc } = await import("@vitejs/plugin-rsc");

      // Resolve entry paths: use explicit config or virtual modules
      const userEntries =
        typeof rscOption === "boolean" ? {} : rscOption.entries || {};
      const finalEntries = {
        client: userEntries.client ?? VIRTUAL_IDS.browser,
        ssr: userEntries.ssr ?? VIRTUAL_IDS.ssr,
        rsc: userEntries.rsc ?? VIRTUAL_IDS.rsc,
      };

      // Track RSC entry for version injection (only if custom entry provided)
      rscEntryPath = userEntries.rsc ?? null;

      // Create wrapper plugin that checks for duplicates
      let hasWarnedDuplicate = false;

      plugins.push({
        name: "@rangojs/router:rsc-integration",
        enforce: "pre",

        config() {
          // Configure environments for RSC
          // When using virtual entries, we need to explicitly configure optimizeDeps
          // so Vite pre-bundles React before processing the virtual modules.
          // Without this, the dep optimizer may run multiple times with different hashes,
          // causing React instance mismatches.
          const useVirtualClient = finalEntries.client === VIRTUAL_IDS.browser;
          const useVirtualSSR = finalEntries.ssr === VIRTUAL_IDS.ssr;
          const useVirtualRSC = finalEntries.rsc === VIRTUAL_IDS.rsc;

          return {
            // Exclude rsc-router modules from optimization to prevent module duplication
            // This ensures the same Context instance is used by both browser entry and RSC proxy modules
            optimizeDeps: {
              exclude: excludeDeps,
              esbuildOptions: sharedEsbuildOptions,
            },
            resolve: {
              alias: rangoAliases,
            },
            environments: {
              client: {
                build: {
                  rollupOptions: {
                    output: {
                      manualChunks: getManualChunks,
                    },
                  },
                },
                // Always exclude rsc-router modules, conditionally add virtual entry
                optimizeDeps: {
                  exclude: excludeDeps,
                  esbuildOptions: sharedEsbuildOptions,
                  ...(useVirtualClient && {
                    // Tell Vite to scan the virtual entry for dependencies
                    entries: [VIRTUAL_IDS.browser],
                  }),
                },
              },
              ...(useVirtualSSR && {
                ssr: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.ssr],
                    // Pre-bundle React for SSR to ensure single instance
                    include: ["react", "react-dom/server.edge", "react/jsx-runtime"],
                    exclude: excludeDeps,
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
              ...(useVirtualRSC && {
                rsc: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.rsc],
                    // Pre-bundle React for RSC to ensure single instance
                    include: ["react", "react/jsx-runtime"],
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
            },
          };
        },

        configResolved(config) {
          if (showBanner) {
            const mode = config.command === "serve" ? (process.argv.includes("preview") ? "preview" : "dev") : "build";
            printBanner(mode, "node", _rangoVersion);
          }

          // Count how many RSC base plugins there are (rsc:minimal is the main one)
          const rscMinimalCount = config.plugins.filter(
            (p) => p.name === "rsc:minimal"
          ).length;

          if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
            hasWarnedDuplicate = true;
            console.warn(
              "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
                "Remove rsc() from your config or use rango({ rsc: false }) for manual configuration."
            );
          }
        },
      });

      // Add virtual entries plugin
      plugins.push(createVirtualEntriesPlugin(finalEntries, routerPath));

      // Add the RSC plugin directly
      // Cast to PluginOption to handle type differences between bundled vite types
      plugins.push(
        rsc({
          entries: finalEntries,
        }) as PluginOption
      );
    }
  }

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  // Always add exposeLoaderId for GET-based loader fetching with useFetchLoader
  plugins.push(exposeLoaderId());

  // Always add exposeHandleId for auto-generated handle IDs
  plugins.push(exposeHandleId());

  // Always add exposeLocationStateId for auto-generated location state keys
  plugins.push(exposeLocationStateId());

  // Always add exposePrerenderHandlerId for auto-generated prerender handler IDs
  plugins.push(exposePrerenderHandlerId());

  // Add version virtual module plugin for cache invalidation
  plugins.push(createVersionPlugin());

  // Resolve discovery entry path (used for both discovery and version injection).
  // Node preset: uses the required router path.
  // Cloudflare preset: auto-detects RSC entry from wrangler.json main field.
  const discoveryEntryPath = resolveDiscoveryEntryPath(options);

  // Add version injector for custom entry.rsc files.
  // For Cloudflare preset, the RSC entry is the worker file (from wrangler.json).
  const injectorEntryPath = rscEntryPath ?? (preset === "cloudflare" ? discoveryEntryPath : null);
  if (injectorEntryPath) {
    plugins.push(createVersionInjectorPlugin(injectorEntryPath));
  }

  // Transform CJS vendor files to ESM for browser compatibility
  // optimizeDeps.include doesn't work because the file is loaded after initial optimization
  plugins.push(createCjsToEsmPlugin());

  // Add router discovery plugin for build-time manifest generation.
  if (discoveryEntryPath) {
    plugins.push(createRouterDiscoveryPlugin(discoveryEntryPath, {
      enableBuildPrerender: prerenderEnabled,
    }));
  }

  return plugins;
}


/**
 * Transform CJS vendor files from @vitejs/plugin-rsc to ESM for browser compatibility.
 * The react-server-dom vendor files are shipped as CJS which doesn't work in browsers.
 */
function createCjsToEsmPlugin(): Plugin {
  return {
    name: "@rangojs/router:cjs-to-esm",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?")[0];

      // Transform the client.browser.js entry point to re-export from CJS
      if (
        cleanId.includes("vendor/react-server-dom/client.browser.js") ||
        cleanId.includes("vendor\\react-server-dom\\client.browser.js")
      ) {
        const isProd = process.env.NODE_ENV === "production";
        const cjsFile = isProd
          ? "./cjs/react-server-dom-webpack-client.browser.production.js"
          : "./cjs/react-server-dom-webpack-client.browser.development.js";

        return {
          code: `export * from "${cjsFile}";`,
          map: null,
        };
      }

      // Transform the actual CJS files to ESM
      if (
        (cleanId.includes("vendor/react-server-dom/cjs/") ||
          cleanId.includes("vendor\\react-server-dom\\cjs\\")) &&
        cleanId.includes("client.browser")
      ) {
        let transformed = code;

        // Extract the license comment to preserve it
        const licenseMatch = transformed.match(/^\/\*\*[\s\S]*?\*\//);
        const license = licenseMatch ? licenseMatch[0] : "";
        if (license) {
          transformed = transformed.slice(license.length);
        }

        // Remove "use strict" (both dev and prod have this)
        transformed = transformed.replace(/^\s*["']use strict["'];\s*/, "");

        // Remove the conditional IIFE wrapper (development only)
        transformed = transformed.replace(
          /^\s*["']production["']\s*!==\s*process\.env\.NODE_ENV\s*&&\s*\(function\s*\(\)\s*\{/,
          ""
        );

        // Remove the closing of the conditional IIFE at the end (development only)
        transformed = transformed.replace(/\}\)\(\);?\s*$/, "");

        // Replace require('react') and require('react-dom') with imports (development)
        transformed = transformed.replace(
          /var\s+React\s*=\s*require\s*\(\s*["']react["']\s*\)\s*,[\s\n]+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import React from "react";\nimport ReactDOM from "react-dom";\nvar '
        );

        // Replace require('react-dom') only (production - doesn't import React)
        transformed = transformed.replace(
          /var\s+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import ReactDOM from "react-dom";\nvar '
        );

        // Transform exports.xyz = function() to export function xyz()
        transformed = transformed.replace(
          /exports\.(\w+)\s*=\s*function\s*\(/g,
          "export function $1("
        );

        // Transform exports.xyz = value to export const xyz = value
        transformed = transformed.replace(
          /exports\.(\w+)\s*=/g,
          "export const $1 ="
        );

        // Reconstruct with license at the top
        transformed = license + "\n" + transformed;

        return {
          code: transformed,
          map: null,
        };
      }

      return null;
    },
  };
}

