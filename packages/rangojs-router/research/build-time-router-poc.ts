/**
 * Proof of concept: Import the user's router instance at build time
 * using Vite's RSC environment module runner.
 *
 * Key insight: ssrLoadModule uses the SSR environment which doesn't have
 * react-server conditions. The RSC environment (from @vitejs/plugin-rsc)
 * does. We need to use server.environments.rsc to load modules correctly.
 *
 * Run: packages/rangojs-router/node_modules/.bin/tsx packages/rangojs-router/research/build-time-router-poc.ts
 */

import { createServer, type ViteDevServer } from "vite";
import path from "node:path";

const DEMO_APP_ROOT = path.resolve(
  import.meta.dirname,
  "../../../examples/vite-rsc-demo"
);
const ROUTER_MODULE = "./src/router.tsx";

async function main() {
  let server: ViteDevServer | undefined;

  try {
    // Use the demo app's full vite config so we get the RSC environment
    // set up by @vitejs/plugin-rsc (which rscRouter() includes)
    server = await createServer({
      root: DEMO_APP_ROOT,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "warn",
    });

    console.log("[POC] Vite server created");
    console.log(
      "[POC] Available environments:",
      Object.keys(server.environments)
    );

    const rscEnv = server.environments["rsc"] as any;

    if (!rscEnv) {
      console.log("[POC] No RSC environment found. Falling back to ssrLoadModule.");
      console.log("[POC] This is expected without @vitejs/plugin-rsc");
      return;
    }

    console.log("[POC] RSC environment found, loading router module...\n");

    // Use the RSC environment's module runner to load the router.
    // This has react-server conditions and proper RSC module resolution.
    const mod = await rscEnv.runner.import(ROUTER_MODULE);

    const router = mod.router;
    const href = mod.href;

    if (!router) {
      console.error("[POC] No router export found");
      console.log("[POC] Available exports:", Object.keys(mod));
      return;
    }

    console.log("[POC] SUCCESS - Router instance loaded at build time!\n");

    // --- Extract data from the live router instance ---

    // 1. Route map (eagerly-registered routes only)
    console.log("=== Route Map (eager only) ===");
    const routeMap = router.routeMap;
    if (routeMap && Object.keys(routeMap).length > 0) {
      for (const [name, pattern] of Object.entries(routeMap)) {
        console.log(`  ${name}: ${pattern}`);
      }
    } else {
      console.log("  (empty or not populated yet)");
    }

    // 2. href() at build time
    console.log("\n=== href() at build time ===");
    if (href) {
      try {
        const homeUrl = href("home.index");
        console.log(`  href("home.index") = ${homeUrl}`);
      } catch (e: any) {
        console.log(`  href() threw: ${e.message}`);
      }
    }

    // 3. Full manifest via generateManifest (evaluates lazy includes)
    console.log("\n=== Full Manifest (via generateManifest) ===");
    if (router.urlpatterns) {
      const buildMod = await rscEnv.runner.import("@rangojs/router/build");
      if (buildMod.generateManifest) {
        const manifest = buildMod.generateManifest(router.urlpatterns);
        console.log(
          `  Total routes: ${Object.keys(manifest.routeManifest).length}`
        );

        console.log("\n  All routes:");
        for (const [name, pattern] of Object.entries(manifest.routeManifest)) {
          console.log(`    ${name}: ${pattern}`);
        }

        console.log("\n  Pre-render candidates (static, no params):");
        for (const [name, pattern] of Object.entries(manifest.routeManifest)) {
          const p = pattern as string;
          if (!p.includes(":") && !p.includes("*")) {
            console.log(`    ${name}: ${p}`);
          }
        }

        console.log("\n  Dynamic routes (need param providers):");
        for (const [name, pattern] of Object.entries(manifest.routeManifest)) {
          const p = pattern as string;
          if (p.includes(":") || p.includes("*")) {
            console.log(`    ${name}: ${p}`);
          }
        }

        console.log("\n  Prefix tree:");
        console.log(JSON.stringify(manifest.prefixTree, null, 2));
      }
    } else {
      console.log("  urlpatterns not exposed on router instance");
    }

    console.log("\n[POC] Concept validated.");
    console.log("[POC] The RSC environment correctly loads the router with all");
    console.log("[POC] its TS/TSX dependencies compiled by Vite's pipeline.");
  } catch (err: any) {
    console.error("[POC] FAILED:", err.message);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(0, 8);
      console.error(lines.join("\n"));
    }
  } finally {
    if (server) {
      await server.close();
    }
  }
}

main();
