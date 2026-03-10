/**
 * Bundle Post-Processing
 *
 * Handles handler code eviction from prerender/static chunks and
 * injection of collected prerender/static data into the RSC entry bundle.
 */

import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { evictHandlerCode } from "../utils/bundle-analysis.js";
import type { DiscoveryState } from "./state.js";

/**
 * Post-process the RSC bundle: evict handler code and inject
 * prerender/static data as importable asset modules.
 */
export function postprocessBundle(state: DiscoveryState): void {
  const hasPrerenderData =
    state.prerenderCollectedData &&
    Object.keys(state.prerenderCollectedData).length > 0;
  const hasStaticData =
    state.staticCollectedData &&
    Object.keys(state.staticCollectedData).length > 0;
  if (!hasPrerenderData && !hasStaticData) return;

  // Find RSC entry (recorded in generateBundle, fallback to dist/rsc/index.js)
  const rscEntryPath = resolve(
    state.projectRoot,
    "dist/rsc",
    state.rscEntryFileName ?? "index.js",
  );

  // 1. Evict handler code from __prerender-handlers and __static-handlers chunks.
  // handlerChunkInfo/staticHandlerChunkInfo are populated by generateBundle
  // after the production RSC build. In Vite 6 multi-environment builds, the
  // RSC build runs twice (analysis + production). Chunk info is only available
  // after the production pass, so we run eviction whenever it becomes available.
  const evictionTargets: Array<{
    info: typeof state.handlerChunkInfo;
    fnName: string;
    brand: string;
    label: string;
  }> = [
    {
      info: state.handlerChunkInfo,
      fnName: "Prerender",
      brand: "prerenderHandler",
      label: "handler code from RSC bundle",
    },
    {
      info: state.staticHandlerChunkInfo,
      fnName: "Static",
      brand: "staticHandler",
      label: "static handler code",
    },
  ];

  for (const target of evictionTargets) {
    if (!target.info) continue;
    const chunkPath = resolve(
      state.projectRoot,
      "dist/rsc",
      target.info.fileName,
    );
    try {
      const code = readFileSync(chunkPath, "utf-8");
      const result = evictHandlerCode(
        code,
        target.info.exports,
        target.fnName,
        target.brand,
      );
      if (result) {
        writeFileSync(chunkPath, result.code);
        const savedKB = (result.savedBytes / 1024).toFixed(1);
        console.log(
          `[rsc-router] Evicted ${target.label} (${savedKB} KB saved): ${target.info.fileName}`,
        );
      }
    } catch (replaceErr: any) {
      console.warn(
        `[rsc-router] Failed to evict ${target.label}: ${replaceErr.message}`,
      );
    }
  }
  state.handlerChunkInfo = null;
  state.staticHandlerChunkInfo = null;

  // 2. Write prerender data as separate importable asset modules
  // and inject a manifest import into the RSC entry.
  if (hasPrerenderData && existsSync(rscEntryPath)) {
    const rscCode = readFileSync(rscEntryPath, "utf-8");
    // Check for the specific injection marker, not just the variable name.
    // The runtime code (prerender store) also references __PRERENDER_MANIFEST,
    // so a broad string check would false-positive and skip injection.
    if (!rscCode.includes("__prerender-manifest.js")) {
      try {
        const assetsDir = resolve(state.projectRoot, "dist/rsc/assets");
        mkdirSync(assetsDir, { recursive: true });

        const manifestEntries: string[] = [];
        let totalBytes = 0;

        for (const [key, entry] of Object.entries(
          state.prerenderCollectedData!,
        )) {
          const entryJson = JSON.stringify(entry);
          const contentHash = createHash("sha256")
            .update(entryJson)
            .digest("hex")
            .slice(0, 8);
          const assetFileName = `__pr-${contentHash}.js`;
          const assetPath = resolve(assetsDir, assetFileName);
          const assetCode = `export default ${entryJson};\n`;
          writeFileSync(assetPath, assetCode);
          totalBytes += Buffer.byteLength(assetCode);
          manifestEntries.push(
            `${JSON.stringify(key)}:()=>import("./assets/${assetFileName}")`,
          );
        }

        const manifestCode = `const m={${manifestEntries.join(",")}};export default m;\n`;
        const manifestPath = resolve(
          state.projectRoot,
          "dist/rsc/__prerender-manifest.js",
        );
        writeFileSync(manifestPath, manifestCode);
        totalBytes += Buffer.byteLength(manifestCode);

        const injection = `import __pm from "./__prerender-manifest.js";\nglobalThis.__PRERENDER_MANIFEST = __pm;\n`;
        writeFileSync(rscEntryPath, injection + rscCode);

        const totalKB = (totalBytes / 1024).toFixed(1);
        console.log(
          `[rsc-router] Wrote prerender assets (${totalKB} KB total, ${Object.keys(state.prerenderCollectedData!).length} entries)`,
        );
      } catch (err: any) {
        throw new Error(
          `[rsc-router] Failed to write prerender assets: ${err.message}`,
        );
      }
    }
  }

  // 3. Write static handler data as separate importable asset modules
  // and inject a __STATIC_MANIFEST import into the RSC entry.
  if (hasStaticData && existsSync(rscEntryPath)) {
    const rscCode = readFileSync(rscEntryPath, "utf-8");
    if (!rscCode.includes("__STATIC_MANIFEST")) {
      try {
        const assetsDir = resolve(state.projectRoot, "dist/rsc/assets");
        mkdirSync(assetsDir, { recursive: true });

        const manifestEntries: string[] = [];
        let totalBytes = 0;

        for (const [handlerId, { encoded, handles }] of Object.entries(
          state.staticCollectedData!,
        )) {
          // Store both the Flight payload and handle data
          const hasHandles = Object.keys(handles).length > 0;
          const exportValue = hasHandles
            ? JSON.stringify({ encoded, handles })
            : JSON.stringify(encoded);
          // Hash the full payload that is written so distinct handle
          // snapshots produce distinct asset filenames.
          const contentHash = createHash("sha256")
            .update(exportValue)
            .digest("hex")
            .slice(0, 8);
          const assetFileName = `__st-${contentHash}.js`;
          const assetPath = resolve(assetsDir, assetFileName);
          const assetCode = `export default ${exportValue};\n`;
          writeFileSync(assetPath, assetCode);
          totalBytes += Buffer.byteLength(assetCode);
          manifestEntries.push(
            `${JSON.stringify(handlerId)}:()=>import("./assets/${assetFileName}")`,
          );
        }

        // Set the global inside the manifest module so it is assigned
        // during module evaluation (before dependent modules like
        // segment-resolution.ts run their top-level initializers).
        const manifestCode = `const m={${manifestEntries.join(",")}};globalThis.__STATIC_MANIFEST=m;export default m;\n`;
        const manifestPath = resolve(
          state.projectRoot,
          "dist/rsc/__static-manifest.js",
        );
        writeFileSync(manifestPath, manifestCode);
        totalBytes += Buffer.byteLength(manifestCode);

        // The import ensures the manifest module is evaluated early.
        // The global is already set inside the module itself.
        const injection = `import "./__static-manifest.js";\n`;
        writeFileSync(rscEntryPath, injection + rscCode);

        const totalKB = (totalBytes / 1024).toFixed(1);
        console.log(
          `[rsc-router] Wrote static assets (${totalKB} KB total, ${Object.keys(state.staticCollectedData!).length} entries)`,
        );
      } catch (err: any) {
        throw new Error(
          `[rsc-router] Failed to write static assets: ${err.message}`,
        );
      }
    }
  }
}
