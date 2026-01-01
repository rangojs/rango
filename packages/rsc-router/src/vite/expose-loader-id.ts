import type { Plugin, ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path from "node:path";

/**
 * Normalize path to forward slashes
 */
function normalizePath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Check if file imports createLoader from rsc-router
 */
function hasCreateLoaderImport(code: string): boolean {
  // Match: import { createLoader } from "rsc-router" or "rsc-router/server"
  // Must be exact - no aliasing support
  const pattern =
    /import\s*\{[^}]*\bcreateLoader\b[^}]*\}\s*from\s*["']rsc-router(?:\/server)?["']/;
  return pattern.test(code);
}

/**
 * Find all export const X = createLoader(...) patterns and inject $$id
 * Optionally also inject registration calls (server-side only)
 */
function transformLoaderExports(
  code: string,
  filePath: string,
  sourceId?: string,
  options: { includeRegistration: boolean } = { includeRegistration: false }
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
  const loaderNames: string[] = [];

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

    // Find the semicolon or end of statement
    let statementEnd = i;
    while (statementEnd < code.length && /\s/.test(code[statementEnd])) {
      statementEnd++;
    }
    if (code[statementEnd] === ";") {
      statementEnd++;
    }

    // Build the $$id value
    const loaderId = `${filePath}#${exportName}`;

    // Inject $$id assignment after the statement
    const injection = `\n${exportName}.$$id = "${loaderId}";`;
    s.appendRight(statementEnd, injection);
    hasChanges = true;
    loaderNames.push(exportName);
  }

  if (!hasChanges) {
    return null;
  }

  // Add registration import and calls (server-side only)
  // This ensures loaders are registered when the module is imported on the server
  if (options.includeRegistration) {
    const registrations = loaderNames
      .map((name) => `__registerLoaderById(${name});`)
      .join("\n");
    s.append(
      `\nimport { registerLoaderById as __registerLoaderById } from "rsc-router/server";\n${registrations}\n`
    );
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
 * - Must use direct import: import { createLoader } from "rsc-router"
 * - No aliasing support (import { createLoader as cl } won't work)
 * - Must use named export: export const MyLoader = createLoader(...)
 */
export function exposeLoaderId(): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;

  // Track discovered loaders: $$id -> { filePath, exportName }
  const loaderRegistry = new Map<
    string,
    { filePath: string; exportName: string }
  >();

  // For build mode: pre-scan for loaders during buildStart
  const pendingLoaderScans = new Map<string, Promise<void>>();

  return {
    name: "rsc-router:expose-loader-id",
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
            const loaderId = `${relativePath}#${exportName}`;
            loaderRegistry.set(loaderId, {
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
        // During dev/build, loaders are discovered during transform
        // In dev: return dynamic registration code that works at runtime
        // In build: this will be re-transformed after all modules are processed

        if (!isBuild) {
          // Dev mode: return a no-op, loaders are discovered and registered
          // via dynamic import fallback in RSC handler
          return `// Dev mode: loaders registered via dynamic import\nexport {};`;
        }

        // Build mode: generate manifest code with static imports and registration
        // This module has side effects - it registers all discovered loaders
        const imports: string[] = [];
        const registrations: string[] = [];

        let i = 0;
        for (const [loaderId, { filePath, exportName }] of loaderRegistry) {
          const importName = `_loader${i}`;
          imports.push(
            `import { ${exportName} as ${importName} } from "/${filePath}";`
          );
          registrations.push(`registerLoaderById(${importName});`);
          i++;
        }

        // If no loaders discovered, return placeholder
        if (imports.length === 0) {
          return `// No fetchable loaders discovered during build\nexport {};`;
        }

        const code = `import { registerLoaderById } from "rsc-router/server";
${imports.join("\n")}

// Register all loaders in the registry
${registrations.join("\n")}

export {};
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
          const loaderId = `${relativePath}#${exportName}`;
          loaderRegistry.set(loaderId, { filePath: relativePath, exportName });
        }
      }

      // Transform: inject $$id in all environments, registration only in RSC
      return transformLoaderExports(code, relativePath, id, {
        includeRegistration: isRscEnv,
      });
    },
  };
}
