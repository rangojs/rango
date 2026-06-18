import { parseAst } from "vite";

/**
 * Detect a leading `"use client"` (or `'use client'`) directive in a module's
 * directive prologue, tolerating leading comments/whitespace before it.
 *
 * A bare `source.trimStart().startsWith` check only strips whitespace, so a
 * license banner / `// @ts-nocheck` before the directive would be missed. This
 * walks the leading ExpressionStatement string-literal directives via the AST
 * (a leading comment is not a `program.body` node), the single source of truth
 * shared by both the rango plugin's HMR client-module sniff and the version
 * plugin's getClientModuleSignature — so the two can never drift on what counts
 * as a client module.
 *
 * Returns false when the source cannot be parsed (a syntactically broken file is
 * not treated as a client module).
 */
export function hasUseClientDirective(source: string): boolean {
  let program: { body?: any[] };
  try {
    program = parseAst(source, { lang: "tsx" }) as { body?: any[] };
  } catch {
    return false;
  }
  for (const node of program.body ?? []) {
    if (
      node?.type === "ExpressionStatement" &&
      node.expression?.type === "Literal" &&
      typeof node.expression.value === "string"
    ) {
      if (node.expression.value === "use client") return true;
      // Another leading string-literal directive (e.g. "use strict"): keep
      // scanning the prologue.
      continue;
    }
    // First non-directive statement ends the prologue.
    break;
  }
  return false;
}
