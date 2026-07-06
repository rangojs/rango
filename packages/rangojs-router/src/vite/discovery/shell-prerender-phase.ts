/**
 * Post-build PPR shell capture phase (producer B, issue #699) — SPIKE.
 *
 * Runs from the buildApp post hook, after every environment bundle is
 * written. Reuses the buildStart temp server kept alive on DiscoveryState
 * (realm already has tries installed and routers registered), seeds an
 * in-realm prerender store from the retained phase-A Flight payloads, and
 * drives the shared capture core (build-shell-capture.ts) per candidate with
 * an SSR half composed from the temp server's SSR environment runner — the
 * bootstrap script content overridden to the BUILT client entry URL.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryState } from "./state.js";

export async function runShellPrerenderPhase(
  s: DiscoveryState,
  builderConfig: { plugins?: readonly unknown[] } | undefined,
): Promise<void> {
  if (!s.isBuildMode || !s.shellCandidates?.length) return;
  const tempServer = s.shellPhaseTempServer;
  if (!tempServer) return;
  try {
    const rscEnv = tempServer.environments?.rsc;
    const ssrEnv = tempServer.environments?.ssr;
    console.log(
      `[rango][spike] shell phase: candidates=${s.shellCandidates.length} rscRunner=${String(
        !!rscEnv?.runner,
      )} ssrRunner=${String(!!ssrEnv?.runner)}`,
    );
    if (!rscEnv?.runner || !ssrEnv?.runner) return;

    // The MAIN build's version (folded into the shipped worker) — never the
    // temp server's own version-plugin stamp.
    const versionPlugin = (builderConfig?.plugins ?? []).find(
      (p: any) => p?.name === "@rangojs/router:version",
    ) as { api?: { getBuildVersion?: () => string } } | undefined;
    const buildVersion = versionPlugin?.api?.getBuildVersion?.();
    console.log(`[rango][spike] main buildVersion: ${buildVersion}`);

    // In-realm prerender store over the retained phase-A payloads, so the
    // capture's match() re-enters withCacheLookup and replays the build-time
    // segments (globalThis is shared between the plugin process and the temp
    // server's module-runner realm).
    const payloads = s.prerenderPayloadValues!;
    (globalThis as any).__loadPrerenderManifestModule = async () => ({
      default: Object.fromEntries([...payloads.keys()].map((k) => [k, k])),
      loadPrerenderAsset: async (spec: string) => ({
        default: JSON.parse(payloads.get(spec)!),
      }),
    });

    // SSR half from the temp server's SSR environment runner.
    const ssrRunner = ssrEnv.runner;
    const ssrPkg = await ssrRunner.import("@rangojs/router/ssr");
    const ssrDeps = await ssrRunner.import("@rangojs/router/internal/deps/ssr");
    const reactDomServer = await ssrRunner.import("react-dom/server.edge");
    const reactDomStatic = await ssrRunner.import("react-dom/static.edge");
    const htmlStream = await ssrRunner.import(
      "@rangojs/router/internal/deps/html-stream-server",
    );

    // Built client bootstrap: the prelude must embed the BUILT entry URL.
    const assetsDir = join(s.projectRoot, "dist", "client", "assets");
    const entryFile = existsSync(assetsDir)
      ? readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f))
      : undefined;
    const bootstrapContent = entryFile ? `import("/assets/${entryFile}")` : "";
    console.log(`[rango][spike] bootstrap: ${bootstrapContent}`);

    const captureShellHTML = ssrPkg.createShellCaptureHandler({
      createFromReadableStream: ssrDeps.createFromReadableStream,
      renderToReadableStream: reactDomServer.renderToReadableStream,
      resume: reactDomServer.resume,
      prerender: reactDomStatic.prerender,
      injectRSCPayload: htmlStream.injectRSCPayload,
      headScripts: "preinit",
      loadBootstrapScriptContent: async () => bootstrapContent,
    });

    // RSC half: the shared capture core in the RSC realm.
    const rscRunner = rscEnv.runner;
    const captureMod = await rscRunner.import(
      "@rangojs/router/build/shell-capture",
    );
    const serverMod = await rscRunner.import("@rangojs/router/server");
    const registry: Map<string, any> = serverMod.RouterRegistry;

    for (const cand of s.shellCandidates) {
      const ppr = cand.ppr === true ? {} : cand.ppr;
      for (const [, routerInstance] of registry) {
        if (typeof routerInstance.match !== "function") continue;
        const res = await captureMod.captureShellForBuild({
          router: routerInstance,
          urlPath: cand.urlPath,
          key: `${cand.urlPath}:shell`,
          ttl: ppr.ttl,
          swr: ppr.swr,
          tags: ppr.tags,
          buildEnv: s.resolvedBuildEnv,
          buildVersion: buildVersion ?? "unknown",
          captureShellHTML,
          debug: true,
        });
        if (res.outcome === "stored" && res.entry) {
          const preludeBytes = Buffer.from(res.entry.prelude, "base64");
          const html = preludeBytes.toString("utf8");
          console.log(
            `[rango][spike] ${cand.urlPath}: STORED prelude=${preludeBytes.length}b ` +
              `postponed=${res.entry.postponed === null ? "none" : `${res.entry.postponed.length}b`} ` +
              `liveHoles=${String(res.entry.handlerLiveHoles)} snapshot=${res.entry.snapshot?.length ?? 0} ` +
              `tags=${JSON.stringify(res.tags)}`,
          );
          console.log(
            `[rango][spike]   article=${String(html.includes("Prerendered shell content"))} ` +
              `fallback=${String(html.includes("Loading pp seq"))} ` +
              `bootstrap=${entryFile ? String(html.includes(entryFile)) : "?"}`,
          );
        } else {
          console.log(`[rango][spike] ${cand.urlPath}: ${res.outcome}`);
        }
        break;
      }
    }
  } finally {
    s.shellPhaseTempServer = null;
    await tempServer.close();
  }
}
