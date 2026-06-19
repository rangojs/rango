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
