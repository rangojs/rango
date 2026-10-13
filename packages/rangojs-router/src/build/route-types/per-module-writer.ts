import { readFileSync, writeFileSync, existsSync } from "node:fs";
import ts from "typescript";
import { extractParamsFromPattern } from "./param-extraction.js";
import { extractRoutesFromSource } from "./ast-route-extraction.js";
import { generatePerModuleTypesSource } from "./codegen.js";
import {
  buildCombinedRouteMapWithSearch,
  createScanMemo,
} from "./include-resolution.js";
import type { ScanFilter } from "./scan-filter.js";
import { findTsFiles } from "./scan-filter.js";

/**
 * Generate per-module route type files by statically parsing url module source.
 * Scans for files containing `urls(` or `clientUrls(` and writes a sibling
 * `.gen.ts` with the extracted route name/pattern pairs. Only writes when
 * content has changed.
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
 * Find all variable names assigned to urls() or clientUrls() calls in source.
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
      if (
        ts.isIdentifier(callee) &&
        (callee.text === "urls" || callee.text === "clientUrls")
      ) {
        names.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

export interface PerModuleRouteTypesPlan {
  genPath: string;
  /** A urls()/clientUrls() variable resolved to zero routes; content is empty. */
  isPlaceholder: boolean;
  content: string;
}

/**
 * Pure half of the per-module writer: reads sources, never writes. Returns
 * null when the file has no `urls(`/`clientUrls(` or no named routes and no
 * urls() variable. Throws on failure.
 */
export function planPerModuleRouteTypesForFile(
  filePath: string,
): PerModuleRouteTypesPlan | null {
  const source = readFileSync(filePath, "utf-8");
  if (!source.includes("urls(") && !source.includes("clientUrls(")) return null;

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
    // Share one per-file scan memo across all urls() variables so a shared
    // include target is read+parsed once for this file, not once per variable.
    routes = [];
    const memo = createScanMemo();
    for (const varName of varNames) {
      const { routes: routeMap, searchSchemas } =
        buildCombinedRouteMapWithSearch(
          filePath,
          varName,
          undefined,
          undefined,
          undefined,
          memo,
        );
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

  // Match .ts/.tsx/.js/.jsx (same as router-processing.ts / router-transform.ts).
  // Without the jsx? branch a .jsx/.js source produced genPath === filePath,
  // overwriting the source file instead of writing a sibling .gen.ts.
  const genPath = filePath.replace(/\.(tsx?|jsx?)$/, ".gen.ts");

  if (routes.length === 0) {
    if (varNames.length === 0) return null;
    return {
      genPath,
      isPlaceholder: true,
      content: generatePerModuleTypesSource([]),
    };
  }
  return {
    genPath,
    isPlaceholder: false,
    content: generatePerModuleTypesSource(routes),
  };
}

/**
 * Generate per-module route types for a single url module file.
 * Follows include() calls recursively to produce the full route tree.
 * No-ops if the file doesn't contain `urls(`/`clientUrls(` or has no named
 * routes.
 */
export function writePerModuleRouteTypesForFile(filePath: string): void {
  try {
    const plan = planPerModuleRouteTypesForFile(filePath);
    if (!plan) return;
    const { genPath, isPlaceholder, content } = plan;
    const exists = existsSync(genPath);

    // A urls() variable whose static resolution yields zero routes gets an
    // empty placeholder so an import of the sibling .gen.ts resolves. Nothing
    // fills it in later: runtime discovery writes only *.named-routes.gen.ts
    // (runtime-discovery.ts), so it stays `routes = {}` until a static run can
    // resolve the module's includes and overwrites it.
    if (isPlaceholder) {
      if (!exists) {
        writeFileSync(genPath, content);
        console.log(
          `[rango] Generated route types (placeholder) -> ${genPath}`,
        );
      }
      return;
    }

    if (!exists || readFileSync(genPath, "utf-8") !== content) {
      writeFileSync(genPath, content);
      console.log(`[rango] Generated route types -> ${genPath}`);
    }
  } catch (err) {
    console.warn(
      `[rango] Failed to generate route types for ${filePath}: ${(err as Error).message}`,
    );
  }
}
