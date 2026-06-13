import type MagicString from "magic-string";
import { makeStubId } from "../expose-id-utils.js";
import type { CreateExportBinding } from "./types.js";
import { isExportOnlyFile } from "./export-analysis.js";

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

    const paramInjection =
      binding.argCount === 1 ? `, undefined, "${loaderId}"` : `, "${loaderId}"`;
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${loaderId}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}
