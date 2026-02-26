import type { PluginOption } from "vite";
import { readFileSync } from "node:fs";
import { exposeActionId } from "./plugins/expose-action-id.js";
import {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.js";
import { useCacheTransform } from "./plugins/use-cache-transform.js";
import { VIRTUAL_IDS } from "./plugins/virtual-entries.js";
import {
  getExcludeDeps,
  getPackageAliases,
} from "./utils/package-resolution.js";
import {
  createScanFilter,
  findRouterFiles,
} from "../build/generate-route-types.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import {
  sharedEsbuildOptions,
  createVirtualEntriesPlugin,
  onwarn,
  getManualChunks,
} from "./utils/shared-utils.js";
import type {
  RangoOptions,
  RangoNodeOptions,
  RscPluginOptions,
} from "./plugin-types.js";
import { printBanner, rangoVersion } from "./utils/banner.js";
import { createVersionInjectorPlugin } from "./plugins/version-injector.js";
import { createCjsToEsmPlugin } from "./plugins/cjs-to-esm.js";
import { createRouterDiscoveryPlugin } from "./router-discovery.js";

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
export async function rango(options?: RangoOptions): Promise<PluginOption[]> {
  const resolvedOptions: RangoOptions = options ?? { preset: "node" };
  const preset = resolvedOptions.preset ?? "node";
  const showBanner = resolvedOptions.banner ?? true;

  const plugins: PluginOption[] = [];

  // Get package resolution info (workspace vs npm install)
  const rangoAliases = getPackageAliases();
  const excludeDeps = getExcludeDeps();

  // Track RSC entry path for version injection
  let rscEntryPath: string | null = null;

  // Resolved router path (node preset only, may be auto-discovered)
  let routerPath: string | undefined;

  // Build-time prerendering is enabled for both presets.
  // Collection runs in-process via the RSC dev environment runner during discoverRouters().
  const prerenderEnabled = true;

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
          build: {
            rollupOptions: { onwarn },
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
              // All deps must be listed to avoid late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
              optimizeDeps: {
                entries: [finalEntries.ssr],
                include: [
                  "react",
                  "react-dom",
                  "react-dom/server.edge",
                  "react-dom/static.edge",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  "rsc-html-stream/server",
                  "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            rsc: {
              // RSC environment needs exclude list and esbuild options
              // Exclude rsc-router modules to prevent createContext in RSC environment
              optimizeDeps: {
                // Pre-bundle all RSC deps to prevent late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
                include: [
                  "react",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
          },
        };
      },

      configResolved(config) {
        if (showBanner) {
          const mode =
            config.command === "serve"
              ? process.argv.includes("preview")
                ? "preview"
                : "dev"
              : "build";
          printBanner(mode, "cloudflare", rangoVersion);
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
      }) as PluginOption,
    );
  } else {
    // Node preset: full RSC plugin integration
    const nodeOptions = resolvedOptions as RangoNodeOptions;
    routerPath = nodeOptions.router;

    // Auto-discover router when not specified
    if (!routerPath) {
      const earlyFilter = createScanFilter(process.cwd(), {
        include: resolvedOptions.include,
        exclude: resolvedOptions.exclude,
      });
      const candidates = findRouterFiles(process.cwd(), earlyFilter);
      if (candidates.length === 1) {
        // Convert absolute path to relative ./path
        const abs = candidates[0];
        const rel = abs.startsWith(process.cwd())
          ? "./" + abs.slice(process.cwd().length + 1)
          : abs;
        routerPath = rel;
      } else if (candidates.length > 1) {
        const cwd = process.cwd();
        const list = candidates
          .map(
            (f) => "  - " + (f.startsWith(cwd) ? f.slice(cwd.length + 1) : f),
          )
          .join("\n");
        throw new Error(
          `[rsc-router] Multiple routers found. Specify \`router\` to choose one:\n${list}`,
        );
      }
      // 0 found: routerPath stays undefined, warn at startup via discovery plugin
    }

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
            build: {
              rollupOptions: { onwarn },
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
                  // Pre-bundle React and rsc-html-stream to prevent late discovery
                  // triggering ERR_OUTDATED_OPTIMIZED_DEP on cold starts
                  include: [
                    "react",
                    "react-dom",
                    "react/jsx-runtime",
                    "react/jsx-dev-runtime",
                    "rsc-html-stream/client",
                  ],
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
                    // Pre-bundle all SSR deps to prevent late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
                    include: [
                      "react",
                      "react-dom",
                      "react-dom/server.edge",
                      "react-dom/static.edge",
                      "react/jsx-runtime",
                      "react/jsx-dev-runtime",
                      "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
                    ],
                    exclude: excludeDeps,
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
              ...(useVirtualRSC && {
                rsc: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.rsc],
                    // Pre-bundle all RSC deps to prevent late discovery triggering ERR_OUTDATED_OPTIMIZED_DEP
                    include: [
                      "react",
                      "react/jsx-runtime",
                      "react/jsx-dev-runtime",
                      "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                    ],
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
            },
          };
        },

        configResolved(config) {
          if (showBanner) {
            const mode =
              config.command === "serve"
                ? process.argv.includes("preview")
                  ? "preview"
                  : "dev"
                : "build";
            printBanner(mode, "node", rangoVersion);
          }

          // Count how many RSC base plugins there are (rsc:minimal is the main one)
          const rscMinimalCount = config.plugins.filter(
            (p) => p.name === "rsc:minimal",
          ).length;

          if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
            hasWarnedDuplicate = true;
            console.warn(
              "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
                "Remove rsc() from your config or use rango({ rsc: false }) for manual configuration.",
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
        }) as PluginOption,
      );
    }
  }

  // Fix HMR for "use client" components.
  //
  // @vitejs/plugin-rsc's hotUpdate returns undefined for "use client" files
  // in the RSC environment. Vite then tries to propagate through the RSC
  // module graph, but the proxy module has no import.meta.hot.accept()
  // boundary, causing a full page reload. The client env would handle it
  // fine via React Refresh, but the RSC env's full-reload arrives first.
  //
  // Fix: in the RSC env, return [] for "use client" files to signal
  // "handled, nothing to propagate". The client env is left alone so
  // React Refresh processes the update normally.
  plugins.push({
    name: "@rangojs/router:client-component-hmr",
    hotUpdate(ctx) {
      const envName = this.environment?.name;
      if (envName !== "rsc" && envName !== "ssr") return;

      // Check if the changed file is a "use client" module
      const file = ctx.file;
      if (
        !file.endsWith(".tsx") &&
        !file.endsWith(".ts") &&
        !file.endsWith(".jsx") &&
        !file.endsWith(".js")
      )
        return;

      try {
        const source = readFileSync(file, "utf-8");
        const trimmed = source.trimStart();
        if (
          trimmed.startsWith('"use client"') ||
          trimmed.startsWith("'use client'")
        ) {
          // Consume the update in RSC/SSR envs. The proxy module was already
          // re-transformed by the RSC plugin's hotUpdate. Without this, Vite
          // tries to propagate through the RSC/SSR module graph where the proxy
          // has no import.meta.hot.accept() boundary, triggering a full reload.
          // The actual component update is handled by React Refresh in the
          // client environment.
          return [];
        }
      } catch {
        // File deleted/moved during HMR, let default handling proceed
      }
    },
  });

  plugins.push(exposeActionId());

  // "use cache" directive transform (enforce: "post"):
  // Wraps exports with registerCachedFunction() for function-level caching.
  plugins.push(useCacheTransform());

  // Consolidated plugin for create* ID injection (enforce: "post"):
  // loaders, handles, location state, and prerender handlers.
  plugins.push(exposeInternalIds());

  // Router ID injection runs at normal priority (no enforce) to avoid
  // changing Vite's dep optimization timing.
  plugins.push(exposeRouterId());

  // Add version virtual module plugin for cache invalidation
  plugins.push(createVersionPlugin());

  // Entry path for discovery and version injection.
  // Node preset: uses the (possibly auto-discovered) router path.
  // Cloudflare preset: deferred to configResolved (read from resolved Vite env config).
  const discoveryEntryPath = preset !== "cloudflare" ? routerPath : undefined;

  // Version injector: auto-injects VERSION and routes-manifest into custom entry.rsc files.
  // Only applies when there's an explicit rscEntryPath or for cloudflare preset (resolved
  // lazily in configResolved). For node preset without a custom entry, the router file
  // must NOT be transformed — injecting routes-manifest there creates a circular dependency.
  const injectorEntryPath =
    rscEntryPath ?? (preset === "cloudflare" ? undefined : null);
  if (injectorEntryPath !== null) {
    plugins.push(createVersionInjectorPlugin(injectorEntryPath));
  }

  // Transform CJS vendor files to ESM for browser compatibility
  // optimizeDeps.include doesn't work because the file is loaded after initial optimization
  plugins.push(createCjsToEsmPlugin());

  // Router discovery plugin for build-time manifest generation.
  // For cloudflare, the entry is resolved lazily in configResolved from the RSC environment.
  plugins.push(
    createRouterDiscoveryPlugin(discoveryEntryPath, {
      enableBuildPrerender: prerenderEnabled,
      staticRouteTypesGeneration: resolvedOptions.staticRouteTypesGeneration,
      include: resolvedOptions.include,
      exclude: resolvedOptions.exclude,
    }),
  );

  return plugins;
}
