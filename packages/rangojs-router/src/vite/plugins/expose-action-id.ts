import type { Plugin, ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import fs from "node:fs";
import { normalizePath } from "./expose-id-utils.js";

/**
 * Type for the RSC plugin's manager API
 */
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

/**
 * Get the RSC plugin's API from Vite config
 */
function getRscPluginApi(config: ResolvedConfig): RscPluginApi | undefined {
  // Try by name first
  let plugin = config.plugins.find((p) => p.name === "rsc:minimal");

  // Fallback: find by API structure if name lookup fails
  if (!plugin) {
    plugin = config.plugins.find(
      (p) =>
        (p.api as RscPluginApi | undefined)?.manager?.serverReferenceMetaMap !==
        undefined,
    );
    if (plugin) {
      console.warn(
        `[rsc-router:expose-action-id] RSC plugin found by API structure (name: "${plugin.name}"). ` +
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
    // Remove leading comments and whitespace to find the first meaningful content
    const trimmed = content
      .replace(/^\s*\/\/[^\n]*\n/gm, "") // Remove single-line comments
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*/gm, "") // Remove multi-line comments
      .trimStart();

    // Check if the file starts with "use server" directive
    return (
      trimmed.startsWith('"use server"') || trimmed.startsWith("'use server'")
    );
  } catch {
    return false;
  }
}

/**
 * Transform code to expose action IDs on createServerReference calls.
 * Wraps each call with an IIFE that attaches $id to the returned function.
 *
 * @param code - The source code to transform
 * @param sourceId - The source file identifier (for sourcemap)
 * @param hashToFileMap - Optional mapping from hash to file path (for server bundles)
 */
/**
 * Apply createServerReference wrapping to a MagicString instance.
 * Returns true if any changes were made.
 */
function applyServerReferenceWrapping(
  code: string,
  s: MagicString,
  hashToFileMap?: Map<string, string>,
): boolean {
  if (!code.includes("createServerReference(")) {
    return false;
  }

  // Match: createServerReference("hash#actionName", ...) or $$ReactClient.createServerReference(...)
  // The RSC plugin uses $$ReactClient namespace in transformed code.
  // Note: [^)]* cannot handle nested parens in trailing args. This is safe in practice
  // because the RSC plugin always generates simple variable references (e.g., callServer)
  // as the second argument, never nested function calls.
  const pattern =
    /((?:\$\$\w+\.)?createServerReference)\(("[^"]+#[^"]+")([^)]*)\)/g;

  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    hasChanges = true;
    const [fullMatch, fnCall, idArg, rest] = match;
    const start = match.index;
    const end = start + fullMatch.length;

    // Parse the ID to potentially replace hash with file path
    let finalIdArg = idArg;
    if (hashToFileMap) {
      // idArg is like '"hash#actionName"', extract the parts
      const idValue = idArg.slice(1, -1); // Remove quotes
      const hashMatch = idValue.match(/^([^#]+)#(.+)$/);
      if (hashMatch) {
        const [, hash, actionName] = hashMatch;
        const filePath = hashToFileMap.get(hash);
        if (filePath) {
          // Replace hash with file path for server-side
          finalIdArg = `"${filePath}#${actionName}"`;
        }
      }
    }

    // Wrap the createServerReference call to attach $$id to the returned function
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

/**
 * Transform registerServerReference calls in server bundles to use file paths instead of hashes.
 * Pattern: registerServerReference(fn, "hash", "exportName")
 * React's registerServerReference sets $$id = hash + "#" + exportName
 * By replacing the hash with file path, $$id will contain the file path for revalidation matching.
 *
 * Only actions from module-level "use server" files are transformed.
 * Inline actions (defined in RSC components with "use server" inside a function) are NOT in
 * hashToFileMap and keep their hashed IDs. This is intentional for client security:
 * - Module-level "use server" files: shared action modules, file path helps revalidation
 * - Inline actions: one-off actions in RSC, hash ID prevents file path exposure to client
 *
 * @param code - The source code to transform
 * @param sourceId - The source file identifier (for sourcemap)
 * @param hashToFileMap - Mapping from hash to file path (only module-level "use server" files)
 */
/**
 * Apply registerServerReference wrapping to a MagicString instance.
 * Returns true if any changes were made.
 *
 * Only actions from module-level "use server" files are transformed.
 * Inline actions keep their hashed IDs for client security.
 */
function applyRegisterReferenceWrapping(
  code: string,
  s: MagicString,
  hashToFileMap: Map<string, string>,
): boolean {
  if (!code.includes("registerServerReference(")) {
    return false;
  }

  // Match: registerServerReference(fn, "hash", "exportName")
  // The hash is the second argument, exportName is the third
  const pattern =
    /registerServerReference\(([^,]+),\s*"([^"]+)",\s*"([^"]+)"\)/g;

  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const [fullMatch, fnArg, hash, exportName] = match;
    const start = match.index;
    const end = start + fullMatch.length;

    // Look up the file path for this hash
    const filePath = hashToFileMap.get(hash);
    if (filePath) {
      hasChanges = true;
      // WRAP the call to add $id property with file path
      // Keep the original hash for React's action registry (so loadServerAction works)
      // Add $id (single dollar) with file path for revalidation matching
      // Note: We use $id instead of $$id because React's registerServerReference
      // sets $$id as a non-writable property
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

    buildStart() {
      // Verify RSC plugin is present at build start (after all config hooks have run)
      // This allows rsc-router:rsc-integration to dynamically add the RSC plugin
      if (!rscPluginApi) {
        rscPluginApi = getRscPluginApi(config);
      }

      if (!rscPluginApi) {
        throw new Error(
          "[rsc-router] Could not find @vitejs/plugin-rsc. " +
            "@rangojs/router requires the Vite RSC plugin.\n" +
            "The RSC plugin should be included automatically. If you disabled it with\n" +
            "rango({ rsc: false }), add rsc() before rango() in your config.",
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

      // Dev mode: no hash-to-file mapping needed (IDs are already file paths)
      return transformServerReferences(code, id);
    },

    // Build mode: renderChunk runs after all transforms and bundling complete
    renderChunk(code, chunk) {
      // Only RSC bundle should get file paths for revalidation matching
      // SSR bundle must NOT use file paths because client components run there
      // and need to match the client bundle during hydration (otherwise: error #418)
      const isRscEnv = this.environment?.name === "rsc";

      // Only use file path mapping for RSC environment
      const effectiveMap = isRscEnv ? hashToFileMap : undefined;

      // For RSC bundles, both createServerReference and registerServerReference
      // may need transforming. Use a single MagicString for correct sourcemaps.
      if (isRscEnv && hashToFileMap) {
        const s = new MagicString(code);
        const changed1 = applyServerReferenceWrapping(code, s, effectiveMap);
        const changed2 = applyRegisterReferenceWrapping(code, s, hashToFileMap);
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

      // Non-RSC environments: only transform createServerReference calls
      return transformServerReferences(code, chunk.fileName, effectiveMap);
    },
  };
}
