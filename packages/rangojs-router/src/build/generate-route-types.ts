import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import {
  join,
  dirname,
  resolve,
  relative,
  basename as pathBasename,
} from "node:path";
// @ts-ignore -- picomatch ships no .d.ts; types are trivial
import picomatch from "picomatch";
import ts from "typescript";

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
// AST helpers
// ---------------------------------------------------------------------------

function getStringValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function extractObjectStringProperties(
  node: ts.ObjectLiteralExpression,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (!key) continue;
    const val = getStringValue(prop.initializer);
    if (val !== null) result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Param extraction from route patterns
// ---------------------------------------------------------------------------

/**
 * Extract typed params from a route pattern string.
 * Matches `:paramName` and `:paramName?` (optional).
 * Custom regex constraints like `:id(\d+)` are ignored for type purposes.
 */
export function extractParamsFromPattern(
  pattern: string,
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  const regex = /:([a-zA-Z_$][\w$]*)(?:\([^)]+\))?(\?)?/g;
  let match;
  while ((match = regex.exec(pattern)) !== null) {
    params[match[1]!] = match[2] ? "string?" : "string";
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

// ---------------------------------------------------------------------------
// Shared route entry formatter
// ---------------------------------------------------------------------------

/**
 * Format a single route entry for codegen output.
 * Routes without search remain plain strings (params are extracted from
 * the pattern at the type level by ExtractParams).
 * Routes with search become objects with path and search fields.
 */
export function formatRouteEntry(
  key: string,
  pattern: string,
  _params?: Record<string, string>,
  search?: Record<string, string>,
): string {
  const hasSearch = search && Object.keys(search).length > 0;

  if (!hasSearch) {
    return `  ${key}: "${pattern}",`;
  }

  const searchBody = Object.entries(search!)
    .map(([k, v]) => `${k}: "${v}"`)
    .join(", ");
  return `  ${key}: { path: "${pattern}", search: { ${searchBody} } },`;
}

// ---------------------------------------------------------------------------
// AST-based route extraction
// ---------------------------------------------------------------------------

/**
 * Extract route definitions from source code by walking the TypeScript AST.
 * Finds path() and path.json(), path.md(), etc. call expressions and extracts
 * the pattern, name, params, and optional search schema from each.
 * Skips unnamed paths (no { name: "..." }).
 */
export function extractRoutesFromSource(code: string): Array<{
  name: string;
  pattern: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}> {
  const sourceFile = ts.createSourceFile(
    "input.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const routes: Array<{
    name: string;
    pattern: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }> = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isPath =
        (ts.isIdentifier(callee) && callee.text === "path") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "path");

      if (isPath && node.arguments.length >= 1) {
        const route = extractRouteFromCallExpression(node);
        if (route) routes.push(route);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes;
}

function extractRouteFromCallExpression(node: ts.CallExpression): {
  name: string;
  pattern: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
} | null {
  const patternNode = node.arguments[0];
  const pattern = getStringValue(patternNode);
  if (pattern === null) return null;

  let name: string | null = null;
  let search: Record<string, string> | undefined;

  for (let i = 1; i < node.arguments.length; i++) {
    const arg = node.arguments[i];
    if (ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;
        if (propName === "name") {
          name = getStringValue(prop.initializer);
        } else if (
          propName === "search" &&
          ts.isObjectLiteralExpression(prop.initializer)
        ) {
          search = extractObjectStringProperties(prop.initializer);
        }
      }
    }
  }

  if (!name) return null;
  const params = extractParamsFromPattern(pattern);
  return {
    name,
    pattern,
    ...(params ? { params } : {}),
    ...(search && Object.keys(search).length > 0 ? { search } : {}),
  };
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * Generate a per-module types file from extracted routes.
 * Output has zero imports, preventing circular references.
 */
export function generatePerModuleTypesSource(
  routes: Array<{
    name: string;
    pattern: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }>,
): string {
  const valid = routes.filter(({ name }) => {
    if (!name || /["'\\`\n\r]/.test(name)) {
      console.warn(
        `[rsc-router] Skipping route with invalid name: ${JSON.stringify(name)}`,
      );
      return false;
    }
    return true;
  });

  // Deduplicate by name (first definition wins — primary route before variants)
  const deduped = new Map<
    string,
    {
      pattern: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
    }
  >();
  for (const { name, pattern, params, search } of valid) {
    if (deduped.has(name)) {
      console.warn(
        `[rsc-router] Duplicate route name "${name}" — keeping first definition`,
      );
      continue;
    }
    deduped.set(name, { pattern, params, search });
  }
  const sorted = [...deduped.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = sorted
    .map(([name, { pattern, params, search }]) => {
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : `"${name}"`;
      return formatRouteEntry(key, pattern, params, search);
    })
    .join("\n");
  return `// Auto-generated by @rangojs/router - do not edit\nexport const routes = {\n${body}\n} as const;\nexport type routes = typeof routes;\n`;
}

/**
 * Generates a .ts file that augments RSCRouter.GeneratedRouteMap
 * with route name -> pattern mappings. This enables Handler<"routeName">
 * without circular references since the file has no imports from the app.
 */
export function generateRouteTypesSource(
  routeManifest: Record<string, string>,
  searchSchemas?: Record<string, Record<string, string>>,
): string {
  const entries = Object.entries(routeManifest).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const objectBody = entries
    .map(([name, pattern]) => {
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : `"${name}"`;
      const params = extractParamsFromPattern(pattern);
      const search = searchSchemas?.[name];
      return formatRouteEntry(key, pattern, params, search);
    })
    .join("\n");

  return `// Auto-generated by @rangojs/router - do not edit
export const NamedRoutes = {
${objectBody}
} as const;

declare global {
  namespace RSCRouter {
    interface GeneratedRouteMap extends Readonly<typeof NamedRoutes> {}
  }
}
`;
}

/** Default exclude patterns for route type scanning. */
export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/dist/**",
  "**/coverage/**",
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
];

export type ScanFilter = (absolutePath: string) => boolean;

/**
 * Compile include/exclude glob patterns into a single predicate.
 * Paths are made root-relative before matching.
 * Returns undefined when no filtering is needed (no include, default exclude).
 */
export function createScanFilter(
  root: string,
  opts: { include?: string[]; exclude?: string[] },
): ScanFilter | undefined {
  const { include, exclude } = opts;
  const hasInclude = include && include.length > 0;
  const hasCustomExclude = exclude !== undefined;

  if (!hasInclude && !hasCustomExclude) return undefined;

  const effectiveExclude = exclude ?? DEFAULT_EXCLUDE_PATTERNS;
  const includeMatcher = hasInclude ? picomatch(include) : null;
  const excludeMatcher =
    effectiveExclude.length > 0 ? picomatch(effectiveExclude) : null;

  return (absolutePath: string) => {
    const rel = relative(root, absolutePath);
    if (excludeMatcher && excludeMatcher(rel)) return false;
    if (includeMatcher) return includeMatcher(rel);
    return true;
  };
}

/**
 * Recursively find .ts/.tsx files under a directory, skipping node_modules
 * and .gen. files.
 */
export function findTsFiles(dir: string, filter?: ScanFilter): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(
      `[rsc-router] Failed to scan directory ${dir}: ${(err as Error).message}`,
    );
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      results.push(...findTsFiles(fullPath, filter));
    } else if (
      (entry.name.endsWith(".ts") ||
        entry.name.endsWith(".tsx") ||
        entry.name.endsWith(".js") ||
        entry.name.endsWith(".jsx")) &&
      !entry.name.includes(".gen.")
    ) {
      if (filter && !filter(fullPath)) continue;
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Generate per-module route type files by statically parsing url module source.
 * Scans for files containing `urls(` and writes a sibling `.gen.ts` with the
 * extracted route name/pattern pairs. Only writes when content has changed.
 */
export function writePerModuleRouteTypes(
  root: string,
  filter?: ScanFilter,
): void {
  const files = findTsFiles(root, filter);
  for (const filePath of files) {
    writePerModuleRouteTypesForFile(filePath);
  }
}

/**
 * Find all variable names assigned to urls() calls in source code.
 * e.g. `export const patterns = urls(...)` → ["patterns"]
 */
function findUrlsVariableNames(code: string): string[] {
  const sourceFile = ts.createSourceFile(
    "input.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names: string[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && callee.text === "urls") {
        names.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

/**
 * Generate per-module route types for a single url module file.
 * Follows include() calls recursively to produce the full route tree.
 * No-ops if the file doesn't contain `urls(` or has no named routes.
 */
export function writePerModuleRouteTypesForFile(filePath: string): void {
  try {
    const source = readFileSync(filePath, "utf-8");
    if (!source.includes("urls(")) return;

    const varNames = findUrlsVariableNames(source);

    type Route = {
      name: string;
      pattern: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
    };
    let routes: Route[];

    if (varNames.length > 0) {
      // Follow includes recursively via the combined route map builder.
      // The visited set in buildCombinedRouteMapWithSearch prevents infinite loops.
      routes = [];
      for (const varName of varNames) {
        const { routes: routeMap, searchSchemas } =
          buildCombinedRouteMapWithSearch(filePath, varName);
        for (const [name, pattern] of Object.entries(routeMap)) {
          const params = extractParamsFromPattern(pattern);
          routes.push({
            name,
            pattern,
            ...(params ? { params } : {}),
            ...(searchSchemas[name] ? { search: searchSchemas[name] } : {}),
          });
        }
      }
    } else {
      // Fallback: no urls() variable found, extract path() calls directly
      routes = extractRoutesFromSource(source);
    }

    if (routes.length === 0) return;

    const genPath = filePath.replace(/\.(tsx?)$/, ".gen.ts");
    const genSource = generatePerModuleTypesSource(routes);
    const existing = existsSync(genPath)
      ? readFileSync(genPath, "utf-8")
      : null;
    if (existing !== genSource) {
      writeFileSync(genPath, genSource);
      console.log(`[rsc-router] Generated route types -> ${genPath}`);
    }
  } catch (err) {
    console.warn(
      `[rsc-router] Failed to generate route types for ${filePath}: ${(err as Error).message}`,
    );
  }
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
function resolveImportedVariable(
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
function resolveImportPath(
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
 */
function buildCombinedRouteMapWithSearch(
  filePath: string,
  variableName?: string,
  visited?: Set<string>,
  diagnosticsOut?: UnresolvableInclude[],
): {
  routes: Record<string, string>;
  searchSchemas: Record<string, Record<string, string>>;
} {
  visited = visited ?? new Set();
  const realPath = resolve(filePath);
  const key = variableName ? `${realPath}:${variableName}` : realPath;
  if (visited.has(key)) {
    console.warn(`[rsc-router] Circular include detected, skipping: ${key}`);
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
  if (variableName) {
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
  return { routes, searchSchemas };
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
 * Generate per-router named-routes.gen.ts files from known router file paths.
 * Re-reads each router file and resolves url patterns via static source parsing.
 *
 * Pass `knownRouterFiles` from a previous `findRouterFiles()` call to skip the
 * full directory scan. If omitted, falls back to scanning (startup path).
 */
/**
 * Write named-routes.gen.ts files from static source parsing.
 * Dev-only: provides initial .gen.ts files for IDE types before runtime
 * discovery runs. Must NOT be called during production builds — runtime
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
