/**
 * Build discovery phase: the discovery plugin's buildStart, buildApp (post)
 * and buildEnd hooks.
 *
 * buildStart discovers routers through a temp RSC server and writes the
 * generated route types. When PPR shell candidates exist, it defers closing
 * that server, and releasing the buildEnv, as a PAIR: the buildApp post hook
 * releases them after the shell capture (success), buildEnd after an
 * environment build failure (abort).
 */

import type { Rolldown, ViteBuilder } from "vite";
import type { DiscoveryState } from "./state.js";
import { createTempRscServer } from "../temp-rsc-server.js";
import { acquireBuildEnv, releaseBuildEnv } from "./build-env.js";
import { discoverRouters } from "./discover-routers.js";
import { writeRouteTypesFiles } from "./route-types-writer.js";
import { runShellPrerenderPhase } from "./shell-prerender-phase.js";
import { runRouterVersionsPhase } from "./router-versions-phase.js";
import { resetStagedBuildAssets } from "../utils/prerender-utils.js";
import { createRangoDebugger, timed, timedSync, NS } from "../debug.js";

const debugDiscovery = createRangoDebugger(NS.discovery);

/**
 * Reset the per-build prerender collection state. A helper (not inline
 * assignments in buildStart) so TS's property narrowing does not pin
 * `s.shellCandidates` to `null` across the discovery call that repopulates
 * it — the finally block re-reads it to decide the temp-server keep-alive.
 */
function resetPrerenderCollection(s: DiscoveryState): void {
  s.prerenderManifestEntries = null;
  s.staticManifestEntries = null;
  s.shellCandidates = null;
  s.prerenderPayloadValues = null;
  s.buildData = [];
}

/**
 * buildStart. Build mode: create a temporary Vite dev server to access the
 * RSC environment's module runner, then discover routers and generate
 * manifests. The manifest data is stored for the virtual module's load hook.
 */
export async function buildDiscoveryPhase(
  s: DiscoveryState,
  context: Rolldown.PluginContext,
): Promise<void> {
  if (!s.isBuildMode) return;
  // Only run once across environment builds
  if (s.mergedRouteManifest !== null) {
    debugDiscovery?.(
      "build: skip (already discovered, env=%s)",
      context.environment?.name ?? "?",
    );
    return;
  }
  const buildStartTime = performance.now();
  debugDiscovery?.("build: start (env=%s)", context.environment?.name ?? "?");
  resetStagedBuildAssets(s.projectRoot);
  resetPrerenderCollection(s);

  // Acquire build-time env bindings if configured
  await timed(debugDiscovery, "build acquireBuildEnv", () =>
    acquireBuildEnv(s, s.viteCommand, s.viteMode),
  );

  let tempServer: any = null;
  // Signal to user-space code (e.g. reverse.ts) that build-time discovery
  // is active. Uses globalThis because the temp server's module runner
  // creates a separate module context — there is no shared import path
  // between the vite plugin and user code loaded via runner.import().
  (globalThis as any).__rscRouterDiscoveryActive = true;
  try {
    tempServer = await timed(debugDiscovery, "build createTempRscServer", () =>
      createTempRscServer(s, { forceBuild: true }),
    );

    const rscEnv = (tempServer.environments as any)?.rsc;
    if (!rscEnv?.runner) {
      console.warn(
        "[rango] RSC environment runner not available during build, skipping manifest generation",
      );
      return;
    }

    // Point resolvedStaticModules at the temp server's expose-internal-ids
    // plugin so that discoverRouters() can access the static handler module
    // map after the temp server's transforms populate it.
    const tempIdsPlugin = (tempServer as any).config?.plugins?.find(
      (p: any) => p.name === "@rangojs/router:expose-internal-ids",
    );
    if (tempIdsPlugin?.api?.staticHandlerModules) {
      s.resolvedStaticModules = tempIdsPlugin.api.staticHandlerModules;
    }

    await timed(debugDiscovery, "build discoverRouters", () =>
      discoverRouters(s, rscEnv, (tempServer.environments as any)?.ssr),
    );
    // Update named-routes.gen.ts from runtime discovery.
    // The runtime manifest includes dynamically generated routes
    // that the static parser cannot extract from source code.
    timedSync(debugDiscovery, "build writeRouteTypesFiles", () =>
      writeRouteTypesFiles(s),
    );
  } catch (err: any) {
    // Extract the user source file from the stack trace (skip internal frames)
    const sourceFile = err.stack
      ?.split("\n")
      .find(
        (line: string) =>
          line.includes(s.projectRoot) && !line.includes("node_modules"),
      )
      ?.match(/\(([^)]+)\)/)?.[1];
    // Extract the route name from "Unknown route: <name>" errors
    const routeName = err.message?.match(/Unknown route: (.+)/)?.[1];
    const details = [
      routeName ? `  Route name: ${routeName}` : null,
      sourceFile ? `  File: ${sourceFile}` : null,
      err.stack ? `  Stack:\n${err.stack}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`[rango] Build-time router discovery failed:\n${details}`, {
      cause: err,
    });
  } finally {
    delete (globalThis as any).__rscRouterDiscoveryActive;
    if (tempServer && s.shellCandidates?.length) {
      // Prerender+ppr candidates exist: keep the temp server (and its
      // realm — tries installed, registry populated) alive for the
      // post-build shell capture phase (buildApp post, producer B #699).
      // The prelude embeds built client asset URLs, so the capture can
      // only run after the client build; that phase closes the server.
      // buildEnv release is deferred with it — a bake-lane loader
      // executing during the capture may read ctx.env.
      s.shellPhaseTempServer = tempServer;
    } else {
      if (tempServer) {
        await timed(debugDiscovery, "build tempServer.close", () =>
          tempServer.close(),
        );
      }
      await releaseBuildEnv(s);
    }
    debugDiscovery?.(
      "build discovery done (%sms)",
      (performance.now() - buildStartTime).toFixed(1),
    );
  }
}

/**
 * buildApp (post). Post-build phases, after EVERY environment bundle is
 * written.
 *
 * 1. Cache versions (router-versions-phase.ts): hashes the server output as
 *    postprocessBundle left it and writes the per-router table into the
 *    built version module. First, because phase 2 stamps its entries with
 *    these versions and reads the same RSC out dir.
 * 2. PPR shell capture (producer B, #699): the shell prelude embeds built
 *    client asset URLs (bootstrap entry), which do not exist at buildStart.
 *    The kept temp server and the buildEnv were deferred AS A PAIR in
 *    buildStart's finally; this finally is the pair's success-path owner
 *    (buildEndPhase owns the aborted-build path) — the phase itself is a pure
 *    producer and tears down only the globals it installs.
 */
export async function postBuildPhase(
  s: DiscoveryState,
  builder: ViteBuilder,
): Promise<void> {
  try {
    await runShellPrerenderPhase(
      s,
      builder as any,
      runRouterVersionsPhase(s, builder as any),
    );
  } finally {
    if (s.isBuildMode) {
      const tempServer = s.shellPhaseTempServer;
      s.shellPhaseTempServer = null;
      if (tempServer) await tempServer.close();
      await releaseBuildEnv(s);
    }
  }
}

/**
 * buildEnd. An environment build failure aborts the builder before the
 * buildApp post hook — never leak the kept temp server (open handles hang
 * the CLI) or the deferred buildEnv (a live miniflare proxy).
 */
export async function buildEndPhase(
  s: DiscoveryState,
  error: Error | undefined,
): Promise<void> {
  if (!error || !s.shellPhaseTempServer) return;
  const tempServer = s.shellPhaseTempServer;
  s.shellPhaseTempServer = null;
  try {
    await tempServer.close();
  } finally {
    await releaseBuildEnv(s);
  }
}
