import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rango } from "@rangojs/router/vite";
import { analyze } from "../../tools/bundle-analyze";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function testHeadScripts(): "preload" | undefined {
  const value = process.env.RANGO_E2E_HEAD_SCRIPTS;
  if (!value) return;
  if (value === "preload") return value;
  throw new Error(`Invalid RANGO_E2E_HEAD_SCRIPTS value: ${value}`);
}

const headScripts = testHeadScripts();

// A third-party-style resolver: maps "@parity/*" to ./src/parity/* via a
// resolveId hook, deliberately WITHOUT a matching resolve.alias entry. Mirrors
// how vite-tsconfig-paths resolves tsconfig `paths` (issue #500) and asserts
// that cloudflare discovery's temp runner forwards user resolveId plugins so
// build-time static/prerender rendering can resolve such specifiers.
function parityAliasPlugin(): Plugin {
  const prefix = "@parity/";
  const baseDir = path.resolve(__dirname, "./src/parity");
  return {
    name: "test-parity-alias",
    enforce: "pre",
    async resolveId(id, importer, options) {
      if (!id.startsWith(prefix)) return null;
      const target = path.resolve(baseDir, id.slice(prefix.length));
      const resolved = await this.resolve(target, importer, {
        skipSelf: true,
        ...options,
      });
      return resolved ?? undefined;
    },
  };
}

const RSC_RELOAD_EVENT = "rango-e2e:rsc-reload";
const RSC_RELOAD_HOLD_MS = 2_000;

/** Where the first request asks for the reload: the probe module it loads. */
const RSC_RELOAD_PROBES: Record<string, string> = {
  // While it loads the entry, before router.fetch (urls.tsx).
  entry: "src/rsc-reload-probe.ts",
  // During route discovery inside router.fetch (an async include, urls.tsx).
  discovery: "src/rsc-reload-probe-discovery.ts",
};

/**
 * e2e/dev-rsc-reload.test.ts (#1186), behind RANGO_E2E_RSC_RELOAD_PROBE set to
 * a RSC_RELOAD_PROBES key. Serves that probe so the first request after
 * listening asks for the dep optimizer's reload (invalidateAll + full-reload)
 * and resumes after the clear; the re-import's copy holds RSC_RELOAD_HOLD_MS,
 * a slow re-created router.
 */
function rscReloadProbe(): Plugin | false {
  const file = RSC_RELOAD_PROBES[process.env.RANGO_E2E_RSC_RELOAD_PROBE ?? ""];
  if (!file) return false;
  const probe = path.resolve(__dirname, file);
  const reloadCode = [
    "if (import.meta.hot) {",
    "  await new Promise((resolve) => {",
    // The runner clears its modules right after these listeners return.
    '    import.meta.hot.on("vite:beforeFullReload", () => setTimeout(resolve, 0));',
    `    import.meta.hot.send(${JSON.stringify(RSC_RELOAD_EVENT)});`,
    "  });",
    "}",
    "export {};",
    "",
  ].join("\n");
  const holdCode = `await new Promise((resolve) => setTimeout(resolve, ${RSC_RELOAD_HOLD_MS}));\nexport {};\n`;
  let armed = false;
  let fired = false;
  return {
    name: "test-rsc-reload-probe",
    apply: "serve",
    configureServer(server) {
      const rsc = server.environments.rsc;
      // Before listening the hot channel drops the event, and the startup
      // isolate is replaced before the first request.
      server.httpServer?.once("listening", () => {
        armed = true;
        const mod = rsc.moduleGraph.getModuleById(probe);
        if (mod) rsc.moduleGraph.invalidateModule(mod);
      });
      rsc.hot.on(RSC_RELOAD_EVENT, () => {
        if (fired) return;
        fired = true;
        server.config.logger.info(
          "[rango-e2e] rsc-reload-probe: full reload sent",
        );
        rsc.moduleGraph.invalidateAll();
        rsc.hot.send({ type: "full-reload", path: "*" });
      });
    },
    transform(_code, id) {
      if (this.environment.name !== "rsc") return;
      if (path.resolve(id.split("?", 1)[0]!) !== probe) return;
      const code = fired ? holdCode : armed ? reloadCode : "export {};\n";
      return { code, map: null };
    },
  };
}

export default defineConfig(({ isPreview }) => ({
  cacheDir: process.env.RANGO_E2E_VITE_CACHE_DIR ?? "node_modules/.vite",
  // Inline the render-timeout e2e flag at build/transform time. The worker runs
  // in workerd, whose `process.env` is populated from wrangler vars/bindings —
  // NOT the host process — so a runtime `process.env.RANGO_E2E_RENDER_TIMEOUT`
  // read inside src/router.tsx would always be undefined. This define replaces
  // it with the Node-side value when vite dev/build runs (the e2e webServer sets
  // it, playwright.config.ts), keeping the render-timeout config out of every
  // non-e2e build. Empty string on a normal build → the config is gated off.
  define: {
    "process.env.RANGO_E2E_RENDER_TIMEOUT": JSON.stringify(
      process.env.RANGO_E2E_RENDER_TIMEOUT ?? "",
    ),
    // Edge-only cache e2e (playwright.edge-only.config.ts): drops the KV
    // binding from the app-level CFCacheStore so ppr shells run L1-only
    // (Cache API). Same inlining rationale as the flag above. Empty string
    // on a normal build → the store keeps its KV L2.
    "process.env.RANGO_E2E_EDGE_ONLY_CACHE": JSON.stringify(
      process.env.RANGO_E2E_EDGE_ONLY_CACHE ?? "",
    ),
  },
  server: {
    port: 5001,
    // Bind to all interfaces for CI compatibility (fixes IPv6/IPv4 issues in Docker/Linux)
    host: process.env.CI ? "0.0.0.0" : undefined,
    hmr: {
      // As in the router e2e app: routes that throw on purpose (the
      // handles-after-await LateHandlePushError cases) broadcast Vite's dev
      // overlay to every connected page, where it blocks the clicks of
      // tests running in parallel against the shared dev server.
      overlay: process.env.RANGO_E2E_HMR_OVERLAY === "1",
    },
  },
  resolve: {
    // Vite 8 native tsconfig paths resolution. The "@native/*" mapping in
    // tsconfig.json is resolved by this flag alone (no resolve.alias, no
    // resolveId plugin), exercising that the cloudflare discovery runner
    // forwards the native tsconfigPaths flag into its temp server.
    tsconfigPaths: true,
  },
  plugins: [
    parityAliasPlugin(),
    rscReloadProbe(),
    // React Compiler via plugin-react's native option; compiles client components only.
    react({ compiler: true }),
    rango({
      preset: "cloudflare",
      buildEnv: "auto",
      ...(headScripts ? { headScripts } : {}),
    }),
    cloudflare({
      configPath: "./wrangler.json",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      inspectorPort: false,
      // The e2e dev and preview servers run side by side locally. Sharing one
      // KV state let a dev test's updateTag() marker evict the production
      // build-time shell of the same tag (ppr-shell.test.ts, the evict test).
      persistState: {
        path: isPreview ? ".wrangler/state-preview" : ".wrangler/state",
      },
    }),
    ...analyze(),
  ],
}));
