/**
 * React Performance Tracks — RSDW client patch
 *
 * Patches the RSDW client so _debugInfo recovery works for plain-object
 * payloads (our RscPayload shape). Without this, the Server Components
 * track in Chrome DevTools stays empty.
 *
 * React's flushComponentPerformance uses splice(0) to empty _debugInfo
 * after resolution, then recovers it from the resolved value — but only
 * for arrays, async iterables, React elements, and lazy types. Since our
 * RscPayload is a plain object, _debugInfo is lost. This patch relaxes
 * the check so _debugInfo is recovered from any object.
 */

import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { createRangoDebugger, createCounter, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

const RSDW_PATCH_RE =
  /((?:var|let|const)\s+\w+\s*=\s*root\._children\s*,\s*(\w+)\s*=\s*root\._debugInfo\s*[;,])/;

function buildPatchReplacement(match: string, debugInfoVar: string): string {
  return `${match}
if (${debugInfoVar} && 0 === ${debugInfoVar}.length && "fulfilled" === root.status) {
  var _resolved = "function" === typeof resolveLazy ? resolveLazy(root.value) : root.value;
  if ("object" === typeof _resolved && null !== _resolved && isArrayImpl(_resolved._debugInfo)) {
    ${debugInfoVar} = _resolved._debugInfo;
  }
}`;
}

export function patchRsdwClientDebugInfoRecovery(code: string): {
  code: string;
  debugInfoVar: string | null;
} {
  const match = code.match(RSDW_PATCH_RE);
  if (!match) {
    return { code, debugInfoVar: null };
  }

  return {
    code: code.replace(match[1]!, buildPatchReplacement(match[1]!, match[2]!)),
    debugInfoVar: match[2]!,
  };
}

export function performanceTracksOptimizeDepsPlugin(): {
  name: string;
  load(id: string): Promise<{ code: string } | null>;
} {
  const RSDW_CLIENT_RE =
    /react-server-dom-webpack-client\.browser\.(development|production)\.js$/;
  return {
    name: "@rangojs/router:performance-tracks-optimize-deps",
    // Vite 8 optimizes deps with Rolldown (Rollup-style plugin pipeline), so the
    // pre-bundled RSDW client is patched via load() rather than esbuild's onLoad.
    // Returning code overrides Rolldown's default filesystem read for the module.
    async load(id: string): Promise<{ code: string } | null> {
      const cleanId = id.split("?")[0] ?? id;
      if (!RSDW_CLIENT_RE.test(cleanId)) return null;
      const code = await readFile(cleanId, "utf8");
      const patched = patchRsdwClientDebugInfoRecovery(code);
      return { code: patched.code };
    },
  };
}

export function performanceTracksPlugin(): Plugin {
  const counter = createCounter(debug, "performance-tracks");
  return {
    name: "@rangojs/router:performance-tracks",

    buildEnd() {
      counter?.flush();
    },

    transform(code, id) {
      if (!id.includes("react-server-dom") || !id.includes("client")) return;
      const start = counter ? performance.now() : 0;
      try {
        const patched = patchRsdwClientDebugInfoRecovery(code);
        if (!patched.debugInfoVar) return;
        debug?.("patched RSDW client (var: %s)", patched.debugInfoVar);
        return patched.code;
      } finally {
        counter?.record(id, performance.now() - start);
      }
    },
  };
}
