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
  getPublishedPackageName,
  getVendorAliases,
} from "./utils/package-resolution.js";
import { findRouterFiles } from "../build/generate-route-types.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import {
  sharedRolldownOptions,
  createVirtualEntriesPlugin,
  onwarn,
  getManualChunks,
} from "./utils/shared-utils.js";
import {
  resolveClientChunks,
  type ClientChunkContext,
} from "./utils/client-chunks.js";
import type { RangoOptions, RangoVercelOptions } from "./plugin-types.js";
import { createVercelOutputPlugin } from "./plugins/vercel-output.js";
import { printBanner, rangoVersion } from "./utils/banner.js";
import { createVersionInjectorPlugin } from "./plugins/version-injector.js";
import { createCjsToEsmPlugin } from "./plugins/cjs-to-esm.js";
import { createRouterDiscoveryPlugin } from "./router-discovery.js";
import { performanceTracksPlugin } from "./plugins/performance-tracks.js";
import { createRangoDebugger, NS } from "./debug.js";

const debugConfig = createRangoDebugger(NS.config);

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
  const rangoStart = performance.now();
  const resolvedOptions: RangoOptions = options ?? { preset: "node" };
  const preset = resolvedOptions.preset ?? "node";
  const showBanner = resolvedOptions.banner ?? true;
  const clientChunksOption = resolvedOptions.clientChunks ?? true;
  const useBuiltInClientChunks = clientChunksOption === true;
  const clientChunkCtx: ClientChunkContext | undefined = useBuiltInClientChunks
    ? { fallbackRefs: new Set<string>() }
    : undefined;
  const clientChunks = resolveClientChunks(clientChunksOption, clientChunkCtx);
  debugConfig?.("rango(%s) setup start", preset);

  const plugins: PluginOption[] = [];

  // Get package resolution info (workspace vs npm install).
  // Vendor aliases redirect the bare plugin-rsc vendor specs (which plugin-rsc
  // itself injects into optimizeDeps.include) to absolute paths resolved from
  // this package — so strict-pnpm consumers don't hit "Failed to resolve
  // dependency" warnings when those deps aren't hoisted to their app root.
  const rangoAliases = { ...getPackageAliases(), ...getVendorAliases() };
  const excludeDeps = [
    ...getExcludeDeps(),
    // plugin-rsc itself injects these into the client env's
    // optimizeDeps.include, which overrides exclude for the dep's own
    // pre-bundle entry. What exclude still controls is how *other*
    // pre-bundled deps treat imports of these specs (external vs inlined)
    // via esbuildCjsExternalPlugin. The cjs-to-esm transform in
    // plugins/cjs-to-esm.ts is the fallback for strict-pnpm consumers,
    // where client.browser's bare include fails to resolve and Vite ends up
    // serving the raw CJS file at dev-serve time.
    "@vitejs/plugin-rsc/browser",
    "@vitejs/plugin-rsc/vendor/react-server-dom/client.browser",
  ];

  // Vite supports a nested `A > B` syntax in optimizeDeps.include that resolves
  // B from A's location. We anchor transitive deps (rsc-html-stream,
  // @vitejs/plugin-rsc/vendor/*) to @rangojs/router so pnpm consumers — where
  // these aren't visible at the app root — can still pre-bundle them.
  const pkg = getPublishedPackageName();
  const nested = (spec: string) => `${pkg} > ${spec}`;

  // Mutable ref for router path (node preset only).
  // Set immediately when user-specified, or populated by the auto-discover
  // config() hook using Vite's resolved root.
  const routerRef: { path: string | undefined } = { path: undefined };

  // Build-time prerendering is enabled for both presets.
  // Collection runs in-process via the RSC dev environment runner during discoverRouters().
  const prerenderEnabled = true;

  if (preset === "cloudflare") {
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    const finalEntries: { client: string; ssr: string } = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
    };

    plugins.push({
      name: "@rangojs/router:cloudflare-integration",
      enforce: "pre",

      config() {
        return {
          optimizeDeps: {
            exclude: excludeDeps,
            rolldownOptions: sharedRolldownOptions,
          },
          resolve: {
            alias: rangoAliases,
            // Force a single React/React-DOM copy across all three RSC
            // environments. RSC requires exactly one react/react-dom instance
            // per environment runtime; consumer install topologies (pnpm
            // strict layout, experimental React pins, third-party "use client"
            // packages) can otherwise resolve duplicate copies, causing
            // "Invalid hook call" / lost context. Child environments inherit
            // this root dedupe, and Vite merges it with any consumer dedupe.
            dedupe: ["react", "react-dom"],
          },
          build: {
            rollupOptions: { onwarn },
          },
          environments: {
            client: {
              build: {
                rollupOptions: {
                  onwarn,
                  output: {
                    manualChunks: getManualChunks,
                  },
                },
              },
              optimizeDeps: {
                include: [nested("rsc-html-stream/client")],
                exclude: excludeDeps,
                rolldownOptions: sharedRolldownOptions,
              },
            },
            ssr: {
              build: {
                outDir: "./dist/rsc/ssr",
              },
              optimizeDeps: {
                entries: [finalEntries.ssr],
                include: [
                  "react",
                  "react-dom",
                  "react-dom/server.edge",
                  "react-dom/static.edge",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  nested("rsc-html-stream/server"),
                  nested(
                    "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
                  ),
                ],
                exclude: excludeDeps,
                rolldownOptions: sharedRolldownOptions,
              },
            },
            rsc: {
              optimizeDeps: {
                include: [
                  "react",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  nested(
                    "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                  ),
                ],
                exclude: excludeDeps,
                rolldownOptions: sharedRolldownOptions,
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
    plugins.push(performanceTracksPlugin());
    plugins.push(
      rsc({
        entries: finalEntries,
        serverHandler: false,
        clientChunks,
      }) as PluginOption,
    );
    plugins.push(clientRefDedup());
  } else {
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
          throw new Error(`[rango] Multiple routers found:\n${list}`);
        }
      },
    });

    const finalEntries = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
      rsc: VIRTUAL_IDS.rsc,
    };

    const { default: rsc } = await import("@vitejs/plugin-rsc");

    let hasWarnedDuplicate = false;

    plugins.push({
      name: "@rangojs/router:rsc-integration",
      enforce: "pre",

      config(_userConfig, configEnv) {
        // Fold NODE_ENV for the vercel preset's build. The cloudflare plugin
        // does this automatically and node apps do it themselves; vercel has no
        // platform plugin, so without this React's CJS dev branch survives and
        // doubles the SSR/RSC bundle (Bundle Hygiene rule #2). Only the exact
        // `process.env.NODE_ENV` token is replaced.
        const vercelDefine =
          preset === "vercel" && configEnv.command === "build"
            ? { "process.env.NODE_ENV": JSON.stringify("production") }
            : undefined;
        return {
          ...(vercelDefine ? { define: vercelDefine } : {}),
          optimizeDeps: {
            exclude: excludeDeps,
            rolldownOptions: sharedRolldownOptions,
          },
          build: {
            rollupOptions: { onwarn },
          },
          resolve: {
            alias: rangoAliases,
            // Force a single React/React-DOM copy across all three RSC
            // environments. RSC requires exactly one react/react-dom instance
            // per environment runtime; consumer install topologies (pnpm
            // strict layout, experimental React pins, third-party "use client"
            // packages) can otherwise resolve duplicate copies, causing
            // "Invalid hook call" / lost context. Child environments inherit
            // this root dedupe, and Vite merges it with any consumer dedupe.
            dedupe: ["react", "react-dom"],
          },
          environments: {
            client: {
              build: {
                rollupOptions: {
                  onwarn,
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
                  nested("rsc-html-stream/client"),
                ],
                exclude: excludeDeps,
                rolldownOptions: sharedRolldownOptions,
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
                  nested(
                    "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
                  ),
                ],
                exclude: excludeDeps,
                rolldownOptions: sharedRolldownOptions,
              },
            },
            rsc: {
              optimizeDeps: {
                entries: [VIRTUAL_IDS.rsc],
                include: [
                  "react",
                  "react/jsx-runtime",
                  "react/jsx-dev-runtime",
                  nested(
                    "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
                  ),
                ],
                rolldownOptions: sharedRolldownOptions,
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
          printBanner(
            mode,
            preset === "vercel" ? "vercel" : "node",
            rangoVersion,
          );
        }

        const rscMinimalCount = config.plugins.filter(
          (p) => p.name === "rsc:minimal",
        ).length;

        if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
          hasWarnedDuplicate = true;
          console.warn(
            "[rango] Duplicate @vitejs/plugin-rsc detected. " +
              "Remove rsc() from your vite config — rango() includes it automatically.",
          );
        }
      },
    });

    plugins.push(createVirtualEntriesPlugin(finalEntries, routerRef));
    plugins.push(performanceTracksPlugin());
    plugins.push(
      rsc({
        entries: finalEntries,
        clientChunks,
      }) as PluginOption,
    );
    plugins.push(clientRefDedup());
  }

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
          return [];
        }
      } catch {}
    },
  });

  plugins.push(exposeActionId());
  plugins.push(useCacheTransform());
  plugins.push(exposeInternalIds());
  plugins.push(exposeRouterId());
  plugins.push(createVersionPlugin());

  const discoveryEntryPath =
    preset !== "cloudflare" ? routerRef.path : undefined;
  const discoveryRouterRef = preset !== "cloudflare" ? routerRef : undefined;

  if (preset === "cloudflare") {
    plugins.push(createVersionInjectorPlugin(undefined));
  }

  plugins.push(createCjsToEsmPlugin());
  plugins.push(
    createRouterDiscoveryPlugin(discoveryEntryPath, {
      routerPathRef: discoveryRouterRef,
      enableBuildPrerender: prerenderEnabled,
      buildEnv: options?.buildEnv,
      preset,
      discovery: options?.discovery,
      clientChunkCtx,
    }),
  );

  // Vercel preset: assemble .vercel/output from dist/ after the build. Pushed
  // last so its (ssr-gated) closeBundle runs after the discovery plugin's
  // rsc-env postprocess and after every environment has been written.
  if (preset === "vercel") {
    plugins.push(
      createVercelOutputPlugin(resolvedOptions as RangoVercelOptions),
    );
  }

  debugConfig?.(
    "rango(%s) setup done: %d plugin(s) (%sms)",
    preset,
    plugins.length,
    (performance.now() - rangoStart).toFixed(1),
  );
  return plugins;
}
