import type MagicString from "magic-string";
import { hashInlineId, buildExportMap } from "../plugins/expose-id-utils.js";

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
  declarations: string[];
  handlerCode: string;
  exportName: string;
}

function isDirectivePrologueStatement(node: any): boolean {
  return (
    node?.type === "ExpressionStatement" && typeof node.directive === "string"
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
    program = parseAst(code, { lang: "tsx" });
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
    } else if (
      child &&
      typeof child === "object" &&
      typeof child.type === "string"
    ) {
      walkNode(child, node, ancestors, enter);
    }
  }

  ancestors.pop();
}

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
    program = parseAst(code, { lang: "tsx" });
  } catch {
    return [];
  }

  const sites: HandlerCallSite[] = [];
  const localNames = getImportedLocalNamesFromProgram(program, fnName);
  const exportedNamesByLocal = buildExportMap(program);

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
      const grandParent =
        ancestors.length >= 3 ? ancestors[ancestors.length - 3] : null;
      const greatGrandParent =
        ancestors.length >= 4 ? ancestors[ancestors.length - 4] : null;

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
    const program = parseAst(code, { lang: "tsx" });
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
    program = parseAst(code, { lang: "tsx" });
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

/**
 * Check if an expression AST subtree is "inert" -- safe to evaluate eagerly
 * without referencing import bindings. Inert expressions contain only literals,
 * arrays/objects of inert values, template literals with inert expressions,
 * and unary/binary operators on inert operands.
 *
 * Function/arrow expressions are NOT inert (they're lazy -- handled separately).
 * Identifiers and member expressions are NOT inert (may reference imports).
 *
 * This check prevents TDZ errors when declarations are moved to virtual
 * modules that end up in separate Rollup chunks with circular dependencies.
 */
function isInertExpression(node: any): boolean {
  if (!node) return false;
  switch (node.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return (node.expressions ?? []).every((e: any) => isInertExpression(e));
    case "ArrayExpression":
      return (node.elements ?? []).every(
        (e: any) => e === null || isInertExpression(e),
      );
    case "ObjectExpression":
      return (node.properties ?? []).every(
        (p: any) =>
          p.type === "Property" &&
          (!p.computed || isInertExpression(p.key)) &&
          isInertExpression(p.value),
      );
    case "UnaryExpression":
      return isInertExpression(node.argument);
    case "BinaryExpression":
      return isInertExpression(node.left) && isInertExpression(node.right);
    case "ConditionalExpression":
      return (
        isInertExpression(node.test) &&
        isInertExpression(node.consequent) &&
        isInertExpression(node.alternate)
      );
    case "SpreadElement":
      return isInertExpression(node.argument);
    default:
      return false;
  }
}

/**
 * Check if a variable declarator's init is safe for inclusion in a virtual
 * module. Safe initializers are:
 *   1. Function/arrow expressions (body is lazy, no TDZ risk)
 *   2. Inert expressions (no identifier references, no TDZ risk)
 *
 * Declarations that reference identifiers at the top level (e.g.
 * `const VT = React.Fragment`) are NOT safe -- when the virtual module
 * is bundled into a separate Rollup chunk, circular chunk dependencies
 * can cause "Cannot access X before initialization" TDZ errors.
 */
function isSafeDeclaratorInit(init: any): boolean {
  if (!init) return true; // `let x;` with no init is safe
  if (
    init.type === "ArrowFunctionExpression" ||
    init.type === "FunctionExpression"
  ) {
    return true;
  }
  return isInertExpression(init);
}

/**
 * Check if all declarators in a VariableDeclaration have safe initializers
 * and none is a handler call (Static/Prerender).
 */
function isSafeVariableDeclaration(
  node: any,
  handlerNames: Set<string>,
): boolean {
  if (node.type !== "VariableDeclaration") return false;
  return node.declarations.every(
    (d: any) =>
      isSafeDeclaratorInit(d.init) &&
      !(
        d.init?.type === "CallExpression" &&
        d.init.callee?.type === "Identifier" &&
        handlerNames.has(d.init.callee.name)
      ),
  );
}

/**
 * Extract module-level declarations that are safe for inclusion in virtual
 * modules. "Safe" means the declaration can be eagerly evaluated without
 * referencing import bindings, preventing TDZ errors in separate chunks.
 *
 * Included: function declarations, arrow/function expression inits, and
 * variable inits that are inert (pure literals, arrays, objects).
 * Excluded: declarations that reference identifiers at init time (may
 * reference imports causing TDZ), handler call declarations (circular),
 * class declarations (field initializers can reference imports).
 *
 * Strips export keywords so declarations work as plain locals.
 * Rollup tree-shakes unused declarations from virtual modules.
 */
export function extractModuleLevelDeclarations(
  code: string,
  parseAst: (code: string, options?: any) => ProgramNode,
  handlerNames: Set<string>,
): string[] {
  let program: ProgramNode;
  try {
    program = parseAst(code, { lang: "tsx" });
  } catch {
    return [];
  }

  const declarations: string[] = [];
  for (const node of program.body as any[]) {
    // Skip imports (handled by extractImportDeclarations)
    if (node.type === "ImportDeclaration") continue;

    // VariableDeclaration -- include only if all declarators are safe
    if (node.type === "VariableDeclaration") {
      if (isSafeVariableDeclaration(node, handlerNames)) {
        declarations.push(code.slice(node.start, node.end));
      }
      continue;
    }

    // FunctionDeclaration -- always safe (body is lazy)
    if (node.type === "FunctionDeclaration") {
      declarations.push(code.slice(node.start, node.end));
      continue;
    }

    // ExportNamedDeclaration with a declaration inside -- strip the export
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const decl = node.declaration;
      if (decl.type === "VariableDeclaration") {
        if (isSafeVariableDeclaration(decl, handlerNames)) {
          declarations.push(code.slice(decl.start, decl.end));
        }
      } else if (decl.type === "FunctionDeclaration") {
        declarations.push(code.slice(decl.start, decl.end));
      }
      continue;
    }

    // Skip: ClassDeclaration (field initializers can reference imports),
    // ExportDefaultDeclaration, ExportAllDeclaration,
    // ExportNamedDeclaration without declaration (re-exports),
    // ExpressionStatement (side effects), etc.
  }

  return declarations;
}

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

  // Collect local names for both Static and Prerender to exclude their
  // declarations from virtual modules (avoids circular extraction).
  const staticNames = getImportedLocalNames(code, "Static", parseAst);
  const prerenderNames = getImportedLocalNames(code, "Prerender", parseAst);
  const handlerNames = new Set([...staticNames, ...prerenderNames]);
  const declarations = extractModuleLevelDeclarations(
    code,
    parseAst,
    handlerNames,
  );

  // Collect all import statements to prepend
  const importStatements: string[] = [];

  for (const [siteIndex, site] of inlineSites.entries()) {
    // Key the extracted handler on its source-order index (per fnName), NOT its
    // line number. The id flows into BOTH the export name and the virtual module
    // path (which hashId hashes for the runtime $$id), and line numbers shift
    // between the prerender and production build contexts. The index is invariant
    // to those shifts, keeping the prerender manifest key == the runtime id.
    const hash = hashInlineId(filePath, fnName, siteIndex);
    const exportName = `__sh_${hash}`;
    const idSuffix = `${filePath}:${fnName}:${siteIndex}`;
    const virtualId = `\0${virtualPrefix}${idSuffix}`;

    // Extract the full handler call expression text
    const handlerCode = code.slice(site.callStart, site.callEnd);

    // Register virtual module
    virtualRegistry.set(virtualId, {
      originalModuleId: moduleId,
      imports,
      declarations,
      handlerCode,
      exportName,
    });

    // Replace inline call with the import name
    s.overwrite(site.callStart, site.callEnd, exportName);

    // Build the import specifier for this virtual module
    const importId = `${virtualPrefix}${idSuffix}`;
    importStatements.push(`import { ${exportName} } from "${importId}";`);
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
