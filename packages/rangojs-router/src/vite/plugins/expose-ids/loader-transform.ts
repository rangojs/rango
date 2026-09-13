import type MagicString from "magic-string";
import { makeStubId } from "../expose-id-utils.js";
import type { CreateExportBinding } from "./types.js";
import { hasDirective } from "@vitejs/plugin-rsc/transforms";
import { isExportOnlyFile, offsetToLineColumn } from "./export-analysis.js";

export function hasCreateLoaderImport(code: string): boolean {
  return /import\s*\{[^}]*\bcreateLoader\b[^}]*\}\s*from\s*["']@rangojs\/router(?:\/server)?["']/.test(
    code,
  );
}

export function generateClientLoaderStubs(
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map?: undefined } | null {
  if (!isExportOnlyFile(code, bindings)) return null;

  const lines: string[] = [];

  for (const binding of bindings) {
    // Aliases share the primary export's id (matches the server side, which
    // registers only exportNames[0] in the loader registry, and the mixed-type
    // whole-file path). Emitting a distinct makeStubId per alias would make a
    // client component importing the alias fetch an id absent from the server
    // registry, so the fetchable-loader request would 404.
    const primaryName = binding.exportNames[0];
    const loaderId = makeStubId(filePath, primaryName, isBuild);
    lines.push(
      `export const ${primaryName} = { __brand: "loader", $$id: "${loaderId}" };`,
    );
    for (const alias of binding.exportNames.slice(1)) {
      lines.push(`export const ${alias} = ${primaryName};`);
    }
  }

  return { code: lines.join("\n") + "\n" };
}

export function transformLoaders(
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;

  for (const binding of bindings) {
    const exportName = binding.exportNames[0];

    const loaderId = makeStubId(filePath, exportName, isBuild);

    const paramInjection =
      binding.argCount === 1 ? `, undefined, "${loaderId}"` : `, "${loaderId}"`;
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${loaderId}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

export interface LoaderServerDirective {
  line: number;
}

function loaderCallback(node: any, names: Set<string>): any {
  if (
    node?.type !== "CallExpression" ||
    node.callee?.type !== "Identifier" ||
    !names.has(node.callee.name)
  ) {
    return undefined;
  }
  const fn = node.arguments?.[0];
  return (fn?.type === "ArrowFunctionExpression" ||
    fn?.type === "FunctionExpression") &&
    fn.body?.type === "BlockStatement"
    ? fn
    : undefined;
}

/**
 * Locate an inline `"use server"` directive at the top of a createLoader()
 * callback body. Only top-level `const X = createLoader(...)` bindings (bare
 * or exported) are checked — the same shapes the loader transform registers.
 * Loaders are never client-callable, and the directive makes plugin-rsc
 * hoist the body and `registerServerReference` it, so the loader body
 * becomes a public action reachable with caller-supplied arguments (verified
 * against a production build: a POST to `?_rsc_action=<id>` ran a loader body
 * with a forged ctx). The guard plugin throws on the first hit.
 */
export function findLoaderServerDirective(
  code: string,
  fnNames: readonly string[],
  program: any,
): LoaderServerDirective | null {
  const names = new Set(fnNames);
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      const fn = loaderCallback(declarator.init, names);
      if (fn && hasDirective(fn.body.body, "use server")) {
        return { line: offsetToLineColumn(code, fn.body.body[0].start).line };
      }
    }
  }
  return null;
}
