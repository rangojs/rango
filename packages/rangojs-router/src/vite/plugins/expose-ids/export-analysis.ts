import { parseAst } from "vite";
import {
  findMatchingParen,
  countArgs,
  findStatementEnd,
  buildExportMap,
  escapeRegExp,
  findCallParenAfterGenerics,
} from "../expose-id-utils.js";
import { codeMatchIndices } from "../../../build/route-types/source-scan.js";
import type { CreateExportBinding } from "./types.js";

export function isExportOnlyFile(
  code: string,
  bindings: CreateExportBinding[],
): boolean {
  if (bindings.length === 0) return false;

  const knownLocals = new Set<string>();
  const knownExports = new Set<string>();
  for (const b of bindings) {
    knownLocals.add(b.localName);
    for (const e of b.exportNames) knownExports.add(e);
  }

  if (/export\s*\*/.test(code)) return false;

  const declExportPattern =
    /export\s+(const|let|var|function|class|default)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = declExportPattern.exec(code)) !== null) {
    if (!knownExports.has(match[2])) return false;
  }

  const specExportPattern = /export\s*\{([^}]+)\}/g;
  while ((match = specExportPattern.exec(code)) !== null) {
    const specifiers = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of specifiers) {
      const m = spec.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!m) continue;
      const local = m[1];
      if (!knownLocals.has(local)) return false;
    }
  }

  return true;
}

// Matches the callee identifier only. The optional generic argument list
// (which may be nested, e.g. createLoader<A<B>>(...)) and the call paren are
// resolved per match via findCallParenAfterGenerics, so a nested `>` no longer
// defeats the scan the way `<[^>]*>` did (it stopped at the first `>`).
function createCallPattern(fnNames: string[]): RegExp {
  return new RegExp(`\\b(?:${fnNames.map(escapeRegExp).join("|")})\\b`, "g");
}

/**
 * Byte offsets of every create*-call site in real code: a callee-identifier
 * match that is actually followed by a call `(` (after an optional nested
 * generic list). Non-call references (type positions, the import specifier
 * itself) yield -1 from findCallParenAfterGenerics and are dropped.
 */
function createCallStartIndices(code: string, fnNames: string[]): number[] {
  return codeMatchIndices(code, createCallPattern(fnNames)).filter(
    (index) =>
      findCallParenAfterGenerics(
        code,
        index + matchedNameLength(code, index),
      ) !== -1,
  );
}

// Length of the identifier match at `index` (run of identifier chars).
function matchedNameLength(code: string, index: number): number {
  let i = index;
  while (i < code.length && /[A-Za-z0-9_$]/.test(code[i])) i++;
  return i - index;
}

export function countCreateCallsForNames(
  code: string,
  fnNames: string[],
): number {
  return createCallStartIndices(code, fnNames).length;
}

export function offsetToLineColumn(
  code: string,
  index: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(index, code.length);
  for (let i = 0; i < end; i++) {
    if (code[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

export function findUnsupportedCreateCallSites(
  code: string,
  fnNames: string[],
  supportedBindings: CreateExportBinding[],
): Array<{ line: number; column: number }> {
  const supported = new Set(supportedBindings.map((b) => b.callExprStart));
  return createCallStartIndices(code, fnNames)
    .filter((index) => !supported.has(index))
    .map((index) => offsetToLineColumn(code, index));
}

export function getImportedFnNames(
  code: string,
  importedName: string,
): string[] {
  const importPattern =
    /import\s*\{([^}]*)\}\s*from\s*["']@rangojs\/router(?:\/[^"']*)?["']/g;

  const localNames = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(code)) !== null) {
    const specList = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const spec of specList) {
      const m = spec.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!m) continue;
      const imported = m[1];
      const local = m[2] || imported;
      if (imported === importedName) {
        localNames.add(local);
      }
    }
  }

  const names = Array.from(localNames);
  return names.length > 0 ? names : [importedName];
}

export function getCalledIdentifierFromCall(callExpr: any): string | null {
  const callee = callExpr?.callee;
  if (callee?.type === "Identifier") return callee.name;
  if (
    callee?.type === "TSInstantiationExpression" &&
    callee.expression?.type === "Identifier"
  ) {
    return callee.expression.name;
  }
  return null;
}

function unwrapSignatureWrappedCall(init: any, fnNameSet: Set<string>): any {
  if (init?.type !== "CallExpression") return init;
  const directId = getCalledIdentifierFromCall(init);
  if (directId && fnNameSet.has(directId)) return init;
  const firstArg = init.arguments?.[0];
  if (firstArg?.type === "CallExpression") {
    const innerId = getCalledIdentifierFromCall(firstArg);
    if (innerId && fnNameSet.has(innerId)) return firstArg;
  }
  return init;
}

export function collectCreateExportBindingsFallback(
  code: string,
  fnNames: string[],
): CreateExportBinding[] {
  const alternation = fnNames.map(escapeRegExp).join("|");
  const exportConstPattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(?:${alternation})\\s*(?:<[^>]*>)?\\s*\\(`,
    "g",
  );
  const localDeclPattern = new RegExp(
    `\\bconst\\s+(\\w+)\\s*=\\s*((?:${alternation})\\s*(?:<[^>]*>)?\\s*\\()`,
    "g",
  );
  const exportSpecPattern = /export\s*\{([^}]+)\}/g;

  const exportMap = new Map<string, string[]>();
  const pushExport = (local: string, exported: string) => {
    const list = exportMap.get(local);
    if (list) {
      if (!list.includes(exported)) list.push(exported);
      return;
    }
    exportMap.set(local, [exported]);
  };

  let match: RegExpExecArray | null;
  while ((match = exportConstPattern.exec(code)) !== null) {
    pushExport(match[1], match[1]);
  }

  while ((match = exportSpecPattern.exec(code)) !== null) {
    const specifiers = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const specifier of specifiers) {
      const specMatch = specifier.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );
      if (!specMatch) continue;
      const local = specMatch[1];
      const exported = specMatch[2] || local;
      pushExport(local, exported);
    }
  }

  const bindings: CreateExportBinding[] = [];
  while ((match = localDeclPattern.exec(code)) !== null) {
    const localName = match[1];
    const exportNames = exportMap.get(localName) ?? [];
    if (exportNames.length === 0) continue;

    const openParenPos = match.index + match[0].length - 1;
    const closeParenPos = findMatchingParen(code, openParenPos + 1) - 1;
    if (closeParenPos <= openParenPos) continue;

    bindings.push({
      localName,
      exportNames,
      callExprStart: match.index + match[0].length - match[2].length,
      callOpenParenPos: openParenPos,
      callCloseParenPos: closeParenPos,
      argCount: countArgs(code, openParenPos + 1, closeParenPos),
      statementEnd: findStatementEnd(code, closeParenPos + 1),
    });
  }

  return bindings;
}

export function collectCreateExportBindings(
  code: string,
  fnNames: string[],
  program?: any,
): CreateExportBinding[] {
  if (!program) {
    try {
      program = parseAst(code, { lang: "tsx" });
    } catch {
      return collectCreateExportBindingsFallback(code, fnNames);
    }
  }

  const exportMap = buildExportMap(program);
  const fnNameSet = new Set(fnNames);
  const bindings: CreateExportBinding[] = [];

  const collectFromVarDecl = (varDecl: any, statementEnd: number) => {
    if (varDecl?.type !== "VariableDeclaration" || varDecl.kind !== "const") {
      return;
    }

    for (const decl of varDecl.declarations ?? []) {
      // Unwrap a Fast Refresh signature wrapper (`_s(createLoader(...), ...)`)
      // so injection targets the inner create* call. Falls back to decl.init.
      const callExpr = unwrapSignatureWrappedCall(decl?.init, fnNameSet);
      const calledIdentifier = getCalledIdentifierFromCall(callExpr);
      if (
        decl?.id?.type !== "Identifier" ||
        callExpr?.type !== "CallExpression" ||
        !calledIdentifier ||
        !fnNameSet.has(calledIdentifier)
      ) {
        continue;
      }

      const localName = decl.id.name;
      const exportNames = exportMap.get(localName) ?? [];
      if (exportNames.length === 0) continue;

      const callEnd = callExpr.end as number;
      const calleeEnd = callExpr.callee.end as number;

      let openParenPos = -1;
      for (let i = calleeEnd; i < callEnd; i++) {
        if (code[i] === "(") {
          openParenPos = i;
          break;
        }
      }
      if (openParenPos === -1) continue;

      const closeParenPos = findMatchingParen(code, openParenPos + 1) - 1;
      if (closeParenPos <= openParenPos) continue;

      bindings.push({
        localName,
        exportNames,
        callExprStart: callExpr.start as number,
        callOpenParenPos: openParenPos,
        callCloseParenPos: closeParenPos,
        argCount: callExpr.arguments?.length ?? 0,
        statementEnd,
      });
    }
  };

  for (const node of program.body ?? []) {
    if (node?.type === "VariableDeclaration") {
      collectFromVarDecl(node, node.end as number);
      continue;
    }

    if (
      node?.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration"
    ) {
      collectFromVarDecl(node.declaration, node.end as number);
    }
  }

  if (bindings.length === 0) {
    return collectCreateExportBindingsFallback(code, fnNames);
  }

  return bindings;
}

export function buildUnsupportedShapeWarning(
  filePath: string,
  fnName: string,
  sites: Array<{ line: number; column: number }> = [],
): string {
  const lines = [`[rango] Unsupported ${fnName} shape in "${filePath}".`];

  if (sites.length === 1) {
    const s = sites[0];
    lines.push(
      `The ${fnName}(...) call at ${filePath}:${s.line}:${s.column} has no stable $$id injected — it is not in a supported shape.`,
    );
  } else if (sites.length > 1) {
    lines.push(
      `These ${fnName}(...) calls have no stable $$id injected — they are not in a supported shape:`,
    );
    for (const s of sites) lines.push(`  - ${filePath}:${s.line}:${s.column}`);
  }

  lines.push(
    `Supported shapes are:`,
    `  - export const X = ${fnName}(...)`,
    `  - const X = ${fnName}(...); export { X }`,
    `  - const X = ${fnName}(...); export { X as Y }`,
    `Potentially unsupported forms include:`,
    `  - export let/var X = ${fnName}(...)`,
    `  - inline ${fnName}(...) calls`,
  );
  return lines.join("\n");
}
