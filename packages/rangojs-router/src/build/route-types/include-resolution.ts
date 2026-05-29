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
 * Extract include() calls with diagnostics for unresolvable ones.
 * Returns both resolved includes (identifier second args) and unresolvable
 * includes (factory calls, etc.) with reasons.
 */
export function extractIncludesWithDiagnostics(code: string): {
  resolved: Array<{
    pathPrefix: string;
    variableName: string;
    namePrefix: string | null;
  }>;
  unresolvable: Array<{
    pathPrefix: string;
    namePrefix: string | null;
    reason: UnresolvableReason;
    detail: string;
  }>;
} {
  const sourceFile = ts.createSourceFile(
    "input.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const resolved: Array<{
    pathPrefix: string;
    variableName: string;
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

        if (ts.isIdentifier(secondArg)) {
          resolved.push({
            pathPrefix,
            variableName: secondArg.text,
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
  const importRegex = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
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
): string | null {
  const sourceFile = ts.createSourceFile(
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

function buildRouteMapFromBlock(
  block: string,
  fullSource: string,
  filePath: string,
  visited: Set<string>,
  searchSchemasOut?: Record<string, Record<string, string>>,
  diagnosticsOut?: UnresolvableInclude[],
): Record<string, string> {
  const routeMap: Record<string, string> = {};

  // Extract local path() routes
  const localRoutes = extractRoutesFromSource(block);
  for (const { name, pattern, search } of localRoutes) {
    routeMap[name] = pattern;
    if (search && searchSchemasOut) {
      searchSchemasOut[name] = search;
    }
  }

  // Extract include() calls with diagnostics for unresolvable ones
  const { resolved: includes, unresolvable } =
    extractIncludesWithDiagnostics(block);

  if (diagnosticsOut) {
    for (const entry of unresolvable) {
      diagnosticsOut.push({ ...entry, sourceFile: filePath });
    }
  }

  for (const { pathPrefix, variableName, namePrefix } of includes) {
    let childResult: {
      routes: Record<string, string>;
      searchSchemas: Record<string, Record<string, string>>;
    };

    // Try import resolution first
    const imported = resolveImportedVariable(fullSource, variableName);
    if (imported) {
      const targetFile = resolveImportPath(imported.specifier, filePath);
      if (!targetFile) {
        if (diagnosticsOut) {
          diagnosticsOut.push({
            pathPrefix,
            namePrefix,
            reason: "file-not-found",
            sourceFile: filePath,
            detail: `import "${imported.specifier}" resolved to no file`,
          });
        }
        continue;
      }
      childResult = buildCombinedRouteMapWithSearch(
        targetFile,
        imported.exportedName,
        visited,
        diagnosticsOut,
      );
    } else {
      // Check if variable exists as a same-file urls() definition
      const sameFileBlock = extractUrlsBlockForVariable(
        fullSource,
        variableName,
      );
      if (!sameFileBlock) {
        if (diagnosticsOut) {
          diagnosticsOut.push({
            pathPrefix,
            namePrefix,
            reason: "unresolvable-import",
            sourceFile: filePath,
            detail: `variable "${variableName}" not found in imports or same-file scope`,
          });
        }
        continue;
      }
      childResult = buildCombinedRouteMapWithSearch(
        filePath,
        variableName,
        visited,
        diagnosticsOut,
      );
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
    }
  }

  return routeMap;
}

/**
 * Build route map and search schemas together.
 * Internal helper used by the include resolution path.
 *
 * @param inlineBlock - Optional pre-extracted code block (e.g. from an inline
 *   builder function). When provided, variableName is ignored and the block
 *   is parsed directly for path()/include() calls.
 */
export function buildCombinedRouteMapWithSearch(
  filePath: string,
  variableName?: string,
  visited?: Set<string>,
  diagnosticsOut?: UnresolvableInclude[],
  inlineBlock?: string,
): {
  routes: Record<string, string>;
  searchSchemas: Record<string, Record<string, string>>;
} {
  visited = visited ?? new Set();
  const realPath = resolve(filePath);
  const key = variableName ? `${realPath}:${variableName}` : realPath;
  if (visited.has(key)) {
    console.warn(`[rango] Circular include detected, skipping: ${key}`);
    return { routes: {}, searchSchemas: {} };
  }
  visited.add(key);

  let source: string;
  try {
    source = readFileSync(realPath, "utf-8");
  } catch {
    return { routes: {}, searchSchemas: {} };
  }

  let block: string;
  if (inlineBlock) {
    block = inlineBlock;
  } else if (variableName) {
    const extracted = extractUrlsBlockForVariable(source, variableName);
    if (!extracted) return { routes: {}, searchSchemas: {} };
    block = extracted;
  } else {
    block = source;
  }

  const searchSchemas: Record<string, Record<string, string>> = {};
  const routes = buildRouteMapFromBlock(
    block,
    source,
    realPath,
    visited,
    searchSchemas,
    diagnosticsOut,
  );

  // Remove from visited so sibling branches can include the same variable
  // without false circular-include detection. Only ancestors in the current
  // recursion path should trigger the cycle guard.
  visited.delete(key);

  return { routes, searchSchemas };
}
