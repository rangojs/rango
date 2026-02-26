import ts from "typescript";
import {
  getStringValue,
  extractObjectStringProperties,
} from "./ast-helpers.js";
import { extractParamsFromPattern } from "./param-extraction.js";

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
