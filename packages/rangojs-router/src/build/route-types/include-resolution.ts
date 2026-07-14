import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { getStringValue } from "./ast-helpers.js";
import { extractRoutesFromSource } from "./ast-route-extraction.js";

// ---------------------------------------------------------------------------
// Unresolvable include diagnostics
// ---------------------------------------------------------------------------

export type UnresolvableReason =
  | "factory-call"
  | "dynamic-expression"
  | "unresolvable-import"
  | "file-not-found";

export interface UnresolvableInclude {
  pathPrefix: string;
  namePrefix: string | null;
  reason: UnresolvableReason;
  sourceFile: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Per-scan memo
// ---------------------------------------------------------------------------

/**
 * Per-scan memo shared across the include-resolution recursion. Keys are
 * absolute file paths; values cache the readFileSync result and the
 * ts.SourceFile parsed from the FULL file source. A separate blockSources map
 * caches parses of extracted sub-blocks (urls() call text), keyed by the exact
 * block string, so the two extractors (routes + includes) for the same block
 * share a single parse.
 *
 * The memo is purely a performance accelerator: same input -> same parse, so
 * generated output is identical to the un-memoized path. A fresh memo is
 * created per top-level scan entry, so stale file edits between scans are never
 * served.
 */
export interface ScanMemo {
  files: Map<string, string>;
  blockSourceFiles: Map<string, ts.SourceFile>;
}

export function createScanMemo(): ScanMemo {
  return { files: new Map(), blockSourceFiles: new Map() };
}

function parseBlock(memo: ScanMemo | undefined, block: string): ts.SourceFile {
  if (memo) {
    const cached = memo.blockSourceFiles.get(block);
    if (cached) return cached;
  }
  const sf = ts.createSourceFile(
    "input.tsx",
    block,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (memo) memo.blockSourceFiles.set(block, sf);
  return sf;
}

function readSourceMemoized(
  memo: ScanMemo | undefined,
  realPath: string,
): string {
  if (memo) {
    const cached = memo.files.get(realPath);
    if (cached !== undefined) return cached;
  }
  const source = readFileSync(realPath, "utf-8");
  if (memo) memo.files.set(realPath, source);
  return source;
}

// ---------------------------------------------------------------------------
// AST-based include() parsing
// ---------------------------------------------------------------------------

function extractNamePrefixFromInclude(node: ts.CallExpression): string | null {
  if (node.arguments.length >= 3) {
    const thirdArg = node.arguments[2];
    if (ts.isObjectLiteralExpression(thirdArg)) {
      for (const prop of thirdArg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;
        if (propName === "name") {
          return getStringValue(prop.initializer);
        }
      }
    }
  }
  return null;
}

/**
 * True when the thunk transforms its dynamic import via a `.then(cb)` whose
 * callback selects a NAMED export other than `default` (e.g.
 * `import("./x").then((m) => m.routes)`). The static resolver walks the module's
 * `export default`, so such a selector would resolve the WRONG export — the
 * caller must treat it as unresolvable instead of silently mis-resolving. Returns
 * false for the supported shapes (no `.then`, `.then((m) => m)`,
 * `.then((m) => m.default)`) and for any shape it cannot positively identify as a
 * non-default member selection (those keep the existing resolve-via-default path).
 */
function thenSelectsNonDefaultMember(expr: ts.Expression): boolean {
  const findThenCall = (e: ts.Expression): ts.CallExpression | null => {
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "then"
    ) {
      return e;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      return findThenCall(e.expression.expression);
    }
    if (ts.isPropertyAccessExpression(e)) return findThenCall(e.expression);
    if (ts.isParenthesizedExpression(e)) return findThenCall(e.expression);
    if (ts.isAwaitExpression(e)) return findThenCall(e.expression);
    return null;
  };

  const thenCall = findThenCall(expr);
  if (!thenCall || thenCall.arguments.length === 0) return false;
  const cb = thenCall.arguments[0];
  if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) return false;

  let ret: ts.Expression | undefined;
  if (ts.isBlock(cb.body)) {
    for (const stmt of cb.body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        ret = stmt.expression;
        break;
      }
    }
  } else {
    ret = cb.body;
  }
  if (!ret) return false;

  if (ts.isPropertyAccessExpression(ret)) {
    return ret.name.text !== "default";
  }
  return false;
}

/**
 * Extract the module specifier from an async include thunk
 * (`() => import("./mod")`). Handles arrow and function-expression thunks,
 * concise or block bodies, and `import("./mod").then(...)` chains. Returns the
 * specifier string, or null when the second arg is not a dynamic-import thunk
 * (so the caller can fall through to identifier / factory-call / dynamic-expr
 * classification).
 */
function extractDynamicImportSpecifier(node: ts.Expression): string | null {
  let body: ts.ConciseBody | undefined;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    body = node.body;
  }
  if (!body) return null;

  // Concise body is the expression itself; block body: first `return <expr>`.
  let expr: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        expr = stmt.expression;
        break;
      }
    }
  } else {
    expr = body;
  }
  if (!expr) return null;

  // Descend `import("./mod").then(...)` / parenthesized / await wrappers down to
  // the `import(...)` call itself.
  const findImportCall = (e: ts.Expression): ts.CallExpression | null => {
    if (
      ts.isCallExpression(e) &&
      e.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      return e;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      return findImportCall(e.expression.expression);
    }
    if (ts.isPropertyAccessExpression(e)) return findImportCall(e.expression);
    if (ts.isParenthesizedExpression(e)) return findImportCall(e.expression);
    if (ts.isAwaitExpression(e)) return findImportCall(e.expression);
    return null;
  };

  const importCall = findImportCall(expr);
  if (!importCall || importCall.arguments.length === 0) return null;
  // A `.then()` selecting a non-default named export can't be statically
  // resolved to `export default`; return null so the caller emits a diagnostic
  // rather than silently generating types for the wrong export.
  if (thenSelectsNonDefaultMember(expr)) return null;
  return getStringValue(importCall.arguments[0]);
}

/**
 * Resolve a module's `export default` to either a same-file `urls()` variable
 * name (`export default shopPatterns`) or the inline call block
 * (`export default urls(...)`). Used to walk async include modules
 * (`() => import("./mod")`), whose convention is `export default urls(...)`.
 */
function resolveDefaultExportTarget(
  code: string,
  sourceFile: ts.SourceFile,
): { variableName?: string; inlineBlock?: string } | null {
  let result: { variableName?: string; inlineBlock?: string } | null = null;

  function visit(node: ts.Node) {
    if (result) return;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        result = { variableName: expr.text };
      } else if (ts.isCallExpression(expr)) {
        const callee = expr.expression;
        if (ts.isIdentifier(callee) && callee.text === "urls") {
          result = { inlineBlock: expr.getText(sourceFile) };
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Extract include() calls with diagnostics for unresolvable ones.
 * Returns both resolved includes (identifier second args) and unresolvable
 * includes (factory calls, etc.) with reasons.
 */
export function extractIncludesWithDiagnostics(
  code: string,
  sourceFileArg?: ts.SourceFile,
): {
  resolved: Array<{
    pathPrefix: string;
    // Exactly one of variableName / moduleSpecifier is set. variableName is the
    // classic `include("/api", apiUrls)` identifier form; moduleSpecifier is the
    // async `include("/api", () => import("./api"))` form, carrying the imported
    // module path so resolution can walk its `export default`.
    variableName?: string;
    moduleSpecifier?: string;
    namePrefix: string | null;
  }>;
  unresolvable: Array<{
    pathPrefix: string;
    namePrefix: string | null;
    reason: UnresolvableReason;
    detail: string;
  }>;
} {
  // Reuse a caller-provided SourceFile (parsed once per scan) when given.
  const sourceFile =
    sourceFileArg ??
    ts.createSourceFile(
      "input.tsx",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  const resolved: Array<{
    pathPrefix: string;
    variableName?: string;
    moduleSpecifier?: string;
    namePrefix: string | null;
  }> = [];
  const unresolvable: Array<{
    pathPrefix: string;
    namePrefix: string | null;
    reason: UnresolvableReason;
    detail: string;
  }> = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "include") {
        if (node.arguments.length < 2) {
          ts.forEachChild(node, visit);
          return;
        }

        const pathPrefix = getStringValue(node.arguments[0]);
        if (pathPrefix === null) {
          ts.forEachChild(node, visit);
          return;
        }

        const secondArg = node.arguments[1];
        const namePrefix = extractNamePrefixFromInclude(node);

        const dynamicImportSpec = extractDynamicImportSpecifier(secondArg);

        if (ts.isIdentifier(secondArg)) {
          resolved.push({
            pathPrefix,
            variableName: secondArg.text,
            namePrefix,
          });
        } else if (dynamicImportSpec !== null) {
          // Async include: `include("/api", () => import("./api"))`. Resolvable
          // statically by walking the imported module's `export default`.
          resolved.push({
            pathPrefix,
            moduleSpecifier: dynamicImportSpec,
            namePrefix,
          });
        } else if (ts.isCallExpression(secondArg)) {
          const callText = secondArg.expression.getText(sourceFile);
          unresolvable.push({
            pathPrefix,
            namePrefix,
            reason: "factory-call",
            detail: `${callText}()`,
          });
        } else {
          unresolvable.push({
            pathPrefix,
            namePrefix,
            reason: "dynamic-expression",
            detail: secondArg.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { resolved, unresolvable };
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

/**
 * Find the import statement for a local variable name.
 * Returns the import specifier and the exported name from the source module.
 */
export function resolveImportedVariable(
  code: string,
  localName: string,
): { specifier: string; exportedName: string } | null {
  // Allow an optional leading default binding before the named-import brace so
  // a combined `import Foo, { bar } from "..."` is matched (the named members
  // are the only part we resolve; the default binding is skipped). Without the
  // optional `(?:[\w$]+\s*,\s*)?` segment, the `Foo, ` prefix breaks the match
  // and a legitimate static named import surfaces as `unresolvable-import`.
  const importRegex =
    /import\s*(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    const imports = match[1];
    const specifier = match[2];

    const parts = imports
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch && asMatch[2] === localName)
        return { specifier, exportedName: asMatch[1] };
      if (part === localName) return { specifier, exportedName: localName };
    }
  }

  return null;
}

/**
 * Resolve an import specifier relative to the importing file.
 * Strips .js/.mjs/.jsx extensions and tries .ts/.tsx/.js/.jsx candidates.
 */
export function resolveImportPath(
  importSpec: string,
  fromFile: string,
): string | null {
  if (!importSpec.startsWith(".")) return null;

  const dir = dirname(fromFile);
  let base = importSpec;
  if (base.endsWith(".js")) base = base.slice(0, -3);
  else if (base.endsWith(".mjs")) base = base.slice(0, -4);
  else if (base.endsWith(".jsx")) base = base.slice(0, -4);

  const candidates = [
    resolve(dir, base + ".ts"),
    resolve(dir, base + ".tsx"),
    resolve(dir, base + ".js"),
    resolve(dir, base + ".jsx"),
    resolve(dir, base + "/index.ts"),
    resolve(dir, base + "/index.tsx"),
    resolve(dir, base + "/index.js"),
    resolve(dir, base + "/index.jsx"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// urls() block extraction for same-file variables
// ---------------------------------------------------------------------------

/**
 * Extract the source of a specific `const varName = urls(...)` call using
 * the TypeScript AST. Returns the full text of the urls() call expression.
 */
function extractUrlsBlockForVariable(
  code: string,
  varName: string,
  sourceFileArg?: ts.SourceFile,
): string | null {
  // Reuse a caller-provided full-source SourceFile (parsed once per scan).
  const sourceFile =
    sourceFileArg ??
    ts.createSourceFile(
      "input.tsx",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  let result: string | null = null;

  function visit(node: ts.Node) {
    if (result) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === varName &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && callee.text === "urls") {
        result = node.initializer.getText(sourceFile);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

// ---------------------------------------------------------------------------
// Combined route map building
// ---------------------------------------------------------------------------

export interface CombinedRouteMap {
  routes: Record<string, string>;
  searchSchemas: Record<string, Record<string, string>>;
  sourceFiles: Record<string, string>;
}

function buildRouteMapFromBlock(
  block: string,
  fullSource: string,
  filePath: string,
  visited: Set<string>,
  searchSchemasOut?: Record<string, Record<string, string>>,
  sourceFilesOut?: Record<string, string>,
  diagnosticsOut?: UnresolvableInclude[],
  memo?: ScanMemo,
): Record<string, string> {
  const routeMap: Record<string, string> = {};

  // Parse the block once and share the SourceFile between both extractors.
  const blockSourceFile = parseBlock(memo, block);

  // Extract local path() routes
  const localRoutes = extractRoutesFromSource(block, blockSourceFile);
  for (const { name, pattern, search } of localRoutes) {
    routeMap[name] = pattern;
    if (sourceFilesOut) sourceFilesOut[name] = filePath;
    if (search && searchSchemasOut) {
      searchSchemasOut[name] = search;
    }
  }

  // Extract include() calls with diagnostics for unresolvable ones
  const { resolved: includes, unresolvable } = extractIncludesWithDiagnostics(
    block,
    blockSourceFile,
  );

  if (diagnosticsOut) {
    for (const entry of unresolvable) {
      diagnosticsOut.push({ ...entry, sourceFile: filePath });
    }
  }

  for (const inc of includes) {
    const { pathPrefix, namePrefix } = inc;
    let childResult: CombinedRouteMap;

    if (inc.moduleSpecifier) {
      // Async include `() => import("./mod")`: resolve the imported module's
      // `export default` (convention: `export default urls(...)`), then recurse
      // into it exactly like an identifier include. Nested include()s inside the
      // async module — eager or async — resolve through the same recursion.
      const targetFile = resolveImportPath(inc.moduleSpecifier, filePath);
      if (!targetFile) {
        diagnosticsOut?.push({
          pathPrefix,
          namePrefix,
          reason: "file-not-found",
          sourceFile: filePath,
          detail: `import("${inc.moduleSpecifier}") resolved to no file`,
        });
        continue;
      }
      let targetSource: string;
      try {
        targetSource = readSourceMemoized(memo, resolve(targetFile));
      } catch (err) {
        // Every other failure path in this function emits a diagnostic; a bare
        // `continue` here would drop the group from generated types with no
        // signal at all. Emit one like the siblings do.
        diagnosticsOut?.push({
          pathPrefix,
          namePrefix,
          reason: "file-not-found",
          sourceFile: filePath,
          detail: `import("${inc.moduleSpecifier}") resolved to "${targetFile}" but reading it failed: ${(err as Error)?.message ?? String(err)}`,
        });
        continue;
      }
      const def = resolveDefaultExportTarget(
        targetSource,
        parseBlock(memo, targetSource),
      );
      if (!def) {
        diagnosticsOut?.push({
          pathPrefix,
          namePrefix,
          reason: "unresolvable-import",
          sourceFile: filePath,
          detail: `import("${inc.moduleSpecifier}") has no resolvable \`export default urls(...)\``,
        });
        continue;
      }
      if (def.inlineBlock) {
        // `export default urls(...)` — recurse into the inline call block.
        childResult = buildCombinedRouteMapWithSearch(
          targetFile,
          undefined,
          visited,
          diagnosticsOut,
          def.inlineBlock,
          memo,
        );
      } else {
        // `export default <name>`. That name may be a same-file
        // `const name = urls(...)` OR itself re-exported from an import
        // (`import { name } from "./x"; export default name`). The shared helper
        // resolves the import chain first, then falls back to same-file
        // extraction — without this a re-exported default silently yields empty
        // routes. Resolution scope is the imported module (targetFile); the
        // diagnostic is still attributed to the file with the async include.
        const variableName = def.variableName!;
        const resolved = resolveIncludedVariable({
          variableName,
          resolutionFile: targetFile,
          resolutionSource: targetSource,
          reportFile: filePath,
          memo,
          visited,
          diagnosticsOut,
          pathPrefix,
          namePrefix,
          fileNotFoundDetail: (specifier) =>
            `import("${inc.moduleSpecifier}") default re-exports "${variableName}" from "${specifier}", which resolved to no file`,
          notFoundDetail: () =>
            `import("${inc.moduleSpecifier}") default "${variableName}" not found in its imports or same-file scope`,
        });
        if (!resolved) continue;
        childResult = resolved;
      }
    } else if (inc.variableName) {
      // Identifier include `include(prefix, patterns)`: resolve `patterns`
      // (imported or same-file) through the same shared helper as the async
      // `export default <name>` form above.
      const variableName = inc.variableName;
      const resolved = resolveIncludedVariable({
        variableName,
        resolutionFile: filePath,
        resolutionSource: fullSource,
        reportFile: filePath,
        memo,
        visited,
        diagnosticsOut,
        pathPrefix,
        namePrefix,
        fileNotFoundDetail: (specifier) =>
          `import "${specifier}" resolved to no file`,
        notFoundDetail: () =>
          `variable "${variableName}" not found in imports or same-file scope`,
      });
      if (!resolved) continue;
      childResult = resolved;
    } else {
      continue;
    }

    // Includes without a name keep their child names private to the mounted
    // module. They remain active at runtime via an internal scope prefix, but
    // they are intentionally omitted from generated public route maps.
    if (namePrefix === null) {
      continue;
    }

    // Apply prefixes
    for (const [name, pattern] of Object.entries(childResult.routes)) {
      const prefixedName = namePrefix ? `${namePrefix}.${name}` : name;
      let prefixedPattern: string;
      if (pattern === "/") {
        prefixedPattern = pathPrefix || "/";
      } else if (pathPrefix.endsWith("/") && pattern.startsWith("/")) {
        prefixedPattern = pathPrefix + pattern.slice(1);
      } else {
        prefixedPattern = pathPrefix + pattern;
      }
      routeMap[prefixedName] = prefixedPattern;
      // Propagate search schemas with prefix
      if (childResult.searchSchemas[name] && searchSchemasOut) {
        searchSchemasOut[prefixedName] = childResult.searchSchemas[name];
      }
      if (childResult.sourceFiles[name] && sourceFilesOut) {
        sourceFilesOut[prefixedName] = childResult.sourceFiles[name];
      }
    }
  }

  return routeMap;
}

/**
 * Resolve an include's target VARIABLE to its child route map. The variable may
 * be imported (`import { name } from "./x"`) or defined in the same file
 * (`const name = urls(...)`). Shared by the identifier include branch and the
 * async-include `export default <name>` branch so a future import-resolution fix
 * cannot silently miss one form. Returns null (with a diagnostic pushed) when
 * the variable is unresolvable — the caller should skip the include.
 *
 * `resolutionFile`/`resolutionSource` is the module whose import + same-file
 * scope is searched; `reportFile` is the file the diagnostic is attributed to
 * (the one containing the include() call), which differs for async includes.
 */
function resolveIncludedVariable(opts: {
  variableName: string;
  resolutionFile: string;
  resolutionSource: string;
  reportFile: string;
  memo: ScanMemo | undefined;
  visited: Set<string> | undefined;
  diagnosticsOut: UnresolvableInclude[] | undefined;
  pathPrefix: string;
  namePrefix: string | null;
  fileNotFoundDetail: (specifier: string) => string;
  notFoundDetail: () => string;
}): CombinedRouteMap | null {
  const {
    variableName,
    resolutionFile,
    resolutionSource,
    reportFile,
    memo,
    visited,
    diagnosticsOut,
    pathPrefix,
    namePrefix,
  } = opts;
  const imported = resolveImportedVariable(resolutionSource, variableName);
  if (imported) {
    const targetFile = resolveImportPath(imported.specifier, resolutionFile);
    if (!targetFile) {
      diagnosticsOut?.push({
        pathPrefix,
        namePrefix,
        reason: "file-not-found",
        sourceFile: reportFile,
        detail: opts.fileNotFoundDetail(imported.specifier),
      });
      return null;
    }
    return buildCombinedRouteMapWithSearch(
      targetFile,
      imported.exportedName,
      visited,
      diagnosticsOut,
      undefined,
      memo,
    );
  }
  // Not imported: it must be a same-file `const name = urls(...)`. Confirm it
  // exists so an undefined name emits a diagnostic instead of empty routes.
  const sameFileBlock = extractUrlsBlockForVariable(
    resolutionSource,
    variableName,
    parseBlock(memo, resolutionSource),
  );
  if (!sameFileBlock) {
    diagnosticsOut?.push({
      pathPrefix,
      namePrefix,
      reason: "unresolvable-import",
      sourceFile: reportFile,
      detail: opts.notFoundDetail(),
    });
    return null;
  }
  return buildCombinedRouteMapWithSearch(
    resolutionFile,
    variableName,
    visited,
    diagnosticsOut,
    undefined,
    memo,
  );
}

/**
 * Build route map and search schemas together.
 * Internal helper used by the include resolution path.
 *
 * @param inlineBlock - Optional pre-extracted code block (e.g. from an inline
 *   builder function). When provided, variableName is ignored and the block
 *   is parsed directly for path()/include() calls.
 * @param memo - Per-scan readFileSync/parse memo. A fresh one is created at the
 *   top-level entry and threaded through the recursion so each file is read and
 *   parsed once per scan. Behavior-preserving (same input -> same output).
 */
export function buildCombinedRouteMapWithSearch(
  filePath: string,
  variableName?: string,
  visited?: Set<string>,
  diagnosticsOut?: UnresolvableInclude[],
  inlineBlock?: string,
  memo?: ScanMemo,
): CombinedRouteMap {
  visited = visited ?? new Set();
  memo = memo ?? createScanMemo();
  const realPath = resolve(filePath);
  const key = variableName ? `${realPath}:${variableName}` : realPath;
  if (visited.has(key)) {
    console.warn(`[rango] Circular include detected, skipping: ${key}`);
    return { routes: {}, searchSchemas: {}, sourceFiles: {} };
  }
  visited.add(key);

  let source: string;
  try {
    source = readSourceMemoized(memo, realPath);
  } catch {
    return { routes: {}, searchSchemas: {}, sourceFiles: {} };
  }

  let block: string;
  if (inlineBlock) {
    block = inlineBlock;
  } else if (variableName) {
    const extracted = extractUrlsBlockForVariable(
      source,
      variableName,
      parseBlock(memo, source),
    );
    if (!extracted) return { routes: {}, searchSchemas: {}, sourceFiles: {} };
    block = extracted;
  } else {
    block = source;
  }

  const searchSchemas: Record<string, Record<string, string>> = {};
  const sourceFiles: Record<string, string> = {};
  const routes = buildRouteMapFromBlock(
    block,
    source,
    realPath,
    visited,
    searchSchemas,
    sourceFiles,
    diagnosticsOut,
    memo,
  );

  // Remove from visited so sibling branches can include the same variable
  // without false circular-include detection. Only ancestors in the current
  // recursion path should trigger the cycle guard.
  visited.delete(key);

  return { routes, searchSchemas, sourceFiles };
}
