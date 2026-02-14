import type { Plugin, ResolvedConfig } from "vite";
import { parseAst } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  normalizePath,
  hashId,
  detectImports,
  findMatchingParen,
  countArgs,
  findStatementEnd,
  findClosingParen,
  countArgsSimple,
} from "./expose-id-utils.ts";
import {
  transformInlineHandlers,
  type VirtualHandlerEntry,
} from "./ast-handler-extract.ts";

// ---------------------------------------------------------------------------
// Virtual module for loader manifest
// ---------------------------------------------------------------------------

const VIRTUAL_LOADER_MANIFEST = "virtual:rsc-router/loader-manifest";
const RESOLVED_VIRTUAL_LOADER_MANIFEST = "\0" + VIRTUAL_LOADER_MANIFEST;

// ---------------------------------------------------------------------------
// Virtual module prefix for extracted inline handlers
// ---------------------------------------------------------------------------

const VIRTUAL_HANDLER_PREFIX = "virtual:handler-extract:";

// ---------------------------------------------------------------------------
// Handler transform config
// ---------------------------------------------------------------------------

interface HandlerTransformConfig {
  fnName: string;
  brand: string;
}

interface StrictCreateTransformConfig {
  fnName: "createLoader" | "createHandle" | "createLocationState";
}

const PRERENDER_CONFIG: HandlerTransformConfig = {
  fnName: "createPrerenderHandler",
  brand: "prerenderHandler",
};

const STATIC_CONFIG: HandlerTransformConfig = {
  fnName: "createStaticHandler",
  brand: "staticHandler",
};

const STRICT_CREATE_CONFIGS: StrictCreateTransformConfig[] = [
  { fnName: "createLoader" },
  { fnName: "createHandle" },
  { fnName: "createLocationState" },
];

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExportPattern(fnNames: string[]): RegExp {
  const alternation = fnNames.map(escapeRegExp).join("|");
  return new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(?:${alternation})\\s*(?:<[^>]*>)?\\s*\\(`,
    "g",
  );
}

function countCreateCallsForNames(code: string, fnNames: string[]): number {
  const pattern = new RegExp(
    `\\b(?:${fnNames.map(escapeRegExp).join("|")})\\s*(?:<[^>]*>\\s*)?\\(`,
    "g",
  );
  return (code.match(pattern) || []).length;
}

function countExportConstCallsForNames(code: string, fnNames: string[]): number {
  return (code.match(buildExportPattern(fnNames)) || []).length;
}

function getImportedFnNames(
  code: string,
  importedName: string,
): string[] {
  const importPattern =
    /import\s*\{([^}]*)\}\s*from\s*["']@rangojs\/router(?:\/[^"']*)?["']/g;

  const localNames = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(code)) !== null) {
    const specList = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const spec of specList) {
      const m = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) continue;
      const imported = m[1];
      const local = m[2] || imported;
      if (imported === importedName) {
        localNames.add(local);
      }
    }
  }

  const names = Array.from(localNames);
  return names.length > 0 ? names : [importedName];
}

function buildUnsupportedShapeWarning(filePath: string, fnName: string): string {
  return [
    `[rsc-router] Unsupported ${fnName} shape in "${filePath}".`,
    `Only "export const X = ${fnName}(...)" is transformed for stable IDs.`,
    `Potentially unsupported forms include:`,
    `  - const X = ${fnName}(...); export { X }`,
    `  - export let/var X = ${fnName}(...)`,
    `  - inline ${fnName}(...) calls`,
    `See: packages/rangojs-router/src/vite/TRANSFORM-SUPPORT.md`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plugin API type (consumed by router-discovery in index.ts)
// ---------------------------------------------------------------------------

export interface ExposeInternalIdsApi {
  /** Tracks absolute module IDs that contain prerender handler exports.
   *  key: absolute module ID (filesystem path)
   *  value: array of export names (e.g., ["ArticlesIndex", "ArticleDetail"]) */
  prerenderHandlerModules: Map<string, string[]>;
  /** Tracks absolute module IDs that contain static handler exports.
   *  key: absolute module ID (filesystem path)
   *  value: array of export names (e.g., ["DocsNav", "DocShell"]) */
  staticHandlerModules: Map<string, string[]>;
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
  fnNames: string[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map?: undefined } | null {
  const loaderPattern = buildExportPattern(fnNames);
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
  fnNames: string[],
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = buildExportPattern(fnNames);
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
  fnNames: string[],
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = buildExportPattern(fnNames);
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
  fnNames: string[],
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = buildExportPattern(fnNames);
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
// Parameterized handler helpers (prerender + static)
// ---------------------------------------------------------------------------

/**
 * Replace the entire file with lightweight stubs when ALL non-type exports are
 * handler calls of the given type. Returns null for files with mixed exports.
 */
function generateWholeFileStubs(
  cfg: HandlerTransformConfig,
  fnNames: string[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map: null } | null {
  const handlerPattern = buildExportPattern(fnNames);
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
    return `export const ${name} = { __brand: "${cfg.brand}", $$id: "${handlerId}" };`;
  });

  return { code: stubs.join("\n") + "\n", map: null };
}

/**
 * Replace handler call expressions with lightweight stub objects in non-RSC
 * environments. Other exports, imports, and module-level code remain untouched.
 */
function generateExprStubs(
  cfg: HandlerTransformConfig,
  fnNames: string[],
  code: string,
  filePath: string,
  sourceId: string,
  isBuild: boolean,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const alternation = fnNames.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*((?:${alternation})\\s*(?:<[^>]*>)?\\s*\\()`,
    "g",
  );

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
      `{ __brand: "${cfg.brand}", $$id: "${handlerId}" }`,
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

/**
 * Inject $$id into export const handler calls in RSC environments.
 */
function transformHandlerIds(
  cfg: HandlerTransformConfig,
  fnNames: string[],
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  const pattern = buildExportPattern(fnNames);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // String/comment-aware paren matching
    const afterClose = findMatchingParen(code, matchEnd);
    const closeParenPos = afterClose - 1;
    const argCount = countArgs(code, matchEnd, closeParenPos);
    const statementEnd = findStatementEnd(code, afterClose);

    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Injection strategy matches the runtime overload signatures:
    //   0 args                              -> inject undefined, "id"
    //   1 arg  (handler)                    -> inject , undefined, "id"
    //   2+ args                             -> inject , "id"
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
  routerFnNames: string[],
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const pat = new RegExp(
    `\\b(?:${routerFnNames.map(escapeRegExp).join("|")})\\s*(?:<[^>]*>)?\\s*\\(`,
    "g",
  );
  let match: RegExpExecArray | null;
  const s = new MagicString(code);
  let changed = false;

  // Compute the import path for the generated route names file.
  // filePath is relative to project root (e.g., "src/router.tsx")
  const basename = path.basename(filePath).replace(/\.(tsx?|jsx?)$/, "");
  const routeNamesImport = `./${basename}.named-routes.gen.js`;
  const routeNamesVar = `__rsc_rn`;

  while ((match = pat.exec(code)) !== null) {
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

    changed = true;
    const injected = ` $$id: "${hash}", $$routeNames: ${routeNamesVar},`;

    if (afterParen.startsWith("{")) {
      const bracePos = code.indexOf("{", parenPos + 1);
      s.appendRight(bracePos + 1, injected);
    } else if (afterParen.startsWith(")")) {
      s.appendRight(parenPos + 1, `{${injected} }`);
    }
  }

  if (!changed) return null;

  // Prepend the static import as the first line. MagicString tracks the
  // offset so all downstream source maps remain correct.
  s.prepend(`import { NamedRoutes as ${routeNamesVar} } from "${routeNamesImport}";\n`);

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
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
        !/import\s*\{[^}]*\bcreateRouter\b[^}]*\}\s*from\s*["']@rangojs\/router(?:\/server)?["']/.test(
          code,
        )
      ) {
        return null;
      }
      if (id.includes("node_modules")) return null;

      const filePath = normalizePath(path.relative(projectRoot, id));
      const routerFnNames = getImportedFnNames(code, "createRouter");
      return transformRouter(code, filePath, routerFnNames);
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

  // Static handler module tracking (consumed via plugin API)
  const staticHandlerModules: Map<string, string[]> = new Map();

  // Virtual module registry for inline handler extraction (both types)
  const virtualHandlers = new Map<string, VirtualHandlerEntry>();
  // De-duplicate unsupported shape warnings across repeated transforms.
  const unsupportedShapeWarnings = new Set<string>();

  return {
    name: "@rangojs/router:expose-internal-ids",
    enforce: "post",

    api: {
      prerenderHandlerModules,
      staticHandlerModules,
    } satisfies ExposeInternalIdsApi,

    configResolved(resolved) {
      config = resolved;
      isBuild = options?.forceBuild || config.command === "build";
      projectRoot = config.root;
    },

    // --------------- Virtual module support ---------------

    resolveId(id, importer) {
      if (id === VIRTUAL_LOADER_MANIFEST) {
        return RESOLVED_VIRTUAL_LOADER_MANIFEST;
      }
      if (id.startsWith(VIRTUAL_HANDLER_PREFIX)) {
        return "\0" + id;
      }
      // Resolve imports FROM virtual modules against the original file
      if (importer?.startsWith("\0" + VIRTUAL_HANDLER_PREFIX)) {
        const entry = virtualHandlers.get(importer);
        if (entry) {
          return this.resolve(id, entry.originalModuleId, { skipSelf: true });
        }
      }
    },

    load(id) {
      // Virtual handler modules (both prerender and static)
      if (id.startsWith("\0" + VIRTUAL_HANDLER_PREFIX)) {
        const entry = virtualHandlers.get(id);
        if (!entry) return null;
        return [
          ...entry.imports,
          `export const ${entry.exportName} = ${entry.handlerCode};`,
        ].join("\n") + "\n";
      }

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

          const fnNames = getImportedFnNames(content, "createLoader");
          const pattern = buildExportPattern(fnNames);
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

      // Warn if named-routes.gen is imported in a client component.
      // NamedRoutes is server-only data and would bloat the client bundle.
      if (id.includes(".named-routes.gen.") && !isRscEnv && this.environment?.name === "client") {
        this.warn(
          `\n` +
          `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n` +
          `!!                                                              !!\n` +
          `!!  WARNING: NamedRoutes imported in a CLIENT component!        !!\n` +
          `!!                                                              !!\n` +
          `!!  File: ${filePath.padEnd(53)}!!\n` +
          `!!                                                              !!\n` +
          `!!  NamedRoutes contains your entire route structure — every    !!\n` +
          `!!  route name and URL pattern in your application. Shipping    !!\n` +
          `!!  this to the browser exposes your full routing topology to   !!\n` +
          `!!  the client, which is a security concern (internal/admin     !!\n` +
          `!!  routes, API endpoints, hidden paths become visible).        !!\n` +
          `!!                                                              !!\n` +
          `!!  It also bloats the client bundle — this map contains all    !!\n` +
          `!!  named routes in your application.                           !!\n` +
          `!!                                                              !!\n` +
          `!!  Fix: remove the import or move it to a server component.    !!\n` +
          `!!                                                              !!\n` +
          `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`
        );
      }

      // Fast exit: if the file doesn't import from @rangojs/router at all,
      // skip all create* analysis and transforms.
      if (!code.includes("@rangojs/router")) return;

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
      const hasStaticHandlerCode =
        has.staticHandler && code.includes("createStaticHandler");
      if (
        !hasLoaderCode &&
        !hasHandleCode &&
        !hasLocationStateCode &&
        !hasPrerenderHandlerCode &&
        !hasStaticHandlerCode
      ) {
        return;
      }

      // Warn on create* declaration shapes that are currently unsupported by
      // non-AST transforms (loader/handle/locationState only).
      for (const cfg of STRICT_CREATE_CONFIGS) {
        const hasCode =
          cfg.fnName === "createLoader"
            ? hasLoaderCode
            : cfg.fnName === "createHandle"
            ? hasHandleCode
            : hasLocationStateCode;
        if (!hasCode) continue;

        const fnNames = getImportedFnNames(code, cfg.fnName);
        const totalCalls = countCreateCallsForNames(code, fnNames);
        const exportConstCalls = countExportConstCallsForNames(code, fnNames);
        if (totalCalls <= exportConstCalls) continue;

        const warnKey = `${id}::${cfg.fnName}`;
        if (unsupportedShapeWarnings.has(warnKey)) continue;
        unsupportedShapeWarnings.add(warnKey);
        this.warn(buildUnsupportedShapeWarning(filePath, cfg.fnName));
      }

      // --- Loader: track for manifest (RSC env only) ---
      if (hasLoaderCode && isRscEnv) {
        const fnNames = getImportedFnNames(code, "createLoader");
        const pattern = buildExportPattern(fnNames);
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
        const fnNames = getImportedFnNames(code, "createLoader");
        const stubResult = generateClientLoaderStubs(fnNames, code, filePath, isBuild);
        if (stubResult) return stubResult;
      }

      // --- PrerenderHandler: non-RSC stub replacement ---
      if (hasPrerenderHandlerCode && !isRscEnv) {
        const fnNames = getImportedFnNames(code, PRERENDER_CONFIG.fnName);
        const wholeFile = generateWholeFileStubs(
          PRERENDER_CONFIG, fnNames, code, filePath, isBuild,
        );
        if (wholeFile) return wholeFile;

        const exprStubs = generateExprStubs(
          PRERENDER_CONFIG, fnNames, code, filePath, id, isBuild,
        );
        if (exprStubs) return exprStubs;
      }

      // --- PrerenderHandler: RSC build module tracking ---
      if (hasPrerenderHandlerCode && isRscEnv && isBuild) {
        const fnNames = getImportedFnNames(code, PRERENDER_CONFIG.fnName);
        const handlerPattern = buildExportPattern(fnNames);
        const exportNames: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = handlerPattern.exec(code)) !== null) {
          exportNames.push(m[1]);
        }
        if (exportNames.length > 0) {
          prerenderHandlerModules.set(id, exportNames);
        }
      }

      // --- Inline handler extraction to virtual modules ---
      // Runs before stubs/tracking so inline calls become imports, then
      // the existing regex fast path handles both the original file's
      // export const patterns and the virtual modules independently.
      //
      // Cheap pre-check: count total fnName( occurrences vs export const
      // patterns. If they match, every call is a named export and the
      // regex fast path handles them -- skip the AST parse entirely.
      //
      // Each iteration creates a fresh MagicString so that AST positions
      // from findHandlerCalls always match the string they were parsed from.
      let changed = false;

      const handlerConfigs = [
        hasStaticHandlerCode && STATIC_CONFIG,
        hasPrerenderHandlerCode && PRERENDER_CONFIG,
      ].filter((c): c is HandlerTransformConfig => !!c).map((cfg) => {
        const fnNames = getImportedFnNames(code, cfg.fnName);
        return { cfg, fnNames };
      });

      for (const { cfg, fnNames } of handlerConfigs) {
        const totalCalls = countCreateCallsForNames(code, fnNames);
        const exportCalls = countExportConstCallsForNames(code, fnNames);

        if (totalCalls > exportCalls) {
          const iterS = new MagicString(code);
          const result = transformInlineHandlers(
            cfg.fnName, VIRTUAL_HANDLER_PREFIX,
            iterS, code, filePath,
            virtualHandlers, id, parseAst,
          );
          if (result) {
            changed = true;
            code = iterS.toString();
          }
        }
      }

      // --- StaticHandler: non-RSC stub replacement ---
      if (hasStaticHandlerCode && !isRscEnv) {
        const fnNames = getImportedFnNames(code, STATIC_CONFIG.fnName);
        const wholeFile = generateWholeFileStubs(
          STATIC_CONFIG, fnNames, code, filePath, isBuild,
        );
        if (wholeFile) return wholeFile;

        const exprStubs = generateExprStubs(
          STATIC_CONFIG, fnNames, code, filePath, id, isBuild,
        );
        if (exprStubs) return exprStubs;
      }

      // --- StaticHandler: RSC build module tracking ---
      if (hasStaticHandlerCode && isRscEnv && isBuild) {
        const fnNames = getImportedFnNames(code, STATIC_CONFIG.fnName);
        const handlerPattern = buildExportPattern(fnNames);
        const exportNames: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = handlerPattern.exec(code)) !== null) {
          exportNames.push(m[1]);
        }
        if (exportNames.length > 0) {
          staticHandlerModules.set(id, exportNames);
        }
      }

      // --- Unified MagicString transforms ---
      // Single pipeline for all downstream transforms (loaders, handles,
      // locationState, handler IDs). Uses the post-extraction code so
      // positions are always consistent.
      const s = new MagicString(code);

      if (hasLoaderCode) {
        const fnNames = getImportedFnNames(code, "createLoader");
        changed = transformLoaders(fnNames, s, code, filePath, isBuild) || changed;
      }
      if (hasHandleCode) {
        const fnNames = getImportedFnNames(code, "createHandle");
        changed = transformHandles(fnNames, s, code, filePath, isBuild) || changed;
      }
      if (hasLocationStateCode) {
        const fnNames = getImportedFnNames(code, "createLocationState");
        changed =
          transformLocationState(fnNames, s, code, filePath, isBuild) || changed;
      }
      if (hasPrerenderHandlerCode && isRscEnv) {
        const fnNames = getImportedFnNames(code, PRERENDER_CONFIG.fnName);
        changed =
          transformHandlerIds(PRERENDER_CONFIG, fnNames, s, code, filePath, isBuild) || changed;
      }
      if (hasStaticHandlerCode && isRscEnv) {
        const fnNames = getImportedFnNames(code, STATIC_CONFIG.fnName);
        changed =
          transformHandlerIds(STATIC_CONFIG, fnNames, s, code, filePath, isBuild) || changed;
      }

      if (!changed) return;

      return {
        code: s.toString(),
        map: s.generateMap({ source: id, includeContent: true }),
      };
    },
  };
}
