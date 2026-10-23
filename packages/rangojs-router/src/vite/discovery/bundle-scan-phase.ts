/**
 * Bundle scan phase: the discovery plugin's generateBundle hook.
 *
 * Records the inputs of the per-router cache versions (build-versions.ts) for
 * every environment and, during the RSC build, the RSC entry filename and the
 * chunks holding Prerender/Static handler exports. closeBundle
 * (bundle-postprocess.ts) uses them for handler code eviction and prerender
 * data injection.
 */

import type { Rolldown } from "vite";
import type { DiscoveryState } from "./state.js";
import {
  recordBundleFiles,
  recordClientGraph,
  recordServerGraph,
  recordVersionModuleFiles,
} from "./build-versions.js";
import { extractHandlerExportsFromChunk } from "../utils/bundle-analysis.js";
import { createRangoDebugger, NS } from "../debug.js";

const debugBuild = createRangoDebugger(NS.build);

export function bundleScanPhase(
  s: DiscoveryState,
  context: Rolldown.PluginContext,
  bundle: any,
): void {
  // Inputs of the per-router cache versions (discovery/build-versions.ts).
  // Each pass overwrites its slot: plugin-rsc runs the RSC and SSR builds
  // twice, and the real pass comes last.
  if (s.isBuildMode) {
    const envName = context.environment?.name;
    if (envName) {
      s.versionModuleFiles.set(envName, recordVersionModuleFiles(bundle));
    }
    if (envName === "rsc") {
      s.serverBuildGraph = recordServerGraph(context, bundle);
    } else if (envName === "client") {
      s.clientBuildGraph = recordClientGraph(context, bundle);
    } else if (envName === "ssr") {
      s.ssrBundle = recordBundleFiles(bundle);
    }
  }
  if (context.environment?.name !== "rsc") return;
  const genStart = debugBuild ? performance.now() : 0;

  // Record RSC entry chunk filename for closeBundle injection
  for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
    if (chunk.type === "chunk" && chunk.isEntry) {
      s.rscEntryFileName = fileName;
      break;
    }
  }

  if (!s.resolvedPrerenderModules?.size && !s.resolvedStaticModules?.size) {
    debugBuild?.(
      "generateBundle (rsc): no handlers to scan (%sms)",
      (performance.now() - genStart).toFixed(1),
    );
    return;
  }

  // Clear maps at the start of each RSC generateBundle pass.
  // Vite 6 multi-environment builds run RSC twice (analysis + production);
  // clearing prevents stale/duplicate records from the analysis pass.
  s.handlerChunkInfoMap.clear();
  s.staticHandlerChunkInfoMap.clear();

  for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
    if (chunk.type !== "chunk") continue;

    // Scan all chunks for handler exports (handlers may land in any chunk)
    if (s.resolvedPrerenderModules?.size) {
      const handlers = extractHandlerExportsFromChunk(
        chunk.code,
        s.resolvedPrerenderModules,
        "Prerender",
        false,
        // Mark onDemand exports (retained, not evicted) from the
        // discovery-derived $$id set — the same evaluated source that sets
        // the runtime od trie flag, so retention and serve can never
        // disagree. Populated by discoverRouters (buildStart), which runs
        // before this generateBundle pass.
        s.onDemandHandlerIds,
      );
      if (handlers.length > 0) {
        const existing = s.handlerChunkInfoMap.get(fileName);
        if (existing) {
          existing.exports.push(...handlers);
        } else {
          s.handlerChunkInfoMap.set(fileName, {
            fileName,
            exports: handlers,
          });
        }
      }
    }

    if (s.resolvedStaticModules?.size) {
      const handlers = extractHandlerExportsFromChunk(
        chunk.code,
        s.resolvedStaticModules,
        "Static",
        false,
      );
      if (handlers.length > 0) {
        const existing = s.staticHandlerChunkInfoMap.get(fileName);
        if (existing) {
          existing.exports.push(...handlers);
        } else {
          s.staticHandlerChunkInfoMap.set(fileName, {
            fileName,
            exports: handlers,
          });
        }
      }
    }
  }

  debugBuild?.(
    "generateBundle (rsc): scanned %d chunks, %d prerender chunk(s), %d static chunk(s) (%sms)",
    Object.keys(bundle).length,
    s.handlerChunkInfoMap.size,
    s.staticHandlerChunkInfoMap.size,
    (performance.now() - genStart).toFixed(1),
  );
}
