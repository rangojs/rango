import { type PluginOption } from "vite";
import { readFileSync, existsSync } from "node:fs";
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
import {
  findRouterFiles,
  findHostRouterFiles,
} from "../build/generate-route-types.js";
import { createVersionPlugin } from "./plugins/version-plugin.js";
import {
  sharedRolldownOptions,
  createVirtualEntriesPlugin,
  normalizeHostRouterEntry,
  onwarn,
  getManualChunks,
} from "./utils/shared-utils.js";
import {
  resolveClientChunks,
  type ClientChunkContext,
} from "./utils/client-chunks.js";
import type {
  RangoOptions,
  RangoNodeOptions,
  RangoVercelOptions,
} from "./plugin-types.js";
import { createVercelOutputPlugin } from "./plugins/vercel-output.js";
import { printBanner, rangoVersion } from "./utils/banner.js";
import { createVersionInjectorPlugin } from "./plugins/version-injector.js";
import { createCjsToEsmPlugin } from "./plugins/cjs-to-esm.js";
import { createRouterDiscoveryPlugin } from "./router-discovery.js";
import { performanceTracksPlugin } from "./plugins/performance-tracks.js";
import { createRangoDebugger, NS } from "./debug.js";

const debugConfig = createRangoDebugger(NS.config);

/**
 * Syntax target for the node/vercel server (`ssr` + `rsc`) build environments.
 *
 * Vite 8's build-target default is `baseline-widely-available`, which resolves
 * to a BROWSER baseline (`chrome111`/`edge111`/…, ≈ES2022) and is applied
 * per-environment with NO server carve-out: `resolveRolldownOptions` pipes it
 * straight into rolldown/oxc's `transform.target` for `consumer:"server"` chunks
 * too. So without an explicit server target our ssr/rsc bundles — which only run
 * on Node or workerd — get compiled for browsers, needlessly rewriting modern
 * syntax (e.g. Explicit Resource Management `using`/`await using`) into
 * `_usingCtx()` runtime helpers. `esnext` emits server code at authored
 * modernity: no helpers, marginally smaller/faster bundles, semantics that match
 * reality. The `client` env is intentionally left at the browser baseline.
 *
 * The cloudflare preset does NOT use this: `@cloudflare/vite-plugin` hardcodes
 * `es2024` on its server envs and its `config()` merges after ours, so anything
 * we set there is a dead no-op (workerd runs es2024 fine).
 *
 * Caveat: `esnext` stops downleveling ERM `using`, which parses natively only on
 * Node 24+ (workerd runs it). Ordinary ≤ES2022 server code still runs across the
 * whole supported Node range; only an app that authors `using` AND deploys to
 * Node < 24 would need to downlevel it itself. See issue #729.
 */
const SERVER_BUILD_TARGET = "esnext";

// The leading-directive 'use client' sniff is shared with version-plugin's
// getClientModuleSignature so the two cannot drift. Imported for local use by the
// HMR transform below and re-exported because the E8 sniff test imports it from
// this module.
import { hasUseClientDirective } from "./utils/directive-prologue.js";
export { hasUseClientDirective };

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

  // Mutable ref for the served entry path (node/vercel presets only). Populated
  // by the auto-discover config() hook using Vite's resolved root. `kind` selects
  // the RSC entry template: "router" wraps a single createRouter() app in
  // createRSCHandler; "host" wraps a createHostRouter() instance and serves it
  // via hostRouter.match().
  const routerRef: { path: string | undefined; kind: "router" | "host" } = {
    path: undefined,
    kind: "router",
  };
  // Explicit host-router entry (node/vercel `hostRouter` option), root-relative.
  const explicitHostRouter =
    preset !== "cloudflare"
      ? (resolvedOptions as RangoNodeOptions | RangoVercelOptions).hostRouter
      : undefined;

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

    plugins.push(
      createVirtualEntriesPlugin(finalEntries, undefined, {
        headScripts: resolvedOptions.headScripts,
      }),
    );
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
        const toRootRelative = (abs: string) =>
          (abs.startsWith(root)
            ? "./" + abs.slice(root.length + 1)
            : abs
          ).replaceAll("\\", "/");
        const bulletList = (files: string[]) =>
          files.map((f) => "  - " + toRootRelative(f)).join("\n");

        // 1. Explicit host entry wins: serve the createHostRouter() instance.
        if (explicitHostRouter) {
          routerRef.path = normalizeHostRouterEntry(
            explicitHostRouter,
            root,
            existsSync,
          );
          routerRef.kind = "host";
          return;
        }

        // 2. A createHostRouter() file means this is a multi-app host deploy:
        // serve it via the host entry. Checked BEFORE single-router discovery,
        // because a host app may compose just one createRouter() sub-app plus
        // host middleware / domain rules / inline .map() routes -- and a lone
        // sub-app must not shadow the host entry (it would bypass
        // hostRouter.match()).
        const hostCandidates = findHostRouterFiles(root);
        if (hostCandidates.length === 1) {
          const hostPath = toRootRelative(hostCandidates[0]);
          // Auto-detection preempts single-router discovery, so name the winning
          // file: a stale prototype still containing `createHostRouter(` would
          // otherwise silently become the served entry in place of the app.
          // eslint-disable-next-line no-console
          console.info(
            `[rango] Serving host router entry ${hostPath} (auto-detected). ` +
              `Set the \`hostRouter\` option to override.`,
          );
          routerRef.path = hostPath;
          routerRef.kind = "host";
          return;
        }
        if (hostCandidates.length > 1) {
          throw new Error(
            `[rango] Multiple host routers found:\n${bulletList(hostCandidates)}\n\n` +
              `Set the \`hostRouter\` option to the entry to serve, e.g. rango({ preset: "${preset}", hostRouter: "./src/worker.rsc.tsx" }).`,
          );
        }

        // 3. No host entry: single createRouter() app.
        const candidates = findRouterFiles(root);
        if (candidates.length === 1) {
          routerRef.path = toRootRelative(candidates[0]);
          routerRef.kind = "router";
          return;
        }
        if (candidates.length > 1) {
          throw new Error(
            `[rango] Multiple routers found:\n${bulletList(candidates)}\n\n` +
              `If this is a multi-app host router, export a createHostRouter() instance and set the \`hostRouter\` option (e.g. rango({ preset: "${preset}", hostRouter: "./src/worker.rsc.tsx" })), or use preset: "cloudflare" where you own the worker entry.`,
          );
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
        // The vercel preset's deployed function has no node_modules, so the
        // server bundles must be fully self-contained. Bundle every dependency
        // into the rsc + ssr builds instead of externalizing them (the node
        // default, which only works because `vite preview` runs where
        // node_modules exists). node: builtins stay external automatically.
        //
        // BUILD ONLY. In `vite dev` this must NOT apply: noExternal forces every
        // server dependency through the RSC/SSR dev module runners, which cannot
        // load many CJS packages (pg, mysql2, most SDKs, @vercel/functions) and
        // crashes the dev server -- while the same app runs fine under
        // preset: "node" and in the production build. Gating on `build` restores
        // node-preset dev semantics (deps externalized to Node's require).
        const vercelServerEnv =
          preset === "vercel" && configEnv.command === "build"
            ? { resolve: { noExternal: true as const } }
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
              ...(vercelServerEnv ?? {}),
              build: {
                target: SERVER_BUILD_TARGET,
              },
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
              ...(vercelServerEnv ?? {}),
              build: {
                target: SERVER_BUILD_TARGET,
              },
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
                // Vite 8 does not propagate the top-level optimizeDeps.exclude
                // (set in config()) to non-client envs, so the rsc env must set
                // it explicitly — mirroring the node ssr env and the cloudflare
                // rsc env. Without it a strict-pnpm npm-installed app can try to
                // pre-bundle the router's own subpath entries and fail.
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

    plugins.push(
      createVirtualEntriesPlugin(finalEntries, routerRef, {
        headScripts: resolvedOptions.headScripts,
      }),
    );
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
        if (hasUseClientDirective(source)) {
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
      prerenderOnError: options?.prerender?.onError,
      discovery: options?.discovery,
      clientChunkCtx,
      headScripts: resolvedOptions.headScripts,
    }),
  );

  // Vercel preset: assemble .vercel/output from dist/ after the build. Pushed
  // last so its buildApp (order "post") hook runs after the discovery plugin's
  // rsc-env postprocess. buildApp fires once after the whole multi-environment
  // build, so dist/ is complete (closeBundle is unusable here -- it fires per
  // environment, twice for ssr; see the plugin's own note).
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
