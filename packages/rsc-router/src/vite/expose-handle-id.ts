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
 * Generate a short hash for a handle ID
 * Uses first 8 chars of SHA-256 hash for uniqueness while keeping IDs short
 * Appends export name for easier debugging: "abc123#Breadcrumbs"
 */
function hashHandleId(filePath: string, exportName: string): string {
  const input = `${filePath}#${exportName}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return `${hash.slice(0, 8)}#${exportName}`;
}

/**
 * Check if file imports createHandle from rsc-router
 */
function hasCreateHandleImport(code: string): boolean {
  // Match: import { createHandle } from "@ivogt/rsc-router" or "@ivogt/rsc-router/..."
  const pattern =
    /import\s*\{[^}]*\bcreateHandle\b[^}]*\}\s*from\s*["']@ivogt/rsc-router(?:\/[^"']+)?["']/;
  return pattern.test(code);
}

/**
 * Analyze createHandle arguments to determine injection strategy
 * Returns: { hasArgs: boolean, firstArgIsString: boolean, firstArgIsFunction: boolean }
 */
function analyzeCreateHandleArgs(
  code: string,
  startPos: number,
  endPos: number
): { hasArgs: boolean; firstArgIsString: boolean; firstArgIsFunction: boolean } {
  // Extract the content between parentheses
  const content = code.slice(startPos, endPos).trim();

  if (!content) {
    return { hasArgs: false, firstArgIsString: false, firstArgIsFunction: false };
  }

  // Check if first arg starts with a quote (string literal)
  const firstArgIsString = /^["']/.test(content);

  // Check if first arg starts with ( for arrow function or function keyword
  const firstArgIsFunction =
    content.startsWith("(") ||
    content.startsWith("function") ||
    // Check for identifier that could be a collect function reference
    /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*(?:,|$)/.test(content);

  return { hasArgs: true, firstArgIsString, firstArgIsFunction };
}

/**
 * Transform export const X = createHandle(...) patterns to inject $$id
 *
 * Handles these cases:
 * 1. createHandle() - no args -> inject (undefined, "id")
 * 2. createHandle("name") - string name -> inject (, "id") after existing arg
 * 3. createHandle(collectFn) - collect function -> inject (collectFn, "id")
 * 4. createHandle("name", collectFn) - both -> inject (, "id") after existing args
 */
function transformHandleExports(
  code: string,
  filePath: string,
  sourceId?: string,
  isBuild: boolean = false
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Quick bail-out
  if (!code.includes("createHandle")) {
    return null;
  }

  // Must have direct import from rsc-router
  if (!hasCreateHandleImport(code)) {
    return null;
  }

  // Match: export const X = createHandle<...>(
  // Captures the export name (X)
  const pattern = /export\s+const\s+(\w+)\s*=\s*createHandle\s*(?:<[^>]*>)?\s*\(/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Find the end of the createHandle(...) call
    let parenDepth = 1;
    let i = matchEnd;
    while (i < code.length && parenDepth > 0) {
      if (code[i] === "(") parenDepth++;
      if (code[i] === ")") parenDepth--;
      i++;
    }

    // i now points just after the closing )
    const closeParenPos = i - 1;

    // Analyze what arguments exist
    const args = analyzeCreateHandleArgs(code, matchEnd, closeParenPos);

    // Find the semicolon or end of statement
    let statementEnd = i;
    while (statementEnd < code.length && /\s/.test(code[statementEnd])) {
      statementEnd++;
    }
    if (code[statementEnd] === ";") {
      statementEnd++;
    }

    // Generate ID: hashed in production, readable in dev
    const handleId = isBuild
      ? hashHandleId(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Inject $$id as the last parameter
    let paramInjection: string;
    if (!args.hasArgs) {
      // No args: createHandle() -> createHandle(undefined, "id")
      paramInjection = `undefined, "${handleId}"`;
    } else {
      // Has args: createHandle(x) -> createHandle(x, "id")
      paramInjection = `, "${handleId}"`;
    }
    s.appendLeft(closeParenPos, paramInjection);

    // Also set $$id property for external access
    const propInjection = `\n${exportName}.$$id = "${handleId}";`;
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
 * Vite plugin that exposes $$id on createHandle calls.
 *
 * When users create handles with createHandle(), this plugin:
 * 1. Injects a $$id as the last parameter (used as the handle name)
 * 2. Sets $$id property on the exported constant for external access
 *
 * This allows handles to be created without explicit names:
 * - Before: export const Breadcrumbs = createHandle<Item>("breadcrumbs")
 * - After:  export const Breadcrumbs = createHandle<Item>()
 *
 * The name is auto-generated from file path + export name.
 *
 * Requirements:
 * - Must use direct import: import { createHandle } from "@ivogt/rsc-router"
 * - Must use named export: export const MyHandle = createHandle(...)
 */
export function exposeHandleId(): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;

  return {
    name: "@ivogt/rsc-router:expose-handle-id",
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
      if (!code.includes("createHandle")) {
        return;
      }

      // Must have direct import from rsc-router
      if (!hasCreateHandleImport(code)) {
        return;
      }

      // Get relative path for the ID
      const relativePath = normalizePath(path.relative(config.root, id));

      // Transform: inject $$id
      return transformHandleExports(code, relativePath, id, isBuild);
    },
  };
}
