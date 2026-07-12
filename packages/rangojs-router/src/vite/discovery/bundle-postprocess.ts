/**
 * Bundle Post-Processing
 *
 * Handles handler code eviction from prerender/static chunks and
 * injection of collected prerender/static data into the RSC entry bundle.
 */

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { evictHandlerCode } from "../utils/bundle-analysis.js";
import { copyStagedBuildAssets } from "../utils/prerender-utils.js";
import { jsonParseExpression } from "../utils/manifest-utils.js";
import type { DiscoveryState } from "./state.js";

/**
 * Post-process the RSC bundle: evict handler code and inject
 * prerender/static data as importable asset modules.
 */
export function postprocessBundle(state: DiscoveryState): void {
  const hasPrerenderData =
    state.prerenderManifestEntries &&
    Object.keys(state.prerenderManifestEntries).length > 0;
  const hasStaticData =
    state.staticManifestEntries &&
    Object.keys(state.staticManifestEntries).length > 0;
  if (!hasPrerenderData && !hasStaticData) return;

  // Find RSC entry (recorded in generateBundle, fallback to dist/rsc/index.js)
  const rscEntryPath = resolve(
    state.projectRoot,
    "dist/rsc",
    state.rscEntryFileName ?? "index.js",
  );

  // 1. Evict handler code from whichever chunks contain handler exports.
  // onDemand retention needs no cross-check here: the chunk scan marks
  // onDemand exports directly from state.onDemandHandlerIds (the evaluated
  // source's $$id set), so retention and the runtime od trie flag share one
  // derivation and cannot disagree.
  // handlerChunkInfoMap/staticHandlerChunkInfoMap are populated by generateBundle
  // after the production RSC build. In Vite 6 multi-environment builds, the
  // RSC build runs twice (analysis + production). The maps are cleared at the
  // start of each generateBundle pass so only production data is used here.
  const evictionTargets: Array<{
    infos: Iterable<import("./state.js").ChunkInfo>;
    fnName: string;
    brand: string;
    label: string;
  }> = [
    {
      infos: state.handlerChunkInfoMap.values(),
      fnName: "Prerender",
      brand: "prerenderHandler",
      label: "handler code from RSC bundle",
    },
    {
      infos: state.staticHandlerChunkInfoMap.values(),
      fnName: "Static",
      brand: "staticHandler",
      label: "static handler code",
    },
  ];

  for (const target of evictionTargets) {
    for (const info of target.infos) {
      const chunkPath = resolve(state.projectRoot, "dist/rsc", info.fileName);
      try {
        const code = readFileSync(chunkPath, "utf-8");
        const result = evictHandlerCode(
          code,
          info.exports,
          target.fnName,
          target.brand,
        );
        if (result) {
          writeFileSync(chunkPath, result.code);
          const savedKB = (result.savedBytes / 1024).toFixed(1);
          console.log(
            `[rango] Evicted ${target.label} (${savedKB} KB saved): ${info.fileName}`,
          );
        }
      } catch (replaceErr: any) {
        console.warn(
          `[rango] Failed to evict ${target.label}: ${replaceErr.message}`,
        );
      }
    }
  }
  state.handlerChunkInfoMap.clear();
  state.staticHandlerChunkInfoMap.clear();

  // 2. Write prerender data as separate importable asset modules
  // and inject a lazy manifest loader into the RSC entry.
  if (hasPrerenderData && existsSync(rscEntryPath)) {
    const rscCode = readFileSync(rscEntryPath, "utf-8");
    // Check for the specific injection marker to avoid double-injection.
    if (!rscCode.includes("__prerender-manifest.js")) {
      try {
        let totalBytes = copyStagedBuildAssets(
          state.projectRoot,
          Object.values(state.prerenderManifestEntries!),
        );

        const manifestMap: Record<string, string> = {};
        for (const [key, assetFileName] of Object.entries(
          state.prerenderManifestEntries!,
        )) {
          manifestMap[key] = `./assets/${assetFileName}`;
        }

        const manifestCode = [
          `const m=${jsonParseExpression(manifestMap)};`,
          `export function loadPrerenderAsset(s){return import(s)}`,
          `export default m;`,
          "",
        ].join("\n");
        const manifestPath = resolve(
          state.projectRoot,
          "dist/rsc/__prerender-manifest.js",
        );
        writeFileSync(manifestPath, manifestCode);
        totalBytes += Buffer.byteLength(manifestCode);

        const injection = `globalThis.__loadPrerenderManifestModule = () => import("./__prerender-manifest.js");\n`;
        writeFileSync(rscEntryPath, injection + rscCode);

        const totalKB = (totalBytes / 1024).toFixed(1);
        console.log(
          `[rango] Wrote prerender assets (${totalKB} KB total, ${Object.keys(state.prerenderManifestEntries!).length} entries)`,
        );
      } catch (err: any) {
        throw new Error(
          `[rango] Failed to write prerender assets: ${err.message}`,
        );
      }
    }
  }

  // 3. Write static handler data as separate importable asset modules
  // and inject a lazy loader thunk into the RSC entry.
  if (hasStaticData && existsSync(rscEntryPath)) {
    const rscCode = readFileSync(rscEntryPath, "utf-8");
    if (!rscCode.includes("__static-manifest.js")) {
      try {
        const manifestEntries: string[] = [];
        let totalBytes = copyStagedBuildAssets(
          state.projectRoot,
          Object.values(state.staticManifestEntries!),
        );

        for (const [handlerId, assetFileName] of Object.entries(
          state.staticManifestEntries!,
        )) {
          manifestEntries.push(
            `${JSON.stringify(handlerId)}:()=>import("./assets/${assetFileName}")`,
          );
        }

        // The module assigns the global on evaluation; evaluation itself is
        // DEFERRED behind the loader thunk below (mirroring the prerender and
        // shell manifests), so the thunk table stays off the worker's eager
        // cold-start path (issue #760) — it grows O(#Static handlers).
        const manifestCode = `const m={${manifestEntries.join(",")}};globalThis.__STATIC_MANIFEST=m;export default m;\n`;
        const manifestPath = resolve(
          state.projectRoot,
          "dist/rsc/__static-manifest.js",
        );
        writeFileSync(manifestPath, manifestCode);
        totalBytes += Buffer.byteLength(manifestCode);

        // Lazy thunk, NOT an eager import: static-store.ts resolves it on the
        // first Static() lookup (a first-call latch — the entry body assigning
        // this global runs after hoisted imports, so an eval-time read in
        // static-store.ts could never see it).
        const injection = `globalThis.__loadStaticManifestModule = () => import("./__static-manifest.js");\n`;
        writeFileSync(rscEntryPath, injection + rscCode);

        const totalKB = (totalBytes / 1024).toFixed(1);
        console.log(
          `[rango] Wrote static assets (${totalKB} KB total, ${Object.keys(state.staticManifestEntries!).length} entries)`,
        );
      } catch (err: any) {
        throw new Error(
          `[rango] Failed to write static assets: ${err.message}`,
        );
      }
    }
  }
}
