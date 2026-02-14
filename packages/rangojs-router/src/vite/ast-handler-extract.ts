import type MagicString from "magic-string";
import { hashInlineId } from "./expose-id-utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal ESTree Program node — avoids importing from `rollup` (not a direct dep). */
interface ProgramNode {
  type: "Program";
  body: any[];
}

export interface HandlerCallSite {
  callStart: number;
  callEnd: number;
  argCount: number;
  lineNumber: number;
  calleeName: string;

  exportInfo: {
    exportName: string;
    statementEnd: number;
  } | null;
}

export interface VirtualHandlerEntry {
  originalModuleId: string;
  imports: string[];
  handlerCode: string;
  exportName: string;
}

function isDirectivePrologueStatement(node: any): boolean {
  return (
    node?.type === "ExpressionStatement" &&
    typeof node.directive === "string"
  );
}

/**
 * Find where generated imports should be inserted:
 * after the directive prologue and any contiguous import declarations.
 */
function findImportInsertionPos(
  code: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): number {
  let program: ProgramNode;
  try {
    program = parseAst(code, { jsx: true });
  } catch {
    return 0;
  }

  const body = program.body as any[];
  let i = 0;
  let insertionPos = 0;

  while (i < body.length && isDirectivePrologueStatement(body[i])) {
    insertionPos = body[i].end;
    i++;
  }

  while (i < body.length && body[i]?.type === "ImportDeclaration") {
    insertionPos = body[i].end;
    i++;
  }

  return insertionPos;
}

// ---------------------------------------------------------------------------
// AST walking helper
// ---------------------------------------------------------------------------

/**
 * Recursively walk an ESTree AST node, calling `enter` on each node.
 * Parent is passed for context.
 */
function walkNode(
  node: any,
  parent: any,
  ancestors: any[],
  enter: (node: any, parent: any, ancestors: any[]) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type !== "string") return;

  ancestors.push(node);
  enter(node, parent, ancestors);

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && typeof item.type === "string") {
          walkNode(item, node, ancestors, enter);
        }
      }
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walkNode(child, node, ancestors, enter);
    }
  }

  ancestors.pop();
}

// ---------------------------------------------------------------------------
// AST analysis
// ---------------------------------------------------------------------------

/**
 * Parse the file with Vite's parseAst and find all calls to `fnName`.
 * Distinguishes between `export const X = fnName(...)` (exportInfo set)
 * and inline calls like `layout(fnName(...))` (exportInfo null).
 */
export function findHandlerCalls(
  code: string,
  fnName: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): HandlerCallSite[] {
  let program: ProgramNode;
  try {
    program = parseAst(code, { jsx: true });
  } catch {
    return [];
  }

  const sites: HandlerCallSite[] = [];
  const localNames = getImportedLocalNamesFromProgram(program, fnName);
  const exportedNamesByLocal = new Map<string, string[]>();

  const addExport = (localName: string, exportedName: string) => {
    const names = exportedNamesByLocal.get(localName);
    if (names) {
      if (!names.includes(exportedName)) names.push(exportedName);
      return;
    }
    exportedNamesByLocal.set(localName, [exportedName]);
  };

  for (const node of program.body as any[]) {
    if (node?.type !== "ExportNamedDeclaration") continue;

    if (node.declaration?.type === "VariableDeclaration") {
      for (const decl of node.declaration.declarations ?? []) {
        if (decl?.id?.type === "Identifier") {
          addExport(decl.id.name, decl.id.name);
        }
      }
    }

    if (!node.source && Array.isArray(node.specifiers)) {
      for (const spec of node.specifiers) {
        if (
          spec?.type === "ExportSpecifier" &&
          spec.local?.type === "Identifier" &&
          spec.exported?.type === "Identifier"
        ) {
          addExport(spec.local.name, spec.exported.name);
        }
      }
    }
  }

  walkNode(program, null, [], (node: any, parent: any, ancestors: any[]) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "Identifier" ||
      !localNames.has(node.callee.name)
    ) {
      return;
    }

    const callStart: number = node.start;
    const callEnd: number = node.end;
    const argCount: number = node.arguments?.length ?? 0;
    const calleeName: string = node.callee.name;

    // Compute 1-based line number
    let lineNumber = 1;
    for (let i = 0; i < callStart && i < code.length; i++) {
      if (code[i] === "\n") lineNumber++;
    }

    // Check if this is an export const pattern:
    // ExportNamedDeclaration > VariableDeclaration > VariableDeclarator(init=CallExpression)
    let exportInfo: HandlerCallSite["exportInfo"] = null;

    if (parent?.type === "VariableDeclarator" && parent.init === node) {
      // ancestors: [..., ExportNamedDecl, VarDecl, VarDeclarator, CallExpr]
      const grandParent = ancestors.length >= 3 ? ancestors[ancestors.length - 3] : null;
      const greatGrandParent = ancestors.length >= 4 ? ancestors[ancestors.length - 4] : null;

      if (
        grandParent?.type === "VariableDeclaration" &&
        greatGrandParent?.type === "ExportNamedDeclaration"
      ) {
        const exportName = parent.id?.name;
        if (exportName) {
          exportInfo = {
            exportName,
            statementEnd: greatGrandParent.end,
          };
        }
      } else if (
        grandParent?.type === "VariableDeclaration" &&
        parent.id?.type === "Identifier"
      ) {
        const exportedNames = exportedNamesByLocal.get(parent.id.name);
        if (exportedNames && exportedNames.length > 0) {
          exportInfo = {
            exportName: exportedNames[0],
            statementEnd: grandParent.end,
          };
        }
      }
    }

    sites.push({
      callStart,
      callEnd,
      argCount,
      lineNumber,
      calleeName,
      exportInfo,
    });
  });

  return sites;
}

function getImportedLocalNamesFromProgram(
  program: ProgramNode,
  importedName: string,
): Set<string> {
  const localNames = new Set<string>();
  const body = program.body as any[];

  for (const node of body) {
    if (node?.type !== "ImportDeclaration") continue;
    const source = node.source?.value;
    if (typeof source !== "string") continue;
    if (!source.startsWith("@rangojs/router")) continue;

    const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
    for (const spec of specifiers) {
      if (spec?.type !== "ImportSpecifier") continue;
      if (spec.imported?.type !== "Identifier") continue;
      if (spec.imported.name !== importedName) continue;

      if (spec.local?.type === "Identifier") {
        localNames.add(spec.local.name);
      }
    }
  }

  return localNames;
}

export function getImportedLocalNames(
  code: string,
  importedName: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): Set<string> {
  try {
    const program = parseAst(code, { jsx: true });
    return getImportedLocalNamesFromProgram(program, importedName);
  } catch {
    return new Set<string>();
  }
}

/**
 * Extract all import declarations from the source as raw text slices.
 * Copies ALL imports -- Rollup tree-shakes unused ones from virtual modules.
 */
export function extractImportDeclarations(
  code: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): string[] {
  let program: ProgramNode;
  try {
    program = parseAst(code, { jsx: true });
  } catch {
    return [];
  }

  const imports: string[] = [];
  for (const node of program.body as any[]) {
    if (node.type === "ImportDeclaration") {
      imports.push(code.slice(node.start, node.end));
    }
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Transform inline handler calls by extracting them into virtual modules.
 * Only processes inline calls (exportInfo === null); export const calls are
 * handled by the existing regex fast path.
 *
 * Always extracts (dev and build) to keep server-only imports out of non-RSC
 * environments. The virtual module goes through the standard transform pipeline
 * automatically -- the existing export const regex path handles it.
 *
 * Returns true if any inline calls were transformed.
 */
export function transformInlineHandlers(
  fnName: string,
  virtualPrefix: string,
  s: MagicString,
  code: string,
  filePath: string,
  virtualRegistry: Map<string, VirtualHandlerEntry>,
  moduleId: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): boolean {
  const sites = findHandlerCalls(code, fnName, parseAst);
  const inlineSites = sites.filter((site) => site.exportInfo === null);
  if (inlineSites.length === 0) return false;

  const imports = extractImportDeclarations(code, parseAst);

  // Track line occurrences for same-line collision handling
  const lineCounts = new Map<number, number>();

  // Collect all import statements to prepend
  const importStatements: string[] = [];

  for (const site of inlineSites) {
    const lineCount = lineCounts.get(site.lineNumber) ?? 0;
    lineCounts.set(site.lineNumber, lineCount + 1);

    const hash = hashInlineId(filePath, site.lineNumber, lineCount);
    const exportName = `__sh_${hash}`;
    const virtualId = `\0${virtualPrefix}${filePath}:${site.lineNumber}${lineCount > 0 ? `:${lineCount}` : ""}`;

    // Extract the full handler call expression text
    const handlerCode = code.slice(site.callStart, site.callEnd);

    // Register virtual module
    virtualRegistry.set(virtualId, {
      originalModuleId: moduleId,
      imports,
      handlerCode,
      exportName,
    });

    // Replace inline call with the import name
    s.overwrite(site.callStart, site.callEnd, exportName);

    // Build the import specifier for this virtual module
    const importId = `${virtualPrefix}${filePath}:${site.lineNumber}${lineCount > 0 ? `:${lineCount}` : ""}`;
    importStatements.push(
      `import { ${exportName} } from "${importId}";`,
    );
  }

  // Insert imports after directive prologue + existing import block
  if (importStatements.length > 0) {
    const importBlock = importStatements.join("\n") + "\n";
    const insertionPos = findImportInsertionPos(code, parseAst);
    if (insertionPos === 0) {
      s.prepend(importBlock);
    } else {
      s.appendLeft(insertionPos, "\n" + importBlock);
    }
  }

  return true;
}
