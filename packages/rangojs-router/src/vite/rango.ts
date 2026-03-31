import type { PluginOption } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exposeActionId } from "./plugins/expose-action-id.js";
import {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.js";
import { useCacheTransform } from "./plugins/use-cache-transform.js";
import { clientRefDedup } from "./plugins/client-ref-dedup.js";
import { VIRTUAL_IDS } from "./plugins/virtual-entries.js";
import {
  getExcludeDeps,
  getPackageAliases,
} from "./utils/package-resolution.js";
import { findRouterFiles } from "../build/generate-route-types.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import {
  sharedEsbuildOptions,
  createVirtualEntriesPlugin,
  onwarn,
  getManualChunks,
} from "./utils/shared-utils.js";
import type { RangoOptions } from "./plugin-types.js";
import { printBanner, rangoVersion } from "./utils/banner.js";
import { createVersionInjectorPlugin } from "./plugins/version-injector.js";
import { createCjsToEsmPlugin } from "./plugins/cjs-to-esm.js";
import { createRouterDiscoveryPlugin } from "./router-discovery.js";
import { performanceTracksPlugin } from "./plugins/performance-tracks.js";

/**
 * Vite plugin for @rangojs/router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rango()],
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
  const excludeDeps = [
    ...getExcludeDeps(),
    // The public browser entry re-exports the RSDW browser client.
    // Excluding both keeps Vite from freezing the unpatched bundle into
    // .vite/deps before our source transforms run.
    "@vitejs/plugin-rsc/browser",
    // Keep the browser RSDW client out of Vite's dep optimizer so our
    // cjs-to-esm transform can patch the real file.
    "@vitejs/plugin-rsc/vendor/react-server-dom/client.browser",
  ];

  // Mutable ref for router path (node preset only).
  // Set immediately when user-specified, or populated by the auto-discover
  // config() hook using Vite's resolved root.
  const routerRef: { path: string | undefined } = { path: undefined };

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

    // Dev-only: RSDW client patch for React Performance Tracks
    plugins.push(performanceTracksPlugin());

    // Add RSC plugin with cloudflare-specific options
    // Note: loadModuleDevProxy should NOT be used with childEnvironments
    // since SSR runs in workerd alongside RSC
    plugins.push(
      rsc({
        entries: finalEntries,
        serverHandler: false,
      }) as PluginOption,
    );

    // Deduplicate client references from third-party packages in dev mode.
    // Prevents module duplication when server components import "use client"
    // packages that are also imported directly by client components.
    plugins.push(clientRefDedup());
  } else {
    // Auto-discover router using Vite's resolved root (not process.cwd())
    plugins.push({
      name: "@rangojs/router:auto-discover",
      config(userConfig) {
        if (routerRef.path) return;
        const root = userConfig.root
          ? resolve(process.cwd(), userConfig.root)
          : process.cwd();
        const candidates = findRouterFiles(root);
        if (candidates.length === 1) {
          const abs = candidates[0];
          routerRef.path = (
            abs.startsWith(root) ? "./" + abs.slice(root.length + 1) : abs
          ).replaceAll("\\", "/");
        } else if (candidates.length > 1) {
          const list = candidates
            .map(
              (f) =>
                "  - " + (f.startsWith(root) ? f.slice(root.length + 1) : f),
            )
            .join("\n");
          throw new Error(`[rsc-router] Multiple routers found:\n${list}`);
        }
        // 0 found: routerRef.path stays undefined, warn at startup via discovery plugin
      },
    });

    // Always use virtual entries for client, ssr, and rsc
    const finalEntries = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
      rsc: VIRTUAL_IDS.rsc,
    };

    // Dynamically import @vitejs/plugin-rsc
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    let hasWarnedDuplicate = false;

    plugins.push({
      name: "@rangojs/router:rsc-integration",
      enforce: "pre",

      config() {
        return {
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
              optimizeDeps: {
                include: [
                  "react",
                  "react-dom",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  "rsc-html-stream/client",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
                entries: [VIRTUAL_IDS.browser],
              },
            },
            ssr: {
              optimizeDeps: {
                entries: [VIRTUAL_IDS.ssr],
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
            rsc: {
              optimizeDeps: {
                entries: [VIRTUAL_IDS.rsc],
                include: [
                  "react",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                ],
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
          printBanner(mode, "node", rangoVersion);
        }

        const rscMinimalCount = config.plugins.filter(
          (p) => p.name === "rsc:minimal",
        ).length;

        if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
          hasWarnedDuplicate = true;
          console.warn(
            "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
              "Remove rsc() from your vite config — rango() includes it automatically.",
          );
        }
      },
    });

    // Add virtual entries plugin (RSC entry generated lazily from routerRef)
    plugins.push(createVirtualEntriesPlugin(finalEntries, routerRef));

    // Dev-only: RSDW client patch for React Performance Tracks
    plugins.push(performanceTracksPlugin());

    plugins.push(
      rsc({
        entries: finalEntries,
      }) as PluginOption,
    );

    // Deduplicate client references from third-party packages in dev mode.
    // Prevents module duplication when server components import "use client"
    // packages that are also imported directly by client components.
    plugins.push(clientRefDedup());
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

  // Entry path for discovery: user-specified value (if any) or undefined.
  // Auto-discovered path is passed separately via routerRef.
  // Cloudflare preset: deferred to configResolved (read from resolved Vite env config).
  const discoveryEntryPath =
    preset !== "cloudflare" ? routerRef.path : undefined;
  // Ref for deferred auto-discovery (node preset only, undefined for cloudflare)
  const discoveryRouterRef = preset !== "cloudflare" ? routerRef : undefined;

  // Version injector: auto-injects VERSION and routes-manifest into the RSC entry.
  // For cloudflare preset, the entry is resolved lazily in configResolved.
  // For node preset, the virtual entry already includes these imports.
  if (preset === "cloudflare") {
    plugins.push(createVersionInjectorPlugin(undefined));
  }

  // Transform CJS vendor files to ESM for browser compatibility
  // optimizeDeps.include doesn't work because the file is loaded after initial optimization
  plugins.push(createCjsToEsmPlugin());

  // Router discovery plugin for build-time manifest generation.
  // For cloudflare, the entry is resolved lazily in configResolved from the RSC environment.
  // For node, discoveryRouterRef provides the auto-discovered path when not user-specified.
  plugins.push(
    createRouterDiscoveryPlugin(discoveryEntryPath, {
      routerPathRef: discoveryRouterRef,
      enableBuildPrerender: prerenderEnabled,
    }),
  );

  return plugins;
}
