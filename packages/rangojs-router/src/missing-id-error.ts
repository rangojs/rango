// Builds the error thrown when a create*() call (createLoader / createHandle)
// reaches runtime without an injected $$id. The exposeInternalIds Vite transform
// injects $$id only for an EXPORTED const declaration, so a non-exported const,
// an `export let/var`, or an inline create*() call gets none. Previously this
// failed with a terse message and no source location; this helper adds the
// offending call site (best-effort, from the stack) and actionable guidance.
//
// The "<Kind> is missing $$id" prefix is preserved so existing tests and any
// log scrapers keep matching. Dev-only: the call sites guard on
// process.env.NODE_ENV === "development", so production builds fold the branch
// away and tree-shake this module out.

// create*() implementation files to skip when locating the user's call site.
const SELF_FILES = new Set([
  "missing-id-error",
  "loader",
  "loader.rsc",
  "handle",
]);

/**
 * Best-effort "path:line:column" of the user's create*() call, parsed from the
 * current stack. Skips @rangojs/router internals and node_modules. Returns
 * undefined if nothing usable is found (stack parsing is inherently fragile).
 */
function findUserCallSite(): string | undefined {
  try {
    const stack = new Error().stack;
    if (!stack) return undefined;
    for (const frame of stack.split("\n").slice(1)) {
      const m = frame.match(
        /(?:\(|@|\s)(?:file:\/\/)?((?:\/|[A-Za-z]:[\\/])[^()\s]+?\.(?:ts|tsx|js|jsx|mts|cts)):(\d+):(\d+)\)?/,
      );
      if (!m) continue;
      const path = m[1];
      if (path.includes("node_modules") || path.includes("@rangojs/router")) {
        continue;
      }
      const base = path
        .split(/[\\/]/)
        .pop()!
        .replace(/\.(?:ts|tsx|js|jsx|mts|cts)$/, "");
      if (SELF_FILES.has(base)) continue;
      return `${path}:${m[2]}:${m[3]}`;
    }
  } catch {
    // best-effort only
  }
  return undefined;
}

export function missingInjectedIdError(
  kind: "Loader" | "Handle",
  fnName: "createLoader" | "createHandle",
): Error {
  const site = findUserCallSite();
  const at = site ? ` (created at ${site})` : "";
  return new Error(
    `[rango] ${kind} is missing $$id${at}.\n` +
      `The @rangojs/router:expose-internal-ids Vite transform injects ${fnName}()'s ` +
      `stable $$id from an EXPORTED const declaration only:\n` +
      `  export const X = ${fnName}(...)\n` +
      `  const X = ${fnName}(...); export { X }\n` +
      `A non-exported const, an \`export let/var\`, or an inline ${fnName}(...) ` +
      `call gets no $$id — export it as \`export const\`. (A matching ` +
      `"Unsupported ${fnName} shape" warning names the exact file:line.)`,
  );
}
