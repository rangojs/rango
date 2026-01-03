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
 * Generate a short hash for a location state key
 * Uses first 8 chars of SHA-256 hash for uniqueness while keeping keys short
 * Appends export name for easier debugging: "abc123#ProductState"
 */
function hashLocationStateKey(filePath: string, exportName: string): string {
  const input = `${filePath}#${exportName}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return `${hash.slice(0, 8)}#${exportName}`;
}

/**
 * Check if file imports createLocationState from rsc-router
 */
function hasCreateLocationStateImport(code: string): boolean {
  // Match: import { createLocationState } from "rsc-router" or "rsc-router/client"
  const pattern =
    /import\s*\{[^}]*\bcreateLocationState\b[^}]*\}\s*from\s*["']rsc-router(?:\/[^"']+)?["']/;
  return pattern.test(code);
}

/**
 * Transform export const X = createLocationState<...>() patterns to inject key
 *
 * The key is injected as the first parameter if not present:
 * - createLocationState() -> createLocationState("id")
 * - createLocationState<T>() -> createLocationState<T>("id")
 */
function transformLocationStateExports(
  code: string,
  filePath: string,
  sourceId?: string,
  isBuild: boolean = false
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Quick bail-out
  if (!code.includes("createLocationState")) {
    return null;
  }

  // Must have direct import from rsc-router
  if (!hasCreateLocationStateImport(code)) {
    return null;
  }

  // Match: export const X = createLocationState<...>(
  // Captures the export name (X)
  const pattern = /export\s+const\s+(\w+)\s*=\s*createLocationState\s*(?:<[^>]*>)?\s*\(/g;

  const s = new MagicString(code);
  let hasChanges = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const exportName = match[1];
    const matchEnd = match.index + match[0].length;

    // Find the end of the createLocationState(...) call
    let parenDepth = 1;
    let i = matchEnd;
    while (i < code.length && parenDepth > 0) {
      if (code[i] === "(") parenDepth++;
      if (code[i] === ")") parenDepth--;
      i++;
    }

    // i now points just after the closing )
    const closeParenPos = i - 1;

    // Check if there are any arguments (content between open and close paren)
    const content = code.slice(matchEnd, closeParenPos).trim();
    const hasArgs = content.length > 0;

    // Find the semicolon or end of statement
    let statementEnd = i;
    while (statementEnd < code.length && /\s/.test(code[statementEnd])) {
      statementEnd++;
    }
    if (code[statementEnd] === ";") {
      statementEnd++;
    }

    // Generate key: hashed in production, readable in dev
    const stateKey = isBuild
      ? hashLocationStateKey(filePath, exportName)
      : `${filePath}#${exportName}`;

    // Inject key as the first (and only) parameter
    // createLocationState() -> createLocationState("id")
    if (!hasArgs) {
      s.appendLeft(closeParenPos, `"${stateKey}"`);
    } else {
      // Already has a key, skip (shouldn't happen with new API, but be safe)
      continue;
    }

    // Also set __rsc_ls_key property for verification
    const propInjection = `\n${exportName}.__rsc_ls_key = "__rsc_ls_${stateKey}";`;
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
 * Vite plugin that exposes location state keys on createLocationState calls.
 *
 * When users create location states with createLocationState(), this plugin:
 * 1. Injects an auto-generated key as the first parameter
 * 2. Sets __rsc_ls_key property for verification
 *
 * This allows location states to be created without explicit keys:
 * - Before: export const ProductState = createLocationState<Product>("product")
 * - After:  export const ProductState = createLocationState<Product>()
 *
 * The key is auto-generated from file path + export name.
 *
 * Requirements:
 * - Must use direct import: import { createLocationState } from "rsc-router"
 * - Must use named export: export const MyState = createLocationState(...)
 */
export function exposeLocationStateId(): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;

  return {
    name: "rsc-router:expose-location-state-id",
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
      if (!code.includes("createLocationState")) {
        return;
      }

      // Must have direct import from rsc-router
      if (!hasCreateLocationStateImport(code)) {
        return;
      }

      // Get relative path for the key
      const relativePath = normalizePath(path.relative(config.root, id));

      // Transform: inject key
      return transformLocationStateExports(code, relativePath, id, isBuild);
    },
  };
}
