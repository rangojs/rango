import type { Plugin, PluginOption } from "vite";
import { createServer as createViteServer } from "vite";
import * as Vite from "vite";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { exposeActionId } from "./expose-action-id.ts";
import { exposeLoaderId } from "./expose-loader-id.ts";
import { exposeHandleId } from "./expose-handle-id.ts";
import { exposeLocationStateId } from "./expose-location-state-id.ts";
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

// Re-export plugins
export { exposeActionId } from "./expose-action-id.ts";
export { exposeLoaderId } from "./expose-loader-id.ts";
export { exposeHandleId } from "./expose-handle-id.ts";
export { exposeLocationStateId } from "./expose-location-state-id.ts";

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
interface RscRouterBaseOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;
}

/**
 * Options for Node.js deployment (default)
 */
export interface RscRouterNodeOptions extends RscRouterBaseOptions {
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
   * rscRouter({ router: './src/router.tsx' })
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
export interface RscRouterCloudflareOptions extends RscRouterBaseOptions {
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
 * Options for rscRouter plugin
 */
export type RscRouterOptions = RscRouterNodeOptions | RscRouterCloudflareOptions;

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
function createRouterDiscoveryPlugin(entryPath: string): Plugin {
  let projectRoot = "";
  let isBuildMode = false;
  let userResolveAlias: any = undefined;

  // Merged route manifest from all discovered routers.
  // Populated during discovery (dev: configureServer, build: buildStart).
  // Read by the virtual module's load hook to emit setCachedManifest() call.
  let mergedRouteManifest: Record<string, string> | null = null;

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

        mergedRouteTrie = buildRouteTrie(
          mergedRouteManifest,
          mergedRouteAncestry,
          routeToStaticPrefix,
          Object.keys(mergedRouteTrailingSlash).length > 0 ? mergedRouteTrailingSlash : undefined,
        );
        // Trie built successfully
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
      return null;
    },
  };
}

const VIRTUAL_ROUTES_MANIFEST_ID = "virtual:rsc-router/routes-manifest";

/**
 * Resolve the entry path for build-time router discovery.
 * - Node preset: uses the required `router` option.
 * - Cloudflare preset: reads the `main` field from wrangler.json.
 */
function resolveDiscoveryEntryPath(options: RscRouterOptions): string | undefined {
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
  return (options as RscRouterNodeOptions).router;
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

/**
 * Vite plugin for rsc-router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rscRouter({ router: './src/router.tsx' })],
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rscRouter({ preset: 'cloudflare' }),
 *     cloudflare({ viteEnvironment: { name: 'rsc' } }),
 *   ],
 * });
 * ```
 */
export async function rscRouter(
  options: RscRouterOptions
): Promise<PluginOption[]> {
  const preset = options.preset ?? "node";
  const enableExposeActionId = options.exposeActionId ?? true;

  const plugins: PluginOption[] = [];

  // Get package resolution info (workspace vs npm install)
  const rscRouterAliases = getPackageAliases();
  const excludeDeps = getExcludeDeps();

  // Track RSC entry path for version injection
  let rscEntryPath: string | null = null;

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
            alias: rscRouterAliases,
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
    const nodeOptions = options as RscRouterNodeOptions;
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
              alias: rscRouterAliases,
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
          // Count how many RSC base plugins there are (rsc:minimal is the main one)
          const rscMinimalCount = config.plugins.filter(
            (p) => p.name === "rsc:minimal"
          ).length;

          if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
            hasWarnedDuplicate = true;
            console.warn(
              "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
                "Remove rsc() from your config or use rscRouter({ rsc: false }) for manual configuration."
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
    plugins.push(createRouterDiscoveryPlugin(discoveryEntryPath));
  }

  return plugins;
}

/** Alias for backwards compatibility */
export const rango = rscRouter;

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

