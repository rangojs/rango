import path from "node:path";
import crypto from "node:crypto";

/**
 * Normalize path to forward slashes.
 */
export function normalizePath(p: string): string {
  return p.split(path.sep).join("/");
}

export function hashId(filePath: string, exportName: string): string {
  const input = `${filePath}#${exportName}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return `${hash.slice(0, 8)}#${exportName}`;
}

export function makeStubId(
  filePath: string,
  exportName: string,
  isBuild: boolean,
): string {
  return isBuild ? hashId(filePath, exportName) : `${filePath}#${exportName}`;
}

export function hashInlineId(
  filePath: string,
  fnName: string,
  index: number,
): string {
  const input = `${filePath}:${fnName}:${index}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export interface DetectedImports {
  loader: boolean;
  handle: boolean;
  locationState: boolean;
  prerenderHandler: boolean;
  staticHandler: boolean;
  router: boolean;
  any: boolean;
}

export function buildExportMap(program: any): Map<string, string[]> {
  const exportMap = new Map<string, string[]>();

  const pushExport = (local: string, exported: string) => {
    const list = exportMap.get(local);
    if (list) {
      if (!list.includes(exported)) list.push(exported);
      return;
    }
    exportMap.set(local, [exported]);
  };

  for (const node of program.body ?? []) {
    if (node?.type !== "ExportNamedDeclaration") continue;

    if (node.declaration?.type === "VariableDeclaration") {
      for (const decl of node.declaration.declarations ?? []) {
        if (decl?.id?.type === "Identifier") {
          pushExport(decl.id.name, decl.id.name);
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
          pushExport(spec.local.name, spec.exported.name);
        }
      }
    }
  }

  return exportMap;
}

export function detectImports(code: string): DetectedImports {
  // Extract all import declarations from @rangojs/router in one scan
  const importPattern =
    /import\s*\{([^}]*)\}\s*from\s*["']@rangojs\/router(?:\/[^"']*)?["']/g;

  const result: DetectedImports = {
    loader: false,
    handle: false,
    locationState: false,
    prerenderHandler: false,
    staticHandler: false,
    router: false,
    any: false,
  };

  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(code)) !== null) {
    const imports = match[1];
    if (/\bcreateLoader\b/.test(imports)) result.loader = true;
    if (/\bcreateHandle\b/.test(imports)) result.handle = true;
    if (/\bcreateLocationState\b/.test(imports)) result.locationState = true;
    if (/\bPrerender\b/.test(imports)) result.prerenderHandler = true;
    if (/\bStatic\b/.test(imports)) result.staticHandler = true;
    if (/\bcreateRouter\b/.test(imports)) result.router = true;
  }

  if (result.router) {
    result.router =
      /import\s*\{[^}]*\bcreateRouter\b[^}]*\}\s*from\s*["']@rangojs\/router["']/.test(
        code,
      );
  }

  result.any =
    result.loader ||
    result.handle ||
    result.locationState ||
    result.prerenderHandler ||
    result.staticHandler ||
    result.router;

  return result;
}

export function skipStringOrComment(code: string, pos: number): number {
  const ch = code[pos];

  if (ch === '"' || ch === "'") {
    for (let j = pos + 1; j < code.length; j++) {
      if (code[j] === "\\") {
        j++;
        continue;
      }
      if (code[j] === ch) return j + 1;
    }
    return code.length;
  }

  if (ch === "`") {
    let j = pos + 1;
    while (j < code.length) {
      if (code[j] === "\\") {
        j += 2;
        continue;
      }
      if (code[j] === "`") return j + 1;
      if (code[j] === "$" && j + 1 < code.length && code[j + 1] === "{") {
        j += 2;
        let braceDepth = 1;
        while (j < code.length && braceDepth > 0) {
          const inner = skipStringOrComment(code, j);
          if (inner > j) {
            j = inner;
            continue;
          }
          if (code[j] === "{") braceDepth++;
          else if (code[j] === "}") braceDepth--;
          if (braceDepth > 0) j++;
        }
        if (braceDepth === 0) j++;
        continue;
      }
      j++;
    }
    return j;
  }

  if (ch === "/" && pos + 1 < code.length) {
    if (code[pos + 1] === "/") {
      const eol = code.indexOf("\n", pos + 2);
      return eol === -1 ? code.length : eol + 1;
    }
    if (code[pos + 1] === "*") {
      const end = code.indexOf("*/", pos + 2);
      return end === -1 ? code.length : end + 2;
    }
  }

  return pos;
}

export function findMatchingParen(code: string, startPos: number): number {
  let depth = 1;
  let i = startPos;
  while (i < code.length && depth > 0) {
    const skipped = skipStringOrComment(code, i);
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (code[i] === "(") depth++;
    if (code[i] === ")") depth--;
    i++;
  }
  return i;
}

export function countArgs(
  code: string,
  startPos: number,
  endPos: number,
): number {
  let depth = 0;
  let argCount = 0;
  let hasContent = false;
  let i = startPos;

  while (i < endPos) {
    const skipped = skipStringOrComment(code, i);
    if (skipped > i) {
      // A comment is transparent: `createHandle(/* meta */)` has ZERO real
      // arguments, so a comment-only region must NOT set hasContent (else the
      // fallback path would count it as 1 arg and inject `, "id"` over an elided
      // first slot — a syntax error). A string/template literal IS content.
      const ch = code[i];
      const isComment =
        ch === "/" &&
        i + 1 < code.length &&
        (code[i + 1] === "/" || code[i + 1] === "*");
      if (!isComment) hasContent = true;
      i = skipped;
      continue;
    }

    const char = code[i];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
      hasContent = true;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
    } else if (char === "," && depth === 0) {
      argCount++;
    } else if (!/\s/.test(char)) {
      hasContent = true;
    }
    i++;
  }

  return hasContent ? argCount + 1 : 0;
}

export function findStatementEnd(code: string, pos: number): number {
  let i = pos;
  while (i < code.length && /\s/.test(code[i])) {
    i++;
  }
  if (i < code.length && code[i] === ";") {
    i++;
  }
  return i;
}

export { escapeRegExp } from "../../regex-escape.js";

/**
 * Given an index pointing just past a `create*` callee identifier, return the
 * index of the call's opening `(`, accounting for an optional generic type
 * argument list `<...>` with arbitrarily nested `<>`. Returns -1 when the next
 * non-trivia token is neither `<` nor `(` (i.e. not a call site).
 *
 * Replaces the single-level `<[^>]*>` regex assumption, which stopped at the
 * first `>` and so never reached `(` for `createRouter<Config<Env>>(`.
 *
 * Whitespace, comments, and strings between the callee and `(` are skipped via
 * skipStringOrComment. The `<...>` scan only balances angle brackets; it does
 * not attempt to parse full TS type syntax (sufficient for locating the paren).
 */
export function findCallParenAfterGenerics(
  code: string,
  afterCalleeIndex: number,
): number {
  let i = afterCalleeIndex;
  // Skip leading whitespace/comments/strings before `<` or `(`.
  while (i < code.length) {
    const skipped = skipStringOrComment(code, i);
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (/\s/.test(code[i])) {
      i++;
      continue;
    }
    break;
  }

  if (i >= code.length) return -1;

  if (code[i] === "(") return i;

  if (code[i] === "<") {
    let depth = 0;
    while (i < code.length) {
      const skipped = skipStringOrComment(code, i);
      if (skipped > i) {
        i = skipped;
        continue;
      }
      const ch = code[i];
      if (ch === "<") {
        depth++;
      } else if (ch === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    if (depth !== 0) return -1;
    // After the balanced generic list, skip trivia and expect `(`.
    while (i < code.length) {
      const skipped = skipStringOrComment(code, i);
      if (skipped > i) {
        i = skipped;
        continue;
      }
      if (/\s/.test(code[i])) {
        i++;
        continue;
      }
      break;
    }
    if (i < code.length && code[i] === "(") return i;
    return -1;
  }

  return -1;
}
