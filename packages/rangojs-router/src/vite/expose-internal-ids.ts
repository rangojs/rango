import type { Plugin, ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  normalizePath,
  hashId,
  detectImports,
  makeExportPattern,
  findMatchingParen,
  countArgs,
  findStatementEnd,
  findClosingParen,
  countArgsSimple,
} from "./expose-id-utils.ts";

// ---------------------------------------------------------------------------
// Virtual module for loader manifest
// ---------------------------------------------------------------------------

const VIRTUAL_LOADER_MANIFEST = "virtual:rsc-router/loader-manifest";
const RESOLVED_VIRTUAL_LOADER_MANIFEST = "\0" + VIRTUAL_LOADER_MANIFEST;

// ---------------------------------------------------------------------------
// Plugin API type (consumed by router-discovery in index.ts)
// ---------------------------------------------------------------------------

export interface ExposeInternalIdsApi {
  /** Tracks absolute module IDs that contain prerender handler exports.
   *  key: absolute module ID (filesystem path)
   *  value: array of export names (e.g., ["ArticlesIndex", "ArticleDetail"]) */
  prerenderHandlerModules: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Loader helpers
// ---------------------------------------------------------------------------

function hasCreateLoaderImport(code: string): boolean {
  return /import\s*\{[^}]*\bcreateLoader\b[^}]*\}\s*from\s*["']@rangojs\/router(?:\/server)?["']/.test(
    code,
  );
}

/**
 * Generate lightweight client stubs for loader files.
 *
 * When a loader file is imported from a client component (e.g., for useLoader()),
 * the client only needs { __brand: "loader", $$id: "..." } objects.
 * This function replaces the entire file contents with just those stub exports,
 * preventing server-only data (constants, DB queries, etc.) from leaking into
 * the client bundle.
 *
 * Only applies when ALL named exports are createLoader() calls (plus type exports
 * which are erased at compile time). Files with mixed exports are left untouched.
 */
function generateClientLoaderStubs(
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map?: undefined } | null {
  const loaderPattern = /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;
  const loaders: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = loaderPattern.exec(code)) !== null) {
    loaders.push(match[1]);
  }

  if (loaders.length === 0) return null;

  // Check that every non-type export is a createLoader call.
  const allExports =
    /export\s+(const|let|var|function|class|default)\s+(\w+)/g;
  let exportMatch: RegExpExecArray | null;

  while ((exportMatch = allExports.exec(code)) !== null) {
    if (!loaders.includes(exportMatch[2])) return null;
  }

  const stubs = loaders.map((name) => {
    const loaderId = isBuild
      ? hashId(filePath, name)
      : `${filePath}#${name}`;
    return `export const ${name} = { __brand: "loader", $$id: "${loaderId}" };`;
  });

  return { code: stubs.join("\n") + "\n" };
}

function transformLoaders(
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = makeExportPattern("createLoader");
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Find the end of the createLoader(...) call (simple depth counter)
    const afterClose = findClosingParen(code, matchEnd);
    const closeParenPos = afterClose - 1;

    const argCount = countArgsSimple(code, matchEnd, closeParenPos);
    const statementEnd = findStatementEnd(code, afterClose);

    const loaderId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Inject $$id as hidden third parameter.
    // createLoader(fn) -> createLoader(fn, undefined, "id")
    // createLoader(fn, true) -> createLoader(fn, true, "id")
    const paramInjection =
      argCount === 1
        ? `, undefined, "${loaderId}"`
        : `, "${loaderId}"`;
    s.appendLeft(closeParenPos, paramInjection);

    const propInjection = `\n${exportName}.$$id = "${loaderId}";`;
    s.appendRight(statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

// ---------------------------------------------------------------------------
// Handle helpers
// ---------------------------------------------------------------------------

function analyzeCreateHandleArgs(
  code: string,
  startPos: number,
  endPos: number,
): { hasArgs: boolean } {
  const content = code.slice(startPos, endPos).trim();
  return { hasArgs: content.length > 0 };
}

function transformHandles(
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = makeExportPattern("createHandle");
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Simple depth-counter paren matching (original behavior)
    const afterClose = findClosingParen(code, matchEnd);
    const closeParenPos = afterClose - 1;

    const args = analyzeCreateHandleArgs(code, matchEnd, closeParenPos);
    const statementEnd = findStatementEnd(code, afterClose);

    const handleId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    let paramInjection: string;
    if (!args.hasArgs) {
      paramInjection = `undefined, "${handleId}"`;
    } else {
      paramInjection = `, "${handleId}"`;
    }
    s.appendLeft(closeParenPos, paramInjection);

    const propInjection = `\n${exportName}.$$id = "${handleId}";`;
    s.appendRight(statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

// ---------------------------------------------------------------------------
// LocationState helpers
// ---------------------------------------------------------------------------

function transformLocationState(
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = makeExportPattern("createLocationState");
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Simple depth-counter paren matching
    const afterClose = findClosingParen(code, matchEnd);
    const closeParenPos = afterClose - 1;

    const content = code.slice(matchEnd, closeParenPos).trim();
    const hasArgs = content.length > 0;

    if (hasArgs) continue; // Already has a key, skip

    const statementEnd = findStatementEnd(code, afterClose);

    const stateKey = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    s.appendLeft(closeParenPos, `"${stateKey}"`);

    const propInjection = `\n${exportName}.__rsc_ls_key = "__rsc_ls_${stateKey}";`;
    s.appendRight(statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

// ---------------------------------------------------------------------------
// PrerenderHandler helpers
// ---------------------------------------------------------------------------

/**
 * Replace the entire file with lightweight stubs when ALL non-type exports are
 * createPrerenderHandler calls. Returns null for files with mixed exports.
 */
function generateWholeFileHandlerStubs(
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map: null } | null {
  const handlerPattern = makeExportPattern("createPrerenderHandler");
  const handlers: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = handlerPattern.exec(code)) !== null) {
    handlers.push(match[1]);
  }

  if (handlers.length === 0) return null;

  // Bail out if the file has re-exports or destructured exports
  if (/export\s*\{/.test(code) || /export\s*\*/.test(code)) return null;

  const allExports =
    /export\s+(const|let|var|function|class|default)\s+(\w+)/g;
  let exportMatch: RegExpExecArray | null;

  while ((exportMatch = allExports.exec(code)) !== null) {
    if (!handlers.includes(exportMatch[2])) return null;
  }

  const stubs = handlers.map((name) => {
    const handlerId = isBuild
      ? hashId(filePath, name)
      : `${filePath}#${name}`;
    return `export const ${name} = { __brand: "prerenderHandler", $$id: "${handlerId}" };`;
  });

  return { code: stubs.join("\n") + "\n", map: null };
}

/**
 * Replace createPrerenderHandler(...) call expressions with lightweight stub objects
 * in non-RSC environments. Other exports, imports, and module-level code remain
 * untouched.
 */
function generatePrerenderHandlerStubs(
  code: string,
  filePath: string,
  sourceId: string,
  isBuild: boolean,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const pattern =
    /export\s+const\s+(\w+)\s*=\s*(createPrerenderHandler\s*(?:<[^>]*>)?\s*\()/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const callStart = match.index + match[0].length - match[2].length;
    const openParenPos = match.index + match[0].length;
    const afterCloseParen = findMatchingParen(code, openParenPos);

    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    s.overwrite(
      callStart,
      afterCloseParen,
      `{ __brand: "prerenderHandler", $$id: "${handlerId}" }`,
    );
    hasChanges = true;
  }

  if (!hasChanges) return null;

  return {
    code: s.toString(),
    map: s.generateMap({
      source: sourceId,
      includeContent: true,
      hires: "boundary",
    }),
  };
}

function transformPrerenderHandlers(
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = makeExportPattern("createPrerenderHandler");
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // String/comment-aware paren matching (preserves original behavior)
    const afterClose = findMatchingParen(code, matchEnd);
    const closeParenPos = afterClose - 1;
    const argCount = countArgs(code, matchEnd, closeParenPos);
    const statementEnd = findStatementEnd(code, afterClose);

    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Injection strategy matches the runtime overload signatures:
    //   1 arg  (handler)                 -> inject undefined, "id"
    //   2 args (getParams+handler OR handler+options) -> inject , "id"
    //   3 args (getParams+handler+options)            -> inject , "id"
    let paramInjection: string;
    if (argCount === 0) {
      paramInjection = `undefined, "${handlerId}"`;
    } else if (argCount === 1) {
      paramInjection = `, undefined, "${handlerId}"`;
    } else {
      paramInjection = `, "${handlerId}"`;
    }
    s.appendLeft(closeParenPos, paramInjection);

    const propInjection = `\n${exportName}.$$id = "${handlerId}";`;
    s.appendRight(statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

// ---------------------------------------------------------------------------
// Router helpers
// ---------------------------------------------------------------------------

function transformRouter(
  code: string,
  filePath: string,
): { code: string; map: null } | null {
  const pattern = /\bcreateRouter\s*(?:<[^>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  let result = code;
  let offset = 0;

  while ((match = pattern.exec(code)) !== null) {
    const callStart = match.index;
    const parenPos = match.index + match[0].length - 1;

    const afterParen = code.slice(parenPos + 1).trimStart();

    // Skip if $$id is already present
    if (afterParen.includes("$$id")) continue;

    // Compute line number for this call
    const lineNumber = code.slice(0, callStart).split("\n").length;
    const hash = createHash("sha256")
      .update(`${filePath}:${lineNumber}`)
      .digest("hex")
      .slice(0, 8);

    if (afterParen.startsWith("{")) {
      // createRouter({ ... }) -> createRouter({ $$id: "hash", ... })
      const bracePos = code.indexOf("{", parenPos + 1);
      const insertPos = bracePos + 1 + offset;
      result =
        result.slice(0, insertPos) +
        ` $$id: "${hash}",` +
        result.slice(insertPos);
      offset += ` $$id: "${hash}",`.length;
    } else if (afterParen.startsWith(")")) {
      // createRouter() -> createRouter({ $$id: "hash" })
      const insertPos = parenPos + 1 + offset;
      result =
        result.slice(0, insertPos) +
        `{ $$id: "${hash}" }` +
        result.slice(insertPos);
      offset += `{ $$id: "${hash}" }`.length;
    }
  }

  if (result === code) return null;
  return { code: result, map: null };
}

// ---------------------------------------------------------------------------
// Router ID plugin (separate: must run at normal priority, NOT "post")
// ---------------------------------------------------------------------------

/**
 * Inject stable $$id into createRouter() calls at compile time.
 * This must be a separate plugin without enforce:"post" because running
 * at "post" priority changes Vite's dep optimization timing and can cause
 * ERR_OUTDATED_OPTIMIZED_DEP / React dual-instance issues.
 */
export function exposeRouterId(): Plugin {
  let projectRoot = "";
  return {
    name: "@rangojs/router:expose-router-id",
    configResolved(config) {
      projectRoot = config.root;
    },
    transform(code, id) {
      if (!code.includes("createRouter")) return null;
      if (
        !/import\s*\{[^}]*\bcreateRouter\b[^}]*\}\s*from\s*["']@rangojs\/router["']/.test(
          code,
        )
      ) {
        return null;
      }
      if (id.includes("node_modules")) return null;

      const filePath = normalizePath(path.relative(projectRoot, id));
      return transformRouter(code, filePath);
    },
  };
}

// ---------------------------------------------------------------------------
// Consolidated plugin
// ---------------------------------------------------------------------------

export function exposeInternalIds(options?: {
  forceBuild?: boolean;
}): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;
  let projectRoot = "";

  // Loader registry: hashedId -> { filePath, exportName }
  const loaderRegistry = new Map<
    string,
    { filePath: string; exportName: string }
  >();

  // Prerender handler module tracking (consumed via plugin API)
  const prerenderHandlerModules: Map<string, string[]> = new Map();

  return {
    name: "@rangojs/router:expose-internal-ids",
    enforce: "post",

    api: {
      prerenderHandlerModules,
    } satisfies ExposeInternalIdsApi,

    configResolved(resolved) {
      config = resolved;
      isBuild = options?.forceBuild || config.command === "build";
      projectRoot = config.root;
    },

    // --------------- Loader virtual module support ---------------

    resolveId(id) {
      if (id === VIRTUAL_LOADER_MANIFEST) {
        return RESOLVED_VIRTUAL_LOADER_MANIFEST;
      }
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_LOADER_MANIFEST) return;

      if (!isBuild) {
        return `import { setLoaderImports } from "@rangojs/router/server";

// Dev mode: empty map, loaders are resolved dynamically via path parsing
setLoaderImports({});
`;
      }

      // Build mode: generate lazy import map
      const lazyImports: string[] = [];

      for (const [hashedId, { filePath, exportName }] of loaderRegistry) {
        lazyImports.push(
          `  "${hashedId}": () => import("/${filePath}").then(m => m.${exportName})`,
        );
      }

      if (lazyImports.length === 0) {
        return `import { setLoaderImports } from "@rangojs/router/server";

// No fetchable loaders discovered during build
setLoaderImports({});
`;
      }

      return `import { setLoaderImports } from "@rangojs/router/server";

// Lazy import map - loaders are loaded on-demand when first requested
setLoaderImports({
${lazyImports.join(",\n")}
});
`;
    },

    // --------------- Loader pre-scan (build mode) ---------------

    async buildStart() {
      if (!isBuild) return;

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
        const srcDir = path.join(projectRoot, "src");
        const files = await scanDir(srcDir);

        for (const filePath of files) {
          const content = await fs.readFile(filePath, "utf-8");

          if (!content.includes("createLoader")) continue;
          if (!hasCreateLoaderImport(content)) continue;

          const pattern =
            /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;
          const relativePath = normalizePath(
            path.relative(projectRoot, filePath),
          );
          let match: RegExpExecArray | null;

          while ((match = pattern.exec(content)) !== null) {
            const exportName = match[1];
            const hashedId = hashId(relativePath, exportName);
            loaderRegistry.set(hashedId, {
              filePath: relativePath,
              exportName,
            });
          }
        }
      } catch (error) {
        console.warn("[exposeInternalIds] Loader pre-scan failed:", error);
      }
    },

    // --------------- Unified transform ---------------

    transform(code, id) {
      if (id.includes("/node_modules/")) return;

      const filePath = normalizePath(path.relative(projectRoot, id));
      const isRscEnv = this.environment?.name === "rsc";

      // Detect all relevant imports in one pass
      const has = detectImports(code);

      // Quick bail-out: also check for raw create* identifiers for the
      // code.includes() guard that each original plugin had
      const hasLoaderCode = has.loader && code.includes("createLoader");
      const hasHandleCode = has.handle && code.includes("createHandle");
      const hasLocationStateCode =
        has.locationState && code.includes("createLocationState");
      const hasPrerenderHandlerCode =
        has.prerenderHandler && code.includes("createPrerenderHandler");
      if (
        !hasLoaderCode &&
        !hasHandleCode &&
        !hasLocationStateCode &&
        !hasPrerenderHandlerCode
      ) {
        return;
      }

      // --- Loader: track for manifest (RSC env only) ---
      if (hasLoaderCode && isRscEnv) {
        const pattern =
          /export\s+const\s+(\w+)\s*=\s*createLoader\s*\(/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(code)) !== null) {
          const exportName = match[1];
          const hashedId = hashId(filePath, exportName);
          loaderRegistry.set(hashedId, {
            filePath,
            exportName,
          });
        }
      }

      // --- Loader: client stubs for non-RSC environments ---
      if (hasLoaderCode && !isRscEnv) {
        const stubResult = generateClientLoaderStubs(code, filePath, isBuild);
        if (stubResult) return stubResult;
      }

      // --- PrerenderHandler: non-RSC stub replacement ---
      if (hasPrerenderHandlerCode && !isRscEnv) {
        // Try whole-file replacement first, fall back to per-expression
        const wholeFile = generateWholeFileHandlerStubs(
          code,
          filePath,
          isBuild,
        );
        if (wholeFile) return wholeFile;

        const exprStubs = generatePrerenderHandlerStubs(
          code,
          filePath,
          id,
          isBuild,
        );
        if (exprStubs) return exprStubs;
      }

      // --- PrerenderHandler: RSC build module tracking ---
      if (hasPrerenderHandlerCode && isRscEnv && isBuild) {
        const handlerPattern = makeExportPattern("createPrerenderHandler");
        const exportNames: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = handlerPattern.exec(code)) !== null) {
          exportNames.push(m[1]);
        }
        if (exportNames.length > 0) {
          prerenderHandlerModules.set(id, exportNames);
        }
      }

      // --- Unified MagicString transforms ---
      const s = new MagicString(code);
      let changed = false;

      if (hasLoaderCode) {
        changed = transformLoaders(s, code, filePath, isBuild) || changed;
      }
      if (hasHandleCode) {
        changed = transformHandles(s, code, filePath, isBuild) || changed;
      }
      if (hasLocationStateCode) {
        changed =
          transformLocationState(s, code, filePath, isBuild) || changed;
      }
      if (hasPrerenderHandlerCode && isRscEnv) {
        changed =
          transformPrerenderHandlers(s, code, filePath, isBuild) || changed;
      }

      if (!changed) return;

      return {
        code: s.toString(),
        map: s.generateMap({ source: id, includeContent: true }),
      };
    },
  };
}
