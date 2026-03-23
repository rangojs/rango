/**
 * React Performance Tracks — Vite plugin
 *
 * Dev-only plugin that enables Chrome DevTools Performance tab integration
 * for React Server Components. When no debugChannel is provided to
 * renderToReadableStream, React writes timing data inline in the RSC
 * stream. The client reads them automatically — no separate transport needed.
 *
 * This plugin patches the RSDW client so _debugInfo recovery works for
 * plain-object payloads (our RscPayload shape).
 */

import type { Plugin } from "vite";
import { readFile } from "node:fs/promises";

// Patch for RSDW client: React's flushComponentPerformance uses splice(0) to
// empty chunk._debugInfo after resolution, then tries to recover it from the
// resolved value. The fallback only works for arrays, async iterables, React
// elements, and lazy types — not plain objects. Since our RscPayload is a
// plain object, _debugInfo is lost and the Server Components track stays empty.
// This patch relaxes the check so _debugInfo is recovered from any object.
//
// Uses regex to be resilient to Vite's dep optimizer reformatting.
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
  setup(build: any): void;
} {
  return {
    name: "@rangojs/router:performance-tracks-optimize-deps",
    setup(build: any): void {
      build.onLoad(
        {
          filter:
            /react-server-dom-webpack-client\.browser\.(development|production)\.js$/,
        },
        async (args: { path: string }) => {
          const code = await readFile(args.path, "utf8");
          const patched = patchRsdwClientDebugInfoRecovery(code);
          return {
            contents: patched.code,
            loader: "js",
          };
        },
      );
    },
  };
}

export function performanceTracksPlugin(): Plugin {
  return {
    name: "@rangojs/router:performance-tracks",

    transform(code, id) {
      // Only patch RSDW client browser bundle
      if (!id.includes("react-server-dom") || !id.includes("client")) return;
      const patched = patchRsdwClientDebugInfoRecovery(code);
      if (!patched.debugInfoVar) return;
      if (process.env.INTERNAL_RANGO_DEBUG)
        console.log(
          "[perf-tracks] patched RSDW client for plain-object _debugInfo recovery (var:",
          patched.debugInfoVar,
          ")",
        );
      return patched.code;
    },
  };
}
