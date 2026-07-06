/**
 * Post-build PPR shell capture phase (producer B, issue #699).
 *
 * Runs from the buildApp post hook, AFTER every environment bundle is written
 * — the shell prelude embeds built client asset URLs (the bootstrap entry),
 * which do not exist during buildStart discovery. Reuses the buildStart temp
 * server kept alive on DiscoveryState (its realm already has tries installed
 * and routers registered), seeds an in-realm prerender store from the
 * retained phase-A Flight payloads, and drives the shared capture core
 * (prerender/build-shell-capture.ts) once per Prerender+ppr candidate. The
 * SSR half is composed from the temp server's SSR environment runner with
 * the BUILT client entry as bootstrap.
 *
 * Stored entries are staged as __ps-*.js asset modules under the RSC out
 * dir with a lazy __shell-manifest.js (mirroring the prerender manifest);
 * the runtime read-through (rsc/shell-build-manifest.ts) serves them on a
 * shell-store MISS. A candidate whose capture is refused, produces no shell,
 * or never consulted the prerender store is SKIPPED loudly — the route keeps
 * producer A (runtime capture) semantics, never a wrong-lane bake.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { jsonParseExpression } from "../utils/manifest-utils.js";
import { writeBuildAssetModule } from "../utils/prerender-utils.js";
import { buildShellManifestKey } from "../../prerender/shell-manifest-key.js";
// Type-only: the producer stages exactly the record shape the runtime
// read-through consumes, so the contract cannot drift (the KEY half of that
// contract is shell-manifest-key.ts). No runtime coupling — the RSC-runtime
// module is never imported by plugin code.
import type { BuildShellEntry } from "../../rsc/shell-build-manifest.js";
import type { DiscoveryState, ShellPrerenderCandidate } from "./state.js";
import { createRangoDebugger, NS } from "../debug.js";

const debug = createRangoDebugger(NS.prerender);

/**
 * Minimal builder surface the phase reads: resolved plugins (for the main
 * build's version plugin) and per-environment outDirs.
 */
interface BuilderLike {
  config?: {
    base?: string;
    plugins?: readonly unknown[];
  };
  environments?: Record<
    string,
    { config?: { build?: { outDir?: string } } } | undefined
  >;
}

export async function runShellPrerenderPhase(
  s: DiscoveryState,
  builder: BuilderLike | undefined,
): Promise<void> {
  // The kept temp server (and the buildEnv deferred with it) is OWNED by the
  // callers — the buildApp post hook's finally on success, buildEnd on an
  // aborted build — so this function stays a pure producer: it only tears
  // down the globals it installs itself.
  const tempServer = s.shellPhaseTempServer;
  if (!s.isBuildMode || !s.shellCandidates?.length || !tempServer) return;

  const candidates: ShellPrerenderCandidate[] = s.shellCandidates;
  const startTotal = performance.now();
  console.log(`[rango] Shell-prerendering ${candidates.length} URL(s)...`);

  let restoreClientRequire: (() => void) | undefined;
  try {
    // Runner access needs the RunnableDevEnvironment surface; the environments
    // map types as DevEnvironment (same cast the dev endpoints use).
    const rscEnv = (tempServer.environments as any)?.rsc;
    const ssrEnv = (tempServer.environments as any)?.ssr;
    if (!rscEnv?.runner || !ssrEnv?.runner) {
      console.warn(
        "[rango] shell prerender: temp server runners unavailable " +
          `(rsc=${String(!!rscEnv?.runner)}, ssr=${String(!!ssrEnv?.runner)}); ` +
          "skipping — routes keep runtime shell capture.",
      );
      return;
    }

    // The MAIN build's version (the value folded into the shipped worker) —
    // never the temp server's own version-plugin stamp, which is a different
    // Date.now() and would fail the serve-side isValidShellHit gate forever.
    const versionPlugin = (builder?.config?.plugins ?? []).find(
      (p: any) => p?.name === "@rangojs/router:version",
    ) as { api?: { getBuildVersion?: () => string } } | undefined;
    const buildVersion = versionPlugin?.api?.getBuildVersion?.();
    if (!buildVersion) {
      console.warn(
        "[rango] shell prerender: main build version unavailable; skipping — " +
          "routes keep runtime shell capture.",
      );
      return;
    }

    // In-realm prerender store over the retained phase-A payloads, so the
    // capture's match() re-enters withCacheLookup and REPLAYS the build-time
    // segments (globalThis is shared between the plugin process and the temp
    // server's module-runner realms). `fetchedKeys` doubles as the replay
    // assertion: a capture whose candidate key was never fetched rendered
    // something else (live handler, wrong route) and must not be baked.
    const payloads = s.prerenderPayloadValues ?? new Map<string, string>();
    const fetchedKeys = new Set<string>();
    (globalThis as any).__loadPrerenderManifestModule = async () => ({
      default: Object.fromEntries([...payloads.keys()].map((k) => [k, k])),
      loadPrerenderAsset: async (spec: string) => {
        fetchedKeys.add(spec);
        return { default: JSON.parse(payloads.get(spec)!) };
      },
    });

    // SSR half from the temp server's SSR environment runner. react-dom's
    // edge builds surface as default-only namespaces through the runner.
    const ssrRunner = ssrEnv.runner;
    const ssrPkg = await ssrRunner.import("@rangojs/router/ssr");
    const ssrDeps = await ssrRunner.import("@rangojs/router/internal/deps/ssr");
    const reactDomServer = await ssrRunner.import("react-dom/server.edge");
    const reactDomStatic = await ssrRunner.import("react-dom/static.edge");
    const htmlStream = await ssrRunner.import(
      "@rangojs/router/internal/deps/html-stream-server",
    );

    // Built client bootstrap: the prelude must embed the BUILT entry URL.
    const clientOutDir =
      builder?.environments?.client?.config?.build?.outDir ??
      resolve(s.projectRoot, "dist/client");
    const clientAssetsDir = join(clientOutDir, "assets");
    const entryFile = existsSync(clientAssetsDir)
      ? readdirSync(clientAssetsDir).find((f) => /^index-.*\.js$/.test(f))
      : undefined;
    if (!entryFile) {
      console.warn(
        `[rango] shell prerender: built client entry not found under ${clientAssetsDir}; ` +
          "skipping — routes keep runtime shell capture.",
      );
      return;
    }
    const base = builder?.config?.base ?? "/";
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    const bootstrapContent = `import("${normalizedBase}assets/${entryFile}")`;
    debug?.("shell prerender bootstrap: %s", bootstrapContent);

    // The Flight payloads carry PRODUCTION-HASHED client reference ids
    // (hashClientRefs, forceBuild) — resolvable only in the built bundles.
    // The temp server's SSR loader receives those hashes and can neither
    // validate nor import them (dev refKeys are module URLs). Bridge: wrap
    // the SSR realm's late-bound client require (__vite_rsc_client_require__,
    // read per call by plugin-rsc's __vite_rsc_require__) with a hash ->
    // dev-refKey reverse map computed from plugin-rsc's manager using the
    // SAME hashing (computeProductionHash). Lazy rebuild on miss: a client
    // module first transformed DURING capture registers after the map was
    // built. The RSC realm needs no bridge — its $$decode-client lane
    // re-registers references by id without loading modules.
    const minimalPlugin = (tempServer.config?.plugins ?? []).find(
      (p: any) => p?.name === "rsc:minimal",
    );
    const rscManager = minimalPlugin?.api?.manager;
    const { computeProductionHash } =
      await import("../plugins/client-ref-hashing.js");
    let hashToDevKey = new Map<string, string>();
    const rebuildHashMap = (): void => {
      hashToDevKey = new Map();
      const metaMap = rscManager?.clientReferenceMetaMap ?? {};
      for (const meta of Object.values(metaMap) as Array<{
        referenceKey: string;
      }>) {
        hashToDevKey.set(
          computeProductionHash(s.projectRoot, meta.referenceKey),
          meta.referenceKey,
        );
      }
    };
    const origClientRequire = (globalThis as any).__vite_rsc_client_require__;
    if (typeof origClientRequire === "function") {
      restoreClientRequire = () => {
        (globalThis as any).__vite_rsc_client_require__ = origClientRequire;
      };
      (globalThis as any).__vite_rsc_client_require__ = (id: string) => {
        const base = id.split("$$cache=")[0]!;
        let mapped = hashToDevKey.get(base);
        if (mapped === undefined) {
          rebuildHashMap();
          mapped = hashToDevKey.get(base);
        }
        return origClientRequire(mapped ?? id);
      };
    }

    const captureShellHTML = ssrPkg.createShellCaptureHandler({
      createFromReadableStream: ssrDeps.createFromReadableStream,
      renderToReadableStream:
        reactDomServer.renderToReadableStream ??
        reactDomServer.default?.renderToReadableStream,
      resume: reactDomServer.resume ?? reactDomServer.default?.resume,
      prerender: reactDomStatic.prerender ?? reactDomStatic.default?.prerender,
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

    const staged: Array<{ key: string; value: string }> = [];
    let skipCount = 0;

    // Manifest keys are pathname-only (see shell-manifest-key.ts): two
    // candidates on one pathname (two routers prerendering the same path)
    // would be ambiguous at serve time — decline ALL of that pathname's
    // entries rather than bake a wrong-router shell.
    const pathCounts = new Map<string, number>();
    for (const cand of candidates) {
      pathCounts.set(cand.urlPath, (pathCounts.get(cand.urlPath) ?? 0) + 1);
    }

    for (const cand of candidates) {
      if ((pathCounts.get(cand.urlPath) ?? 0) > 1) {
        console.warn(
          `[rango]   SHELL SKIP ${cand.urlPath.padEnd(34)} - pathname claimed by multiple prerender routes; routes keep runtime capture`,
        );
        skipCount++;
        continue;
      }
      const startUrl = performance.now();
      const policy = captureMod.resolveBuildPprConfig(cand.ppr);
      const mainKey = `${cand.routeName}/${cand.paramHash}`;
      let handled = false;
      const mismatches: string[] = [];
      for (const [, routerInstance] of registry) {
        if (typeof routerInstance.match !== "function") continue;
        try {
          const res = await captureMod.captureShellForBuild({
            router: routerInstance,
            urlPath: cand.urlPath,
            routeName: cand.routeName,
            key: `${cand.urlPath}:shell`,
            ttl: policy.ttl,
            swr: policy.swr,
            tags: policy.tags,
            buildEnv: s.resolvedBuildEnv,
            buildVersion,
            captureShellHTML,
            debug: !!debug,
          });
          if (res.outcome === "route-mismatch") {
            mismatches.push(res.matchedRouteName ?? "(no match)");
            continue;
          }
          handled = true;
          const elapsed = (performance.now() - startUrl).toFixed(0);
          if (res.outcome !== "stored" || !res.entry) {
            console.warn(
              `[rango]   SHELL SKIP ${cand.urlPath.padEnd(34)} (${elapsed}ms) - capture ${res.outcome}; route keeps runtime capture`,
            );
            skipCount++;
            break;
          }
          // Replay assertion: the capture must have fetched THIS candidate's
          // prerender payload — otherwise it rendered outside the store
          // (live handler in the source realm) and baking it would encode a
          // lane production never serves.
          if (!fetchedKeys.has(mainKey)) {
            console.warn(
              `[rango]   SHELL SKIP ${cand.urlPath.padEnd(34)} (${elapsed}ms) - capture did not replay the prerender store; route keeps runtime capture`,
            );
            skipCount++;
            break;
          }
          const value: BuildShellEntry = {
            entry: res.entry,
            ttl: policy.ttl,
            swr: policy.swr,
            tags: res.tags,
            routeName: cand.routeName,
          };
          staged.push({
            key: buildShellManifestKey(cand.urlPath),
            value: JSON.stringify(value),
          });
          console.log(
            `[rango]   SHELL OK   ${cand.urlPath.padEnd(34)} (${elapsed}ms)`,
          );
          break;
        } catch (err: any) {
          handled = true;
          const elapsed = (performance.now() - startUrl).toFixed(0);
          console.warn(
            `[rango]   SHELL SKIP ${cand.urlPath.padEnd(34)} (${elapsed}ms) - ${err?.message ?? err}; route keeps runtime capture`,
          );
          skipCount++;
          break;
        }
      }
      if (!handled) {
        console.warn(
          `[rango]   SHELL SKIP ${cand.urlPath.padEnd(34)} - no router matched "${cand.routeName}"` +
            (mismatches.length > 0
              ? ` (matched: ${mismatches.join(", ")})`
              : "") +
            "; route keeps runtime capture",
        );
        skipCount++;
      }
    }

    if (staged.length > 0) {
      const rscOutDir =
        builder?.environments?.rsc?.config?.build?.outDir ??
        resolve(s.projectRoot, "dist/rsc");
      writeShellManifest(s, rscOutDir, staged);
    }

    const totalElapsed = (performance.now() - startTotal).toFixed(0);
    const parts = [`${staged.length} done`];
    if (skipCount > 0) parts.push(`${skipCount} skipped`);
    console.log(
      `[rango] Shell prerender complete: ${parts.join(", ")} (${totalElapsed}ms total)`,
    );
  } catch (err: any) {
    // The shell phase is an optimization over runtime capture — a failure
    // must never fail an otherwise-good build. Loud, so a first-request-HIT
    // expectation is never silently degraded.
    console.warn(
      `[rango] shell prerender phase failed: ${err?.message ?? err}; ` +
        "routes keep runtime shell capture.",
    );
  } finally {
    // Tear down only what THIS function installed (its globals). The kept
    // temp server + deferred buildEnv pair is owned by the callers: the
    // buildApp post hook's finally on success, buildEnd on an aborted build.
    delete (globalThis as any).__loadPrerenderManifestModule;
    restoreClientRequire?.();
  }
}

/**
 * Write staged shell entries as content-hashed asset modules + the lazy
 * manifest, and inject the loader global into the built RSC entry. Mirrors
 * postprocessBundle's prerender manifest mechanics, but runs POST-buildApp
 * (the RSC entry on disk was already postprocessed — read-modify-write with
 * an idempotence guard).
 */
function writeShellManifest(
  s: DiscoveryState,
  rscOutDir: string,
  staged: Array<{ key: string; value: string }>,
): void {
  const rscEntryPath = resolve(rscOutDir, s.rscEntryFileName ?? "index.js");
  if (!existsSync(rscEntryPath)) {
    console.warn(
      `[rango] shell prerender: RSC entry not found at ${rscEntryPath}; ` +
        "entries not persisted — routes keep runtime capture.",
    );
    return;
  }
  const assetsDir = resolve(rscOutDir, "assets");

  let totalBytes = 0;
  const manifestMap: Record<string, string> = {};
  const countedFiles = new Set<string>();
  for (const { key, value } of staged) {
    const fileName = writeBuildAssetModule(assetsDir, "__ps", value);
    if (!countedFiles.has(fileName)) {
      countedFiles.add(fileName);
      totalBytes += Buffer.byteLength(value) + "export default ;\n".length;
    }
    manifestMap[key] = `./assets/${fileName}`;
  }

  const manifestCode = [
    `const m=${jsonParseExpression(manifestMap)};`,
    `export function loadShellAsset(s){return import(s)}`,
    `export default m;`,
    "",
  ].join("\n");
  writeFileSync(resolve(rscOutDir, "__shell-manifest.js"), manifestCode);
  totalBytes += Buffer.byteLength(manifestCode);

  const rscCode = readFileSync(rscEntryPath, "utf-8");
  if (!rscCode.includes("__shell-manifest.js")) {
    const injection = `globalThis.__loadShellManifestModule = () => import("./__shell-manifest.js");\n`;
    writeFileSync(rscEntryPath, injection + rscCode);
  }

  const totalKB = (totalBytes / 1024).toFixed(1);
  console.log(
    `[rango] Wrote shell assets (${totalKB} KB total, ${staged.length} entries)`,
  );
}
