import type { Plugin, ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Normalize path to forward slashes
 */
function normalizePath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Generate a short hash for a loader ID
 * Uses first 8 chars of SHA-256 hash for uniqueness while keeping IDs short
 * Appends export name for easier debugging in production: "abc123#CartLoader"
 */
function hashLoaderId(filePath: string, exportName: string): string {
  const input = `${filePath}#${exportName}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return `${hash.slice(0, 8)}#${exportName}`;
}

/**
 * Check if file imports createLoader from rsc-router
 */
function hasCreateLoaderImport(code: string): boolean {
  // Match: import { createLoader } from "@ivogt/rsc-router" or "@ivogt/rsc-router/server"
  // Must be exact - no aliasing support
  const pattern =
    /import\s*\{[^}]*\bcreateLoader\b[^}]*\}\s*from\s*["']@ivogt\/rsc-router(?:\/server)?["']/;
  return pattern.test(code);
}

/**
 * Count the number of arguments in a createLoader call
 * Returns the count of top-level arguments (not counting nested commas)
 */
function countCreateLoaderArgs(code: string, startPos: number, endPos: number): number {
  let depth = 0;
  let argCount = 0;
  let hasContent = false;

  for (let i = startPos; i < endPos; i++) {
    const char = code[i];

    // Track nested structures
    if (char === "(" || char === "[" || char === "{") {
      depth++;
      hasContent = true;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
    } else if (char === "," && depth === 0) {
      // Top-level comma means another argument
      argCount++;
    } else if (!/\s/.test(char)) {
      hasContent = true;
    }
  }

  // If there's content, we have at least one argument
  return hasContent ? argCount + 1 : 0;
}

/**
 * Find all export const X = createLoader(...) patterns and inject $$id
 * In production, IDs are hashed to avoid exposing file paths.
 * In dev, IDs use filePath#exportName for easier debugging.
 *
 * The ID is injected in two ways:
 * 1. As a hidden third parameter to createLoader() for registry registration
 * 2. As a property assignment X.$$id = "..." for external access
 *
 * IMPORTANT: The $$id must always be the THIRD parameter to createLoader.
 * createLoader(fn, fetchable?, __injectedId?)
 * If the user only provides fn, we inject: undefined, "id"
 * If the user provides fn and fetchable, we inject: , "id"
 */
function transformLoaderExports(
  code: string,
  filePath: string,
  sourceId?: string,
  isBuild: boolean = false
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Quick bail-out
  if (!code.includes("createLoader")) {
    return null;
  }

  // Must have direct import from rsc-router
  if (!hasCreateLoaderImport(code)) {
    return null;
  }

  // Match: export const X = createLoader(
  // Captures the export name (X)
  const pattern = /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Find the end of the createLoader(...) call
    // Need to count parentheses to find matching close
    let parenDepth = 1;
    let i = matchEnd;
    while (i < code.length && parenDepth > 0) {
      if (code[i] === "(") parenDepth++;
      if (code[i] === ")") parenDepth--;
      i++;
    }

    // i now points just after the closing )
    const closeParenPos = i - 1;

    // Count existing arguments
    const argCount = countCreateLoaderArgs(code, matchEnd, closeParenPos);

    // Find the semicolon or end of statement
    let statementEnd = i;
    while (statementEnd < code.length && /\s/.test(code[statementEnd])) {
      statementEnd++;
    }
    if (code[statementEnd] === ";") {
      statementEnd++;
    }

    // In production: hash ID to avoid exposing file paths
    // In dev: use readable format for easier debugging
    const loaderId = isBuild
      ? hashLoaderId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Inject $$id as hidden third parameter before the closing paren
    // If user only has 1 arg (fn), we need to add undefined for fetchable
    // createLoader(fn) -> createLoader(fn, undefined, "id")
    // createLoader(fn, true) -> createLoader(fn, true, "id")
    const paramInjection = argCount === 1
      ? `, undefined, "${loaderId}"`
      : `, "${loaderId}"`;
    s.appendLeft(closeParenPos, paramInjection);

    // Also set $$id property for external access (useLoader, useFetchLoader)
    const propInjection = `\n${exportName}.$$id = "${loaderId}";`;
    s.appendRight(statementEnd, propInjection);
    hasChanges = true;
  }

  if (!hasChanges) {
    return null;
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: sourceId, includeContent: true }),
  };
}

const VIRTUAL_LOADER_MANIFEST = "virtual:rsc-router/loader-manifest";
const RESOLVED_VIRTUAL_LOADER_MANIFEST = "\0" + VIRTUAL_LOADER_MANIFEST;

// Store for deferred manifest generation - populated during transform, used after build
let manifestGenerated = false;

/**
 * Vite plugin that exposes $$id on createLoader calls and generates a loader manifest.
 *
 * When users create loaders with createLoader(), this plugin:
 * 1. Injects a $$id property containing the file path and export name
 * 2. Tracks all loaders and generates a virtual manifest module
 *
 * The manifest can be imported by the RSC handler to get all loaders.
 *
 * Requirements:
 * - Must use direct import: import { createLoader } from "@ivogt/rsc-router"
 * - No aliasing support (import { createLoader as cl } won't work)
 * - Must use named export: export const MyLoader = createLoader(...)
 */
export function exposeLoaderId(): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;

  // Track discovered loaders: hashedId -> { filePath, exportName }
  const loaderRegistry = new Map<
    string,
    { filePath: string; exportName: string }
  >();

  // For build mode: pre-scan for loaders during buildStart
  const pendingLoaderScans = new Map<string, Promise<void>>();

  return {
    name: "@ivogt/rsc-router:expose-loader-id",
    enforce: "post",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      isBuild = config.command === "build";
    },

    async buildStart() {
      if (!isBuild) return;

      // Pre-scan for loader files to populate registry before manifest is loaded
      // This runs before module resolution, so manifest will have access to all loaders
      const fs = await import("node:fs/promises");

      async function scanDir(dir: string): Promise<string[]> {
        const results: string[] = [];
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name !== "node_modules") {
                results.push(...(await scanDir(fullPath)));
              }
            } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
              results.push(fullPath);
            }
          }
        } catch {
          // Directory doesn't exist or not readable
        }
        return results;
      }

      try {
        const srcDir = path.join(config.root, "src");
        const files = await scanDir(srcDir);

        for (const filePath of files) {
          const content = await fs.readFile(filePath, "utf-8");

          // Quick check for createLoader
          if (!content.includes("createLoader")) continue;
          if (!hasCreateLoaderImport(content)) continue;

          // Extract loader exports
          const pattern = /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;
          const relativePath = normalizePath(
            path.relative(config.root, filePath)
          );
          let match: RegExpExecArray | null;

          while ((match = pattern.exec(content)) !== null) {
            const exportName = match[1];
            const hashedId = hashLoaderId(relativePath, exportName);
            loaderRegistry.set(hashedId, {
              filePath: relativePath,
              exportName,
            });
          }
        }
      } catch (error) {
        // Fall back to transform-time discovery
        console.warn("[exposeLoaderId] Pre-scan failed:", error);
      }
    },

    resolveId(id) {
      if (id === VIRTUAL_LOADER_MANIFEST) {
        return RESOLVED_VIRTUAL_LOADER_MANIFEST;
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_LOADER_MANIFEST) {
        // Generate a lazy import map for on-demand loader loading
        // This avoids importing all loader modules at startup

        if (!isBuild) {
          // Dev mode: empty map - use fallback path parsing in loader registry
          // IDs in dev mode are "filePath#exportName" format for easier debugging
          return `import { setLoaderImports } from "@ivogt/rsc-router/server";

// Dev mode: empty map, loaders are resolved dynamically via path parsing
setLoaderImports({});
`;
        }

        // Build mode: generate lazy import map
        // Each loader is only imported when first requested
        // Keys are hashed IDs to avoid exposing file paths
        const lazyImports: string[] = [];

        for (const [hashedId, { filePath, exportName }] of loaderRegistry) {
          // Create a lazy import function for each loader
          lazyImports.push(
            `  "${hashedId}": () => import("/${filePath}").then(m => m.${exportName})`
          );
        }

        // If no loaders discovered, set empty map
        if (lazyImports.length === 0) {
          return `import { setLoaderImports } from "@ivogt/rsc-router/server";

// No fetchable loaders discovered during build
setLoaderImports({});
`;
        }

        const code = `import { setLoaderImports } from "@ivogt/rsc-router/server";

// Lazy import map - loaders are loaded on-demand when first requested
setLoaderImports({
${lazyImports.join(",\n")}
});
`;
        return code;
      }
    },

    transform(code, id) {
      // Skip node_modules
      if (id.includes("/node_modules/")) {
        return;
      }

      // Quick bail-out
      if (!code.includes("createLoader")) {
        return;
      }

      // Must have direct import from rsc-router
      if (!hasCreateLoaderImport(code)) {
        return;
      }

      // Check if we're in RSC environment (server-side)
      const envName = this.environment?.name;
      const isRscEnv = envName === "rsc";

      // Get relative path for the ID
      const relativePath = normalizePath(path.relative(config.root, id));

      // Track loaders for manifest (only in RSC env to avoid duplicate entries)
      if (isRscEnv) {
        const pattern = /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(code)) !== null) {
          const exportName = match[1];
          const hashedId = hashLoaderId(relativePath, exportName);
          loaderRegistry.set(hashedId, { filePath: relativePath, exportName });
        }
      }

      // Transform: inject $$id in all environments
      // In build mode, IDs are hashed; in dev mode, they're readable
      return transformLoaderExports(code, relativePath, id, isBuild);
    },
  };
}
