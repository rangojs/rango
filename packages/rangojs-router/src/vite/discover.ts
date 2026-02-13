import type { Plugin } from "vite";
import {
  VIRTUAL_IDS,
  getVirtualVersionContent,
} from "./virtual-entries.ts";
import { exposeInternalIds, exposeRouterId } from "./expose-internal-ids.ts";

/**
 * Vite plugin that provides the @rangojs/router:version virtual module.
 * Tracks RSC module changes in dev mode and bumps the version timestamp
 * so clients can detect stale cached payloads.
 *
 * Client-only HMR changes don't update the version since they don't affect
 * server-rendered content or cached RSC payloads.
 * @internal
 */
export function createVersionPlugin(): Plugin {
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
 * Stub plugin for virtual modules in the temp discovery server.
 * The RSC entry may import virtual modules (routes-manifest, loader-manifest)
 * that aren't available in the temp server. The RSC plugin also requires
 * client/ssr entries which don't need real content for discovery.
 */
export function createVirtualStubPlugin(): Plugin {
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

export interface DiscoveredRouter {
  id: string;
  routeManifest: Record<string, string>;
  sourceFile?: string;
}

/**
 * Discover routes by executing the router code via a temporary Vite server
 * with an RSC module runner. This produces the same results as a full build,
 * including dynamically generated routes (loops, Array.from(), etc.) that
 * static parsing cannot detect.
 *
 * The function creates a temporary Vite dev server, imports the entry file
 * through the RSC environment runner, reads the RouterRegistry, generates
 * manifests, and tears down the server.
 */
export async function discoverRoutesViaRunner(opts: {
  entryPath: string;
  projectRoot: string;
  resolveAlias?: any;
}): Promise<DiscoveredRouter[]> {
  const { entryPath, projectRoot, resolveAlias } = opts;

  // Dynamic imports so Vite is not required at CLI install time
  const { createServer: createViteServer } = await import("vite");
  const { default: rsc } = await import("@vitejs/plugin-rsc");

  let tempServer: any = null;
  try {
    // Prevent nested plugin instances from running their own discovery
    (globalThis as any).__rscRouterDiscoveryActive = true;

    tempServer = await createViteServer({
      root: projectRoot,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
      resolve: resolveAlias ? { alias: resolveAlias } : undefined,
      esbuild: { jsx: "automatic", jsxImportSource: "react" },
      plugins: [
        rsc({ entries: { client: "virtual:entry-client", ssr: "virtual:entry-ssr", rsc: entryPath } }),
        createVersionPlugin(),
        createVirtualStubPlugin(),
        exposeInternalIds({ forceBuild: true }),
        exposeRouterId(),
      ],
    });

    const rscEnv = (tempServer.environments as any)?.rsc;
    if (!rscEnv?.runner) {
      throw new Error(
        "[rsc-router] RSC environment runner not available in temp server"
      );
    }

    // Import entry to populate RouterRegistry
    await rscEnv.runner.import(entryPath);

    // Read RouterRegistry
    const serverMod = await rscEnv.runner.import("@rangojs/router/server");
    let registry: Map<string, any> = serverMod.RouterRegistry;

    if (!registry || registry.size === 0) {
      // Check for host routers with lazy handlers
      try {
        const hostMod = await rscEnv.runner.import("@rangojs/router/host");
        const hostRegistry: Map<string, any> | undefined = hostMod.HostRouterRegistry;

        if (hostRegistry && hostRegistry.size > 0) {
          for (const [, entry] of hostRegistry) {
            for (const route of entry.routes) {
              if (typeof route.handler === "function") {
                try {
                  await route.handler();
                } catch {
                  // Lazy handler may fail in temp server context
                }
              }
            }
            if (entry.fallback && typeof entry.fallback.handler === "function") {
              try {
                await entry.fallback.handler();
              } catch {
                // Fallback handler may fail in temp server context
              }
            }
          }

          // Re-read registry after lazy handlers may have called createRouter()
          const freshServerMod = await rscEnv.runner.import("@rangojs/router/server");
          const freshRegistry: Map<string, any> = freshServerMod.RouterRegistry;

          if (freshRegistry && freshRegistry.size > 0) {
            registry = freshRegistry;
          }
        }
      } catch {
        // @rangojs/router/host not available, skip
      }

      if (!registry || registry.size === 0) {
        throw new Error(
          `[rsc-router] No routers found in registry after importing ${entryPath}`
        );
      }
    }

    // Generate manifests
    const buildMod = await rscEnv.runner.import("@rangojs/router/build");
    const generateManifest = buildMod.generateManifest;

    const results: DiscoveredRouter[] = [];
    let routerMountIndex = 0;

    for (const [id, router] of registry) {
      if (!router.urlpatterns || !generateManifest) {
        continue;
      }

      const manifest = generateManifest(router.urlpatterns, routerMountIndex);
      routerMountIndex++;

      results.push({
        id,
        routeManifest: manifest.routeManifest,
        sourceFile: router.__sourceFile,
      });
    }

    return results;
  } finally {
    delete (globalThis as any).__rscRouterDiscoveryActive;
    if (tempServer) {
      await tempServer.close();
    }
  }
}
