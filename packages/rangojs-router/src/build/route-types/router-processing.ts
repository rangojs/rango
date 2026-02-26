import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname, resolve, basename as pathBasename } from "node:path";
import ts from "typescript";
import { generateRouteTypesSource } from "./codegen.js";
import type { ScanFilter } from "./scan-filter.js";
import { findTsFiles } from "./scan-filter.js";
import {
  resolveImportedVariable,
  resolveImportPath,
  buildCombinedRouteMapWithSearch,
  type UnresolvableInclude,
} from "./include-resolution.js";

// ---------------------------------------------------------------------------
// Router file URL extraction
// ---------------------------------------------------------------------------

/**
 * Extract the url patterns variable from a router file using AST.
 * Detects two patterns:
 *   1. createRouter(...).routes(variableName)
 *   2. createRouter({ urls: variableName, ... })
 * Returns the local variable name.
 */
export function extractUrlsVariableFromRouter(code: string): string | null {
  const sourceFile = ts.createSourceFile(
    "router.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let result: string | null = null;

  function isCreateRouterCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    return ts.isIdentifier(callee) && callee.text === "createRouter";
  }

  function visit(node: ts.Node) {
    if (result) return;

    // Pattern 1: createRouter(...).routes(variableName)
    // The AST shape is CallExpression(.routes) -> PropertyAccessExpression -> CallExpression(createRouter)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "routes" &&
      node.arguments.length >= 1 &&
      ts.isIdentifier(node.arguments[0])
    ) {
      // Walk up the chain: createRouter().middleware(...).routes(x) etc.
      // The innermost call should be createRouter(...)
      let inner: ts.Expression = node.expression.expression;
      while (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression)
      ) {
        inner = inner.expression.expression;
      }
      if (isCreateRouterCall(inner)) {
        result = (node.arguments[0] as ts.Identifier).text;
        return;
      }
    }

    // Pattern 2: createRouter({ urls: variableName, ... })
    if (isCreateRouterCall(node)) {
      const callExpr = node as ts.CallExpression;
      for (const arg of callExpr.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "urls" &&
              ts.isIdentifier(prop.initializer)
            ) {
              result = prop.initializer.text;
              return;
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/**
 * Resolve routes and search schemas from a router source file by following the
 * variable passed to `.routes(...)` or `urls: ...` in createRouter options.
 */
export function buildCombinedRouteMapForRouterFile(routerFilePath: string): {
  routes: Record<string, string>;
  searchSchemas: Record<string, Record<string, string>>;
} {
  let routerSource: string;
  try {
    routerSource = readFileSync(routerFilePath, "utf-8");
  } catch {
    return { routes: {}, searchSchemas: {} };
  }

  const urlsVarName = extractUrlsVariableFromRouter(routerSource);
  if (!urlsVarName) {
    return { routes: {}, searchSchemas: {} };
  }

  const imported = resolveImportedVariable(routerSource, urlsVarName);
  if (imported) {
    const targetFile = resolveImportPath(imported.specifier, routerFilePath);
    if (!targetFile) {
      return { routes: {}, searchSchemas: {} };
    }
    return buildCombinedRouteMapWithSearch(targetFile, imported.exportedName);
  }

  return buildCombinedRouteMapWithSearch(routerFilePath, urlsVarName);
}

// ---------------------------------------------------------------------------
// Unresolvable include detection (full include tree walk)
// ---------------------------------------------------------------------------

/**
 * Walk the full include tree starting from a router file and detect
 * all includes that the static parser cannot resolve.
 * Returns an array of diagnostics; empty means fully resolvable.
 */
export function detectUnresolvableIncludes(
  routerFilePath: string,
): UnresolvableInclude[] {
  const realPath = resolve(routerFilePath);
  let source: string;
  try {
    source = readFileSync(realPath, "utf-8");
  } catch {
    return [];
  }

  // Extract the urls variable from the router file
  const urlsVarName = extractUrlsVariableFromRouter(source);
  if (!urlsVarName) return [];

  // Resolve where the urls variable comes from
  const imported = resolveImportedVariable(source, urlsVarName);
  let targetFile: string;
  let exportedName: string | undefined;

  if (imported) {
    const resolved = resolveImportPath(imported.specifier, realPath);
    if (!resolved) {
      return [
        {
          pathPrefix: "/",
          namePrefix: null,
          reason: "file-not-found",
          sourceFile: realPath,
          detail: `import "${imported.specifier}" resolved to no file`,
        },
      ];
    }
    targetFile = resolved;
    exportedName = imported.exportedName;
  } else {
    // Same-file urls() definition
    targetFile = realPath;
    exportedName = urlsVarName;
  }

  const diagnostics: UnresolvableInclude[] = [];
  buildCombinedRouteMapWithSearch(
    targetFile,
    exportedName,
    new Set(),
    diagnostics,
  );
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Per-router named-routes.gen.ts writer
// ---------------------------------------------------------------------------

/**
 * Scan for files containing createRouter() and return their paths.
 * Call once at startup; the result can be reused on subsequent watcher triggers.
 */
export function findRouterFiles(root: string, filter?: ScanFilter): string[] {
  const files = findTsFiles(root, filter);
  const result: string[] = [];
  for (const filePath of files) {
    if (filePath.includes(".gen.")) continue;
    try {
      const source = readFileSync(filePath, "utf-8");
      if (/\bcreateRouter\s*[<(]/.test(source)) {
        result.push(filePath);
      }
    } catch {
      continue;
    }
  }
  return result;
}

/**
 * Write named-routes.gen.ts files from static source parsing.
 * Dev-only: provides initial .gen.ts files for IDE types before runtime
 * discovery runs. Must NOT be called during production builds -- runtime
 * discovery in buildStart produces the definitive file.
 */
export function writeCombinedRouteTypes(
  root: string,
  knownRouterFiles?: string[],
  opts?: { preserveIfLarger?: boolean },
): void {
  // Delete old combined named-routes.gen.ts if it exists (stale from older versions)
  try {
    const oldCombinedPath = join(root, "src", "named-routes.gen.ts");
    if (existsSync(oldCombinedPath)) {
      unlinkSync(oldCombinedPath);
      console.log(
        `[rsc-router] Removed stale combined route types: ${oldCombinedPath}`,
      );
    }
  } catch {}

  const routerFilePaths = knownRouterFiles ?? findRouterFiles(root);
  if (routerFilePaths.length === 0) return;

  for (const routerFilePath of routerFilePaths) {
    let routerSource: string;
    try {
      routerSource = readFileSync(routerFilePath, "utf-8");
    } catch {
      continue;
    }
    // Extract the urls variable name from .routes(varName) or urls: varName
    const urlsVarName = extractUrlsVariableFromRouter(routerSource);
    if (!urlsVarName) continue;

    // Resolve the variable to its source module
    let result: {
      routes: Record<string, string>;
      searchSchemas: Record<string, Record<string, string>>;
    };

    const imported = resolveImportedVariable(routerSource, urlsVarName);
    if (imported) {
      // Variable is imported from another module
      const targetFile = resolveImportPath(imported.specifier, routerFilePath);
      if (!targetFile) continue;
      result = buildCombinedRouteMapWithSearch(
        targetFile,
        imported.exportedName,
      );
    } else {
      // Variable is defined in the same file
      result = buildCombinedRouteMapWithSearch(routerFilePath, urlsVarName);
    }

    const routerBasename = pathBasename(routerFilePath).replace(
      /\.(tsx?|jsx?)$/,
      "",
    );
    const outPath = join(
      dirname(routerFilePath),
      `${routerBasename}.named-routes.gen.ts`,
    );
    const existing = existsSync(outPath)
      ? readFileSync(outPath, "utf-8")
      : null;

    // When the static parser can't extract routes (e.g. callback-style urls()),
    // write an empty placeholder so the build-time transform's injected import
    // resolves. Runtime discovery will overwrite this with the real routes.
    if (Object.keys(result.routes).length === 0) {
      if (!existing) {
        const emptySource = generateRouteTypesSource({});
        writeFileSync(outPath, emptySource);
      }
      continue;
    }

    const hasSearchSchemas = Object.keys(result.searchSchemas).length > 0;
    const source = generateRouteTypesSource(
      result.routes,
      hasSearchSchemas ? result.searchSchemas : undefined,
    );
    if (existing !== source) {
      // On initial dev startup, don't overwrite a file from runtime discovery
      // (which has all dynamic routes) with a smaller set from the static
      // parser. The static parser can't see routes generated by Array.from()
      // or other dynamic code. During HMR (file watcher), always write so
      // newly added routes appear immediately.
      if (opts?.preserveIfLarger && existing) {
        const existingCount = (
          existing.match(/^\s+["a-zA-Z_$][^:]*:\s*["{]/gm) || []
        ).length;
        const newCount = Object.keys(result.routes).length;
        if (existingCount > newCount) {
          continue;
        }
      }
      writeFileSync(outPath, source);
      console.log(
        `[rsc-router] Generated route types (${Object.keys(result.routes).length} routes) -> ${outPath}`,
      );
    }
  }
}
