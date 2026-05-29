import type MagicString from "magic-string";
import { makeStubId } from "../expose-id-utils.js";
import type { CreateExportBinding } from "./types.js";
import { isExportOnlyFile } from "./export-analysis.js";

export function hasCreateLoaderImport(code: string): boolean {
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
export function generateClientLoaderStubs(
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map?: undefined } | null {
  if (!isExportOnlyFile(code, bindings)) return null;

  const lines: string[] = [];

  for (const binding of bindings) {
    for (const name of binding.exportNames) {
      const loaderId = makeStubId(filePath, name, isBuild);
      lines.push(
        `export const ${name} = { __brand: "loader", $$id: "${loaderId}" };`,
      );
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

    // Inject $$id as hidden third parameter.
    // createLoader(fn) -> createLoader(fn, undefined, "id")
    // createLoader(fn, true) -> createLoader(fn, true, "id")
    const paramInjection =
      binding.argCount === 1 ? `, undefined, "${loaderId}"` : `, "${loaderId}"`;
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${loaderId}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}
