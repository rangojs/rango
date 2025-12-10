import type { Plugin } from "vite";
import MagicString from "magic-string";

/**
 * Transform code to expose action IDs on createServerReference calls.
 * Wraps each call with an IIFE that attaches $$id to the returned function.
 * Returns both the transformed code and a sourcemap.
 */
function transformServerReferences(
  code: string,
  id?: string
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (!code.includes("createServerReference(")) {
    return null;
  }

  // Match: createServerReference("hash#actionName", ...) or $$ReactClient.createServerReference(...)
  // The RSC plugin uses $$ReactClient namespace in transformed code
  // Capture the optional prefix (like "$$ReactClient.") and the function call
  const pattern =
    /((?:\$\$\w+\.)?createServerReference)\(("[^"]+#[^"]+")([^)]*)\)/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    hasChanges = true;
    const [fullMatch, fnCall, idArg, rest] = match;
    const start = match.index;
    const end = start + fullMatch.length;
    // Wrap the createServerReference call to attach $$id to the returned function
    const replacement = `(function(fn) { fn.$$id = ${idArg}; return fn; })(${fnCall}(${idArg}${rest}))`;
    s.overwrite(start, end, replacement);
  }

  if (!hasChanges) {
    return null;
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: id, includeContent: true }),
  };
}

/**
 * Vite plugin that exposes action IDs on server reference functions.
 *
 * When React Server Components creates server references via createServerReference(),
 * the action ID (format: "hash#actionName") is passed as the first argument but not
 * exposed on the returned function. This plugin transforms the output to attach
 * the $$id property to each server reference function, enabling the router to
 * identify which action was called during revalidation.
 *
 * Works in:
 * - Build mode: uses renderChunk to transform bundled chunks
 * - Dev mode: uses transform with enforce:"post" to transform after RSC plugin
 */
export function exposeActionId(): Plugin {
  let isBuild = false;

  return {
    name: "rsc-router:expose-action-id",
    // Run after all other plugins (including RSC plugin's transforms)
    enforce: "post",

    configResolved(config) {
      isBuild = config.command === "build";
    },

    // Dev mode only: transform hook runs after RSC plugin creates server references
    // In build mode, we use renderChunk instead (more reliable, happens after bundling)
    transform(code, id) {
      // Skip in build mode - renderChunk handles it
      if (isBuild) {
        return;
      }

      // Quick bail-out: only process if code has createServerReference
      if (!code.includes("createServerReference(")) {
        return;
      }

      // Skip node_modules
      if (id.includes("/node_modules/")) {
        return;
      }

      return transformServerReferences(code, id);
    },

    // Build mode: renderChunk runs after all transforms and bundling complete
    renderChunk(code, chunk) {
      const result = transformServerReferences(code, chunk.fileName);
      if (result) {
        return { code: result.code, map: result.map };
      }
      return null;
    },
  };
}
