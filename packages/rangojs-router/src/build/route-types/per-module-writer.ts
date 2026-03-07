import { readFileSync, writeFileSync, existsSync } from "node:fs";
import ts from "typescript";
import { extractParamsFromPattern } from "./param-extraction.js";
import { extractRoutesFromSource } from "./ast-route-extraction.js";
import { generatePerModuleTypesSource } from "./codegen.js";
import { buildCombinedRouteMapWithSearch } from "./include-resolution.js";
import type { ScanFilter } from "./scan-filter.js";
import { findTsFiles } from "./scan-filter.js";

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
 * e.g. `export const patterns = urls(...)` -> ["patterns"]
 */
export function findUrlsVariableNames(code: string): string[] {
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

    const genPath = filePath.replace(/\.(tsx?)$/, ".gen.ts");

    // When a urls() variable was found but static resolution yields zero
    // routes, write an empty placeholder so generated imports stay
    // resolvable until runtime discovery fills them in.
    if (routes.length === 0) {
      if (varNames.length > 0 && !existsSync(genPath)) {
        writeFileSync(genPath, generatePerModuleTypesSource([]));
        console.log(
          `[rsc-router] Generated route types (placeholder) -> ${genPath}`,
        );
      }
      return;
    }

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
