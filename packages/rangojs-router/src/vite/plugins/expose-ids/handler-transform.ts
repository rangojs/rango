import MagicString from "magic-string";
import { hashId } from "../expose-id-utils.js";
import type { HandlerTransformConfig, CreateExportBinding } from "./types.js";
import { isExportOnlyFile } from "./export-analysis.js";

function analyzeCreateHandleArgs(
  code: string,
  startPos: number,
  endPos: number,
): { hasArgs: boolean } {
  const content = code.slice(startPos, endPos).trim();
  return { hasArgs: content.length > 0 };
}

export function transformHandles(
  bindings: CreateExportBinding[],
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];
    const args = analyzeCreateHandleArgs(
      code,
      binding.callOpenParenPos + 1,
      binding.callCloseParenPos,
    );

    const handleId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    let paramInjection: string;
    if (!args.hasArgs) {
      paramInjection = `undefined, "${handleId}"`;
    } else {
      paramInjection = `, "${handleId}"`;
    }
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${handleId}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

export function transformLocationState(
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];

    const stateKey = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Key is injected as a property assignment (not as a function argument).
    // This allows createLocationState to accept options like { flash: true }
    // without conflicting with key injection.
    const propInjection = `\n${binding.localName}.__rsc_ls_key = "__rsc_ls_${stateKey}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}

/**
 * Replace the entire file with lightweight stubs when ALL non-type exports are
 * handler calls of the given type. Returns null for files with mixed exports.
 */
export function generateWholeFileStubs(
  cfg: HandlerTransformConfig,
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  isBuild: boolean,
): { code: string; map: null } | null {
  if (!isExportOnlyFile(code, bindings)) return null;

  const exportNames = bindings.flatMap((b) => b.exportNames);
  const stubs = exportNames.map((name) => {
    const handlerId = isBuild ? hashId(filePath, name) : `${filePath}#${name}`;
    return `export const ${name} = { __brand: "${cfg.brand}", $$id: "${handlerId}" };`;
  });

  return { code: stubs.join("\n") + "\n", map: null };
}

/**
 * Replace handler call expressions with lightweight stub objects in non-RSC
 * environments. Other exports, imports, and module-level code remain untouched.
 */
export function generateExprStubs(
  cfg: HandlerTransformConfig,
  bindings: CreateExportBinding[],
  code: string,
  filePath: string,
  sourceId: string,
  isBuild: boolean,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (bindings.length === 0) return null;

  const s = new MagicString(code);
  let hasChanges = false;

  for (const binding of bindings) {
    const exportName = binding.exportNames[0];
    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    s.overwrite(
      binding.callExprStart,
      binding.callCloseParenPos + 1,
      `{ __brand: "${cfg.brand}", $$id: "${handlerId}" }`,
    );
    hasChanges = true;
  }

  if (!hasChanges) return null;

  return {
    code: s.toString(),
    map: s.generateMap({
      source: sourceId,
      includeContent: true,
      hires: "boundary",
    }),
  };
}

/**
 * Replace handler call expressions with lightweight stub objects on an
 * existing MagicString. Unlike generateExprStubs (which creates its own
 * MagicString and returns the full result), this integrates into the
 * unified transform pipeline so all transforms share one sourcemap.
 */
export function stubHandlerExprs(
  cfg: HandlerTransformConfig,
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];
    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    s.overwrite(
      binding.callExprStart,
      binding.callCloseParenPos + 1,
      `{ __brand: "${cfg.brand}", $$id: "${handlerId}" }`,
    );
    hasChanges = true;
  }
  return hasChanges;
}

/**
 * Inject $$id into export const handler calls in RSC environments.
 */
export function transformHandlerIds(
  cfg: HandlerTransformConfig,
  bindings: CreateExportBinding[],
  s: MagicString,
  filePath: string,
  isBuild: boolean,
): boolean {
  let hasChanges = false;
  for (const binding of bindings) {
    const exportName = binding.exportNames[0];

    const handlerId = isBuild
      ? hashId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Injection strategy matches the runtime overload signatures:
    //   0 args                              -> inject undefined, "id"
    //   1 arg  (handler)                    -> inject , undefined, "id"
    //   2+ args                             -> inject , "id"
    let paramInjection: string;
    if (binding.argCount === 0) {
      paramInjection = `undefined, "${handlerId}"`;
    } else if (binding.argCount === 1) {
      paramInjection = `, undefined, "${handlerId}"`;
    } else {
      paramInjection = `, "${handlerId}"`;
    }
    s.appendLeft(binding.callCloseParenPos, paramInjection);

    const propInjection = `\n${binding.localName}.$$id = "${handlerId}";`;
    s.appendRight(binding.statementEnd, propInjection);
    hasChanges = true;
  }

  return hasChanges;
}
