import type { Plugin, ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import fs from "node:fs";
import { normalizePath } from "./expose-id-utils.js";
import { createRangoDebugger, createCounter, NS } from "../debug.js";

const debug = createRangoDebugger(NS.transform);

interface RscPluginManager {
  serverReferenceMetaMap: Record<
    string,
    {
      importId: string;
      referenceKey: string;
      exportNames: string[];
    }
  >;
  config: ResolvedConfig;
}

interface RscPluginApi {
  manager: RscPluginManager;
}

function getRscPluginApi(config: ResolvedConfig): RscPluginApi | undefined {
  let plugin = config.plugins.find((p) => p.name === "rsc:minimal");

  if (!plugin) {
    plugin = config.plugins.find(
      (p) =>
        (p.api as RscPluginApi | undefined)?.manager?.serverReferenceMetaMap !==
        undefined,
    );
    if (plugin) {
      console.warn(
        `[rango:expose-action-id] RSC plugin found by API structure (name: "${plugin.name}"). ` +
          `Consider updating the name lookup if the plugin was renamed.`,
      );
    }
  }

  return plugin?.api as RscPluginApi | undefined;
}

/**
 * Check if a file is a "use server" module (has the directive at the module level).
 * This distinguishes module-level server action files from files with inline actions.
 *
 * Module-level "use server" files should have their hash replaced with file paths
 * for revalidation matching. Inline actions (defined in RSC components) should
 * keep their hashed IDs for client security.
 */
function isUseServerModule(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const trimmed = content
      .replace(/^\s*\/\/[^\n]*\n/gm, "")
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/gm, "")
      .trimStart();

    return (
      trimmed.startsWith('"use server"') || trimmed.startsWith("'use server'")
    );
  } catch {
    return false;
  }
}

function applyServerReferenceWrapping(
  code: string,
  s: MagicString,
  hashToFileMap?: Map<string, string>,
): boolean {
  if (!code.includes("createServerReference(")) {
    return false;
  }

  const pattern =
    /((?:\$\$\w+\.)?createServerReference)\(("[^"]+#[^"]+")([^)]*)\)/g;

  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    hasChanges = true;
    const [fullMatch, fnCall, idArg, rest] = match;
    const start = match.index;
    const end = start + fullMatch.length;

    let finalIdArg = idArg;
    if (hashToFileMap) {
      const idValue = idArg.slice(1, -1); // Remove quotes
      const hashMatch = idValue.match(/^([^#]+)#(.+)$/);
      if (hashMatch) {
        const [, hash, actionName] = hashMatch;
        const filePath = hashToFileMap.get(hash);
        if (filePath) {
          finalIdArg = `"${filePath}#${actionName}"`;
        }
      }
    }

    const replacement = `(function(fn) { fn.$$id = ${finalIdArg}; return fn; })(${fnCall}(${idArg}${rest}))`;
    s.overwrite(start, end, replacement);
  }

  return hasChanges;
}

function transformServerReferences(
  code: string,
  sourceId?: string,
  hashToFileMap?: Map<string, string>,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const s = new MagicString(code);
  if (!applyServerReferenceWrapping(code, s, hashToFileMap)) {
    return null;
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: sourceId, includeContent: true }),
  };
}

function applyRegisterReferenceWrapping(
  code: string,
  s: MagicString,
  hashToFileMap: Map<string, string>,
): boolean {
  if (!code.includes("registerServerReference(")) {
    return false;
  }

  const pattern =
    /registerServerReference\(([^,]+),\s*"([^"]+)",\s*"([^"]+)"\)/g;

  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const [fullMatch, fnArg, hash, exportName] = match;
    const start = match.index;
    const end = start + fullMatch.length;

    const filePath = hashToFileMap.get(hash);
    if (filePath) {
      hasChanges = true;
      const filePathId = `${filePath}#${exportName}`;
      const replacement = `(function(fn) { fn.$id = "${filePathId}"; return fn; })(registerServerReference(${fnArg}, "${hash}", "${exportName}"))`;
      s.overwrite(start, end, replacement);
    }
  }

  return hasChanges;
}

function transformRegisterServerReference(
  code: string,
  sourceId?: string,
  hashToFileMap?: Map<string, string>,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (!hashToFileMap) return null;

  const s = new MagicString(code);
  if (!applyRegisterReferenceWrapping(code, s, hashToFileMap)) {
    return null;
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: sourceId, includeContent: true }),
  };
}

/**
 * Vite plugin that exposes action IDs on server reference functions.
 *
 * When React Server Components creates server references via createServerReference(),
 * the action ID (format: "hash#actionName") is passed as the first argument but not
 * exposed on the returned function. This plugin transforms the output to attach
 * the $id property to each server reference function, enabling the router to
 * identify which action was called during revalidation.
 *
 * Server bundles (RSC/SSR) get file paths in $id for filtering (e.g., "src/actions.ts#add").
 * Client bundles keep hashed IDs for security (e.g., "ec387bc704d4#add").
 *
 * Works in:
 * - Build mode: uses renderChunk to transform bundled chunks
 * - Dev mode: uses transform with enforce:"post" to transform after RSC plugin
 */
export function exposeActionId(): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;
  let hashToFileMap: Map<string, string> | undefined;
  let rscPluginApi: RscPluginApi | undefined;
  const counterTransform = createCounter(debug, "expose-action-id transform");
  const counterRender = createCounter(debug, "expose-action-id renderChunk");

  return {
    name: "@rangojs/router:expose-action-id",
    // Run after all other plugins (including RSC plugin's transforms)
    enforce: "post",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      isBuild = config.command === "build";

      // Get RSC plugin API - rsc-router requires @vitejs/plugin-rsc
      rscPluginApi = getRscPluginApi(config);
    },

    buildEnd() {
      counterTransform?.flush();
      counterRender?.flush();
    },

    buildStart() {
      // Verify RSC plugin is present at build start (after all config hooks have run)
      // This allows rsc-router:rsc-integration to dynamically add the RSC plugin
      if (!rscPluginApi) {
        rscPluginApi = getRscPluginApi(config);
      }

      if (!rscPluginApi) {
        throw new Error(
          "[rango] Could not find @vitejs/plugin-rsc. " +
            "@rangojs/router requires the Vite RSC plugin, which is included automatically by rango().",
        );
      }

      if (!isBuild) return;

      hashToFileMap = new Map();
      const { serverReferenceMetaMap } = rscPluginApi.manager;

      for (const [absolutePath, meta] of Object.entries(
        serverReferenceMetaMap,
      )) {
        // Only include module-level "use server" files
        // Inline actions (defined in RSC components) should keep hashed IDs for client security
        if (!isUseServerModule(absolutePath)) {
          continue;
        }

        const relativePath = normalizePath(
          path.relative(config.root, absolutePath),
        );

        // The referenceKey in build mode is the hash
        // Map hash -> relative file path
        hashToFileMap.set(meta.referenceKey, relativePath);
      }
    },

    // Dev mode only: transform hook runs after RSC plugin creates server references
    // In dev mode, IDs already contain file paths, not hashes
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

      const start = counterTransform ? performance.now() : 0;
      try {
        return transformServerReferences(code, id);
      } finally {
        counterTransform?.record(id, performance.now() - start);
      }
    },

    renderChunk(code, chunk) {
      const start = counterRender ? performance.now() : 0;
      try {
        const isRscEnv = this.environment?.name === "rsc";

        const effectiveMap = isRscEnv ? hashToFileMap : undefined;

        if (isRscEnv && hashToFileMap) {
          const s = new MagicString(code);
          const changed1 = applyServerReferenceWrapping(code, s, effectiveMap);
          const changed2 = applyRegisterReferenceWrapping(
            code,
            s,
            hashToFileMap,
          );
          if (changed1 || changed2) {
            return {
              code: s.toString(),
              map: s.generateMap({
                source: chunk.fileName,
                includeContent: true,
              }),
            };
          }
          return null;
        }

        return transformServerReferences(code, chunk.fileName, effectiveMap);
      } finally {
        counterRender?.record(chunk.fileName, performance.now() - start);
      }
    },
  };
}
