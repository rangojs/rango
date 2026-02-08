import type { Plugin, ResolvedConfig } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Normalize path to forward slashes
 */
function normalizePath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Generate a short hash for a prerender handler ID.
 * Uses first 8 chars of SHA-256 hash for uniqueness while keeping IDs short.
 * Appends export name for easier debugging: "abc123#DocsPage"
 */
function hashPrerenderHandlerId(filePath: string, exportName: string): string {
  const input = `${filePath}#${exportName}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return `${hash.slice(0, 8)}#${exportName}`;
}

/**
 * Check if file imports createPrerenderHandler from @rangojs/router
 */
function hasCreatePrerenderHandlerImport(code: string): boolean {
  const pattern =
    /import\s*\{[^}]*\bcreatePrerenderHandler\b[^}]*\}\s*from\s*["']@rangojs\/router(?:\/[^"']+)?["']/;
  return pattern.test(code);
}

/**
 * Count the number of top-level arguments in a function call.
 * Skips nested parens, brackets, braces, and template literals.
 */
function countArgs(code: string, startPos: number, endPos: number): number {
  let depth = 0;
  let argCount = 0;
  let hasContent = false;

  for (let i = startPos; i < endPos; i++) {
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
  }

  return hasContent ? argCount + 1 : 0;
}

/**
 * Transform export const X = createPrerenderHandler(...) patterns to inject $$id.
 *
 * Overload shapes:
 *   1 arg  (handler)                 -> inject undefined, "id"  (pad for options + id)
 *   2 args (getParams+handler OR handler+options) -> inject , "id"
 *   3 args (getParams+handler+options)            -> inject , "id"
 *
 * The __injectedId is always the LAST parameter.
 */
function transformPrerenderHandlerExports(
  code: string,
  filePath: string,
  sourceId?: string,
  isBuild: boolean = false,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (!code.includes("createPrerenderHandler")) {
    return null;
  }

  if (!hasCreatePrerenderHandlerImport(code)) {
    return null;
  }

  // Match: export const X = createPrerenderHandler<...>(
  const pattern =
    /export\s+const\s+(\w+)\s*=\s*createPrerenderHandler\s*(?:<[^>]*>)?\s*\(/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Find the matching closing paren
    let parenDepth = 1;
    let i = matchEnd;
    while (i < code.length && parenDepth > 0) {
      if (code[i] === "(") parenDepth++;
      if (code[i] === ")") parenDepth--;
      i++;
    }

    const closeParenPos = i - 1;
    const argCount = countArgs(code, matchEnd, closeParenPos);

    // Find statement end (after ; or whitespace)
    let statementEnd = i;
    while (statementEnd < code.length && /\s/.test(code[statementEnd])) {
      statementEnd++;
    }
    if (code[statementEnd] === ";") {
      statementEnd++;
    }

    const handlerId = isBuild
      ? hashPrerenderHandlerId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Inject $$id as the last parameter.
    // createPrerenderHandler(handler) -> createPrerenderHandler(handler, undefined, "id")
    // createPrerenderHandler(handler, opts) -> createPrerenderHandler(handler, opts, "id")
    // createPrerenderHandler(getP, handler) -> createPrerenderHandler(getP, handler, undefined, "id")
    // createPrerenderHandler(getP, handler, opts) -> createPrerenderHandler(getP, handler, opts, "id")
    //
    // The runtime implementation accepts __injectedId as:
    //   Overload 1 (1 fn): 3rd param (after handler, options)
    //   Overload 2 (2 fn): 4th param (after getParams, handler, options)
    //
    // We cannot statically distinguish between (handler, options) and (getParams, handler)
    // when there are 2 args. However the runtime resolves this by checking typeof of the
    // second arg. The __injectedId is always a string, so it can appear in either the
    // options or id slot — the runtime handles both via typeof checks.
    let paramInjection: string;
    if (argCount === 0) {
      paramInjection = `undefined, "${handlerId}"`;
    } else if (argCount === 1) {
      // 1 arg (handler only): need to pad for options slot
      paramInjection = `, undefined, "${handlerId}"`;
    } else {
      // 2+ args: just append id
      paramInjection = `, "${handlerId}"`;
    }
    s.appendLeft(closeParenPos, paramInjection);

    // Set $$id property for external access
    const propInjection = `\n${exportName}.$$id = "${handlerId}";`;
    s.appendRight(statementEnd, propInjection);
    hasChanges = true;
  }

  if (!hasChanges) {
    return null;
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: sourceId, includeContent: true }),
  };
}

/**
 * Replace createPrerenderHandler(...) call expressions with lightweight stub objects
 * in non-RSC environments. Other exports, imports, and module-level code remain
 * untouched — only the call expression is replaced.
 *
 * This prevents handler rendering code and build-only dependencies from shipping
 * to client/SSR bundles where handlers never execute.
 */
function generatePrerenderHandlerStubs(
  code: string,
  filePath: string,
  sourceId?: string,
  isBuild: boolean = false,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Match: export const X = createPrerenderHandler<...>(
  const pattern =
    /export\s+const\s+(\w+)\s*=\s*(createPrerenderHandler\s*(?:<[^>]*>)?\s*\()/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    // callStart points to 'c' in 'createPrerenderHandler'
    const callStart = match.index + match[0].length - match[2].length;

    // Find the matching closing paren (after the open paren at end of match)
    const openParenPos = match.index + match[0].length;
    let parenDepth = 1;
    let i = openParenPos;
    while (i < code.length && parenDepth > 0) {
      if (code[i] === "(") parenDepth++;
      if (code[i] === ")") parenDepth--;
      i++;
    }
    const afterCloseParen = i;

    const handlerId = isBuild
      ? hashPrerenderHandlerId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Replace createPrerenderHandler<...>(...) with stub object
    s.overwrite(
      callStart,
      afterCloseParen,
      `{ __brand: "prerenderHandler", $$id: "${handlerId}" }`,
    );
    hasChanges = true;
  }

  if (!hasChanges) return null;

  return {
    code: s.toString(),
    map: s.generateMap({ source: sourceId, includeContent: true }),
  };
}

/**
 * Vite plugin that exposes $$id on createPrerenderHandler calls.
 *
 * When users create prerender handlers with createPrerenderHandler(), this plugin:
 * - RSC environment: Injects $$id into the call and sets a $$id property on the export
 * - Non-RSC environments (client/SSR): Replaces createPrerenderHandler(...) call
 *   expressions with lightweight { __brand, $$id } stubs, keeping other exports intact
 *
 * Requirements:
 * - Must use direct import: import { createPrerenderHandler } from "@rangojs/router"
 * - Must use named export: export const MyPage = createPrerenderHandler(...)
 */
export function exposePrerenderHandlerId(): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;

  return {
    name: "@rangojs/router:expose-prerender-handler-id",
    enforce: "post",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      isBuild = config.command === "build";
    },

    transform(code, id) {
      // Skip node_modules
      if (id.includes("/node_modules/")) {
        return;
      }

      // Quick bail-out
      if (!code.includes("createPrerenderHandler")) {
        return;
      }

      // Must have direct import from @rangojs/router
      if (!hasCreatePrerenderHandlerImport(code)) {
        return;
      }

      // Get relative path for the ID
      const relativePath = normalizePath(path.relative(config.root, id));

      const isRscEnv = this.environment?.name === "rsc";

      if (!isRscEnv) {
        // Non-RSC: replace handler call expressions with lightweight stubs
        return generatePrerenderHandlerStubs(code, relativePath, id, isBuild);
      }

      // RSC: inject $$id into calls (existing behavior)
      return transformPrerenderHandlerExports(code, relativePath, id, isBuild);
    },
  };
}
