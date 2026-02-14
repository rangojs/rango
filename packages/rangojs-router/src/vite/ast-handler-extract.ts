import type MagicString from "magic-string";
import type { ProgramNode } from "rollup";
import { hashInlineId } from "./expose-id-utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HandlerCallSite {
  callStart: number;
  callEnd: number;
  argCount: number;
  lineNumber: number;

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

// Backwards-compat aliases
export type StaticHandlerCallSite = HandlerCallSite;
export type VirtualStaticHandlerEntry = VirtualHandlerEntry;

// ---------------------------------------------------------------------------
// AST walking helper
// ---------------------------------------------------------------------------

type AstNode = ProgramNode["body"][number] & { start: number; end: number };

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

  walkNode(program, null, [], (node: any, parent: any, ancestors: any[]) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "Identifier" ||
      node.callee.name !== fnName
    ) {
      return;
    }

    const callStart: number = node.start;
    const callEnd: number = node.end;
    const argCount: number = node.arguments?.length ?? 0;

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
      }
    }

    sites.push({ callStart, callEnd, argCount, lineNumber, exportInfo });
  });

  return sites;
}

// Backwards-compat wrapper
export function findStaticHandlerCalls(
  code: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): HandlerCallSite[] {
  return findHandlerCalls(code, "createStaticHandler", parseAst);
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
  _isBuild: boolean,
  _fileName: string,
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

  // Prepend all import statements at the top of the file
  if (importStatements.length > 0) {
    s.prepend(importStatements.join("\n") + "\n");
  }

  return true;
}

// Backwards-compat wrapper
export function transformInlineStaticHandlers(
  s: MagicString,
  code: string,
  filePath: string,
  isBuild: boolean,
  fileName: string,
  virtualRegistry: Map<string, VirtualHandlerEntry>,
  moduleId: string,
  parseAst: (code: string, options?: any) => ProgramNode,
): boolean {
  return transformInlineHandlers(
    "createStaticHandler", "virtual:handler-extract:",
    s, code, filePath, isBuild, fileName, virtualRegistry, moduleId, parseAst,
  );
}
