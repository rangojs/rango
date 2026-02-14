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
  buildExportMap,
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

interface CreateExportBinding {
  localName: string;
  exportNames: string[];
  callExprStart: number;
  callOpenParenPos: number;
  callCloseParenPos: number;
  argCount: number;
  statementEnd: number;
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

/**
 * Check whether every non-type export in `code` is accounted for by the given
 * bindings. Returns false if any export exists that is not one of the known
 * create* call locals/exports, allowing callers to bail out for mixed-export
 * files.
 */
function isExportOnlyFile(
  code: string,
  bindings: CreateExportBinding[],
): boolean {
  if (bindings.length === 0) return false;

  const knownLocals = new Set<string>();
  const knownExports = new Set<string>();
  for (const b of bindings) {
    knownLocals.add(b.localName);
    for (const e of b.exportNames) knownExports.add(e);
  }

  // Bail on star re-exports (unknown exports)
  if (/export\s*\*/.test(code)) return false;

  // Check `export const/let/var/function/class/default X` declarations
  const declExportPattern =
    /export\s+(const|let|var|function|class|default)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = declExportPattern.exec(code)) !== null) {
    if (!knownExports.has(match[2])) return false;
  }

  // Check `export { X }` and `export { X as Y }` specifiers: the local name
  // must reference a known create* binding.
  const specExportPattern = /export\s*\{([^}]+)\}/g;
  while ((match = specExportPattern.exec(code)) !== null) {
    const specifiers = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of specifiers) {
      const m = spec.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!m) continue;
      const local = m[1];
      if (!knownLocals.has(local)) return false;
    }
  }

  return true;
}

// NOTE: This regex may over-count when the fn name appears inside strings or
// comments, but it's only used for the warning heuristic (totalCalls >
// supportedBindings) and the inline-extraction pre-check, so over-counting
// triggers a harmless extra AST parse rather than affecting correctness.
function countCreateCallsForNames(code: string, fnNames: string[]): number {
  const pattern = new RegExp(
    `\\b(?:${fnNames.map(escapeRegExp).join("|")})\\s*(?:<[^>]*>\\s*)?\\(`,
    "g",
  );
  return (code.match(pattern) || []).length;
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

function getCalledIdentifierFromCall(callExpr: any): string | null {
  const callee = callExpr?.callee;
  if (callee?.type === "Identifier") return callee.name;
  if (
    callee?.type === "TSInstantiationExpression" &&
    callee.expression?.type === "Identifier"
  ) {
    return callee.expression.name;
  }
  return null;
}

function collectCreateExportBindingsFallback(
  code: string,
  fnNames: string[],
): CreateExportBinding[] {
  const alternation = fnNames.map(escapeRegExp).join("|");
  const exportConstPattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(?:${alternation})\\s*(?:<[^>]*>)?\\s*\\(`,
    "g",
  );
  const localDeclPattern = new RegExp(
    `\\bconst\\s+(\\w+)\\s*=\\s*((?:${alternation})\\s*(?:<[^>]*>)?\\s*\\()`,
    "g",
  );
  const exportSpecPattern = /export\s*\{([^}]+)\}/g;

  const exportMap = new Map<string, string[]>();
  const pushExport = (local: string, exported: string) => {
    const list = exportMap.get(local);
    if (list) {
      if (!list.includes(exported)) list.push(exported);
      return;
    }
    exportMap.set(local, [exported]);
  };

  let match: RegExpExecArray | null;
  while ((match = exportConstPattern.exec(code)) !== null) {
    pushExport(match[1], match[1]);
  }

  while ((match = exportSpecPattern.exec(code)) !== null) {
    const specifiers = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const specifier of specifiers) {
      const specMatch = specifier.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!specMatch) continue;
      const local = specMatch[1];
      const exported = specMatch[2] || local;
      pushExport(local, exported);
    }
  }

  const bindings: CreateExportBinding[] = [];
  while ((match = localDeclPattern.exec(code)) !== null) {
    const localName = match[1];
    const exportNames = exportMap.get(localName) ?? [];
    if (exportNames.length === 0) continue;

    const openParenPos = match.index + match[0].length - 1;
    const closeParenPos = findMatchingParen(code, openParenPos + 1) - 1;
    if (closeParenPos <= openParenPos) continue;

    bindings.push({
      localName,
      exportNames,
      callExprStart: match.index + match[0].length - match[2].length,
      callOpenParenPos: openParenPos,
      callCloseParenPos: closeParenPos,
      argCount: countArgs(code, openParenPos + 1, closeParenPos),
      statementEnd: findStatementEnd(code, closeParenPos + 1),
    });
  }

  return bindings;
}

function collectCreateExportBindings(
  code: string,
  fnNames: string[],
  program?: any,
): CreateExportBinding[] {
  if (!program) {
    try {
      program = parseAst(code, { jsx: true });
    } catch {
      return collectCreateExportBindingsFallback(code, fnNames);
    }
  }

  const exportMap = buildExportMap(program);
  const fnNameSet = new Set(fnNames);
  const bindings: CreateExportBinding[] = [];

  const collectFromVarDecl = (varDecl: any, statementEnd: number) => {
    if (varDecl?.type !== "VariableDeclaration" || varDecl.kind !== "const") {
      return;
    }

    for (const decl of varDecl.declarations ?? []) {
      const calledIdentifier = getCalledIdentifierFromCall(decl?.init);
      if (
        decl?.id?.type !== "Identifier" ||
        decl?.init?.type !== "CallExpression" ||
        !calledIdentifier ||
        !fnNameSet.has(calledIdentifier)
      ) {
        continue;
      }

      const localName = decl.id.name;
      const exportNames = exportMap.get(localName) ?? [];
      if (exportNames.length === 0) continue;

      const callStart = decl.init.start as number;
      const callEnd = decl.init.end as number;
      const calleeEnd = decl.init.callee.end as number;

      let openParenPos = -1;
      for (let i = calleeEnd; i < callEnd; i++) {
        if (code[i] === "(") {
          openParenPos = i;
          break;
        }
      }
      if (openParenPos === -1) continue;

      const closeParenPos = findMatchingParen(code, openParenPos + 1) - 1;
      if (closeParenPos <= openParenPos) continue;

      bindings.push({
        localName,
        exportNames,
        callExprStart: decl.init.start as number,
        callOpenParenPos: openParenPos,
        callCloseParenPos: closeParenPos,
        argCount: decl.init.arguments?.length ?? 0,
        statementEnd,
      });
    }
  };

  for (const node of program.body ?? []) {
    if (node?.type === "VariableDeclaration") {
      collectFromVarDecl(node, node.end as number);
      continue;
    }

    if (
      node?.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration"
    ) {
      collectFromVarDecl(node.declaration, node.end as number);
    }
  }

  return bindings;
}

function buildUnsupportedShapeWarning(filePath: string, fnName: string): string {
  return [
    `[rsc-router] Unsupported ${fnName} shape in "${filePath}".`,
    `Supported shapes are:`,
    `  - export const X = ${fnName}(...)`,
    `  - const X = ${fnName}(...); export { X }`,
    `  - const X = ${fnName}(...); export { X as Y }`,
    `Potentially unsupported forms include:`,
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
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map?: undefined } | null {
  if (!isExportOnlyFile(code, bindings)) return null;

  const exportNames = bindings.flatMap((b) => b.exportNames);
  const stubs = exportNames.map((name) => {
    const loaderId = isBuild
      ? hashId(filePath, name)
      : `${filePath}#${name}`;
    return `export const ${name} = { __brand: "loader", $$id: "${loaderId}" };`;
  });

  return { code: stubs.join("\n") + "\n" };
}

function transformLoaders(
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];

    const loaderId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Inject $$id as hidden third parameter.
    // createLoader(fn) -> createLoader(fn, undefined, "id")
    // createLoader(fn, true) -> createLoader(fn, true, "id")
    const paramInjection =
      binding.argCount === 1
        ? `, undefined, "${loaderId}"`
        : `, "${loaderId}"`;
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${loaderId}";`;
    s.appendRight(binding.statementEnd, propInjection);
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
  bindings: CreateExportBinding[],
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];
    const args = analyzeCreateHandleArgs(
      code,
      binding.callOpenParenPos + 1,
      binding.callCloseParenPos,
    );

    const handleId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    let paramInjection: string;
    if (!args.hasArgs) {
      paramInjection = `undefined, "${handleId}"`;
    } else {
      paramInjection = `, "${handleId}"`;
    }
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${handleId}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

// ---------------------------------------------------------------------------
// LocationState helpers
// ---------------------------------------------------------------------------

function transformLocationState(
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    if (binding.argCount > 0) continue; // Already has a key, skip
    const exportName = binding.exportNames[0];

    const stateKey = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    s.appendLeft(binding.callCloseParenPos, `"${stateKey}"`);

    const propInjection =
      `\n${binding.localName}.__rsc_ls_key = "__rsc_ls_${stateKey}";`;
    s.appendRight(binding.statementEnd, propInjection);
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
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map: null } | null {
  if (!isExportOnlyFile(code, bindings)) return null;

  const exportNames = bindings.flatMap((b) => b.exportNames);
  const stubs = exportNames.map((name) => {
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
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  sourceId: string,
  isBuild: boolean,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (bindings.length === 0) return null;

  const s = new MagicString(code);
  let hasChanges = false;

  for (const binding of bindings) {
    const exportName = binding.exportNames[0];
    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    s.overwrite(
      binding.callExprStart,
      binding.callCloseParenPos + 1,
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
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];

    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Injection strategy matches the runtime overload signatures:
    //   0 args                              -> inject undefined, "id"
    //   1 arg  (handler)                    -> inject , undefined, "id"
    //   2+ args                             -> inject , "id"
    let paramInjection: string;
    if (binding.argCount === 0) {
      paramInjection = `undefined, "${handlerId}"`;
    } else if (binding.argCount === 1) {
      paramInjection = `, undefined, "${handlerId}"`;
    } else {
      paramInjection = `, "${handlerId}"`;
    }
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${handlerId}";`;
    s.appendRight(binding.statementEnd, propInjection);
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
          const relativePath = normalizePath(
            path.relative(projectRoot, filePath),
          );
          const bindings = collectCreateExportBindings(content, fnNames);

          for (const binding of bindings) {
            const exportName = binding.exportNames[0];
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

      // Quick bail-out: also check for raw create* identifiers.
      // This is safe even with aliases (e.g., `import { createLoader as cl }`)
      // because the import statement itself always contains the canonical name
      // "createLoader", so code.includes("createLoader") will still match.
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

      // Per-invocation caches to avoid redundant AST parsing.
      // getImportedFnNames is cached by canonical name (imports never change).
      // collectCreateExportBindings is cached by fnNames key; the cache is
      // cleared when `code` changes (e.g., after inline handler extraction).
      const _fnNamesCache = new Map<string, string[]>();
      const _bindingsCache = new Map<string, CreateExportBinding[]>();
      let _cachedAst: any;
      let _astParseFailed = false;
      let _astCodeRef = code;

      const getFnNames = (canonicalName: string): string[] => {
        let result = _fnNamesCache.get(canonicalName);
        if (!result) {
          result = getImportedFnNames(code, canonicalName);
          _fnNamesCache.set(canonicalName, result);
        }
        return result;
      };

      // Lazy AST parse: parsed once and shared across all
      // collectCreateExportBindings calls for the same code string.
      const lazyAst = (): any | undefined => {
        if (code !== _astCodeRef) {
          _cachedAst = undefined;
          _astParseFailed = false;
          _astCodeRef = code;
        }
        if (_cachedAst !== undefined || _astParseFailed) return _cachedAst;
        try {
          _cachedAst = parseAst(code, { jsx: true });
        } catch {
          _astParseFailed = true;
        }
        return _cachedAst;
      };

      const getBindings = (currentCode: string, fnNames: string[]): CreateExportBinding[] => {
        const key = fnNames.join("\0");
        let result = _bindingsCache.get(key);
        if (!result) {
          result = collectCreateExportBindings(currentCode, fnNames, lazyAst());
          _bindingsCache.set(key, result);
        }
        return result;
      };

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

        const fnNames = getFnNames(cfg.fnName);
        const totalCalls = countCreateCallsForNames(code, fnNames);
        const supportedBindings = getBindings(code, fnNames).length;
        if (totalCalls <= supportedBindings) continue;

        const warnKey = `${id}::${cfg.fnName}`;
        if (unsupportedShapeWarnings.has(warnKey)) continue;
        unsupportedShapeWarnings.add(warnKey);
        this.warn(buildUnsupportedShapeWarning(filePath, cfg.fnName));
      }

      // --- Loader: track for manifest (RSC env only) ---
      if (hasLoaderCode && isRscEnv) {
        const fnNames = getFnNames("createLoader");
        const bindings = getBindings(code, fnNames);
        for (const binding of bindings) {
          const exportName = binding.exportNames[0];
          const hashedId = hashId(filePath, exportName);
          loaderRegistry.set(hashedId, {
            filePath,
            exportName,
          });
        }
      }

      // --- Loader: client stubs for non-RSC environments ---
      if (hasLoaderCode && !isRscEnv) {
        const fnNames = getFnNames("createLoader");
        const bindings = getBindings(code, fnNames);
        const stubResult = generateClientLoaderStubs(bindings, code, filePath, isBuild);
        if (stubResult) return stubResult;
      }

      // --- PrerenderHandler: non-RSC stub replacement ---
      if (hasPrerenderHandlerCode && !isRscEnv) {
        const fnNames = getFnNames(PRERENDER_CONFIG.fnName);
        const bindings = getBindings(code, fnNames);
        const wholeFile = generateWholeFileStubs(
          PRERENDER_CONFIG, bindings, code, filePath, isBuild,
        );
        if (wholeFile) return wholeFile;

        const exprStubs = generateExprStubs(
          PRERENDER_CONFIG, bindings, code, filePath, id, isBuild,
        );
        if (exprStubs) return exprStubs;
      }

      // --- PrerenderHandler: RSC build module tracking ---
      if (hasPrerenderHandlerCode && isRscEnv && isBuild) {
        const fnNames = getFnNames(PRERENDER_CONFIG.fnName);
        const exportNames = getBindings(code, fnNames)
          .map((b) => b.exportNames[0]);
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
        const fnNames = getFnNames(cfg.fnName);
        return { cfg, fnNames };
      });

      for (const { cfg, fnNames } of handlerConfigs) {
        const totalCalls = countCreateCallsForNames(code, fnNames);
        const supportedBindings = getBindings(code, fnNames).length;

        if (totalCalls > supportedBindings) {
          const iterS = new MagicString(code);
          const result = transformInlineHandlers(
            cfg.fnName, VIRTUAL_HANDLER_PREFIX,
            iterS, code, filePath,
            virtualHandlers, id, parseAst,
          );
          if (result) {
            changed = true;
            code = iterS.toString();
            _bindingsCache.clear();
          }
        }
      }

      // --- StaticHandler: non-RSC stub replacement ---
      if (hasStaticHandlerCode && !isRscEnv) {
        const fnNames = getFnNames(STATIC_CONFIG.fnName);
        const bindings = getBindings(code, fnNames);
        const wholeFile = generateWholeFileStubs(
          STATIC_CONFIG, bindings, code, filePath, isBuild,
        );
        if (wholeFile) return wholeFile;

        const exprStubs = generateExprStubs(
          STATIC_CONFIG, bindings, code, filePath, id, isBuild,
        );
        if (exprStubs) return exprStubs;
      }

      // --- StaticHandler: RSC build module tracking ---
      if (hasStaticHandlerCode && isRscEnv && isBuild) {
        const fnNames = getFnNames(STATIC_CONFIG.fnName);
        const exportNames = getBindings(code, fnNames)
          .map((b) => b.exportNames[0]);
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
        const fnNames = getFnNames("createLoader");
        changed = transformLoaders(getBindings(code, fnNames), s, filePath, isBuild) || changed;
      }
      if (hasHandleCode) {
        const fnNames = getFnNames("createHandle");
        changed = transformHandles(getBindings(code, fnNames), s, code, filePath, isBuild) || changed;
      }
      if (hasLocationStateCode) {
        const fnNames = getFnNames("createLocationState");
        changed =
          transformLocationState(getBindings(code, fnNames), s, filePath, isBuild) || changed;
      }
      if (hasPrerenderHandlerCode && isRscEnv) {
        const fnNames = getFnNames(PRERENDER_CONFIG.fnName);
        changed =
          transformHandlerIds(PRERENDER_CONFIG, getBindings(code, fnNames), s, filePath, isBuild) || changed;
      }
      if (hasStaticHandlerCode && isRscEnv) {
        const fnNames = getFnNames(STATIC_CONFIG.fnName);
        changed =
          transformHandlerIds(STATIC_CONFIG, getBindings(code, fnNames), s, filePath, isBuild) || changed;
      }

      if (!changed) return;

      return {
        code: s.toString(),
        map: s.generateMap({ source: id, includeContent: true }),
      };
    },
  };
}
