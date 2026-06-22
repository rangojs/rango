/**
 * Bake the resolved INTERNAL_RANGO_DEBUG value into the router's `internal-debug`
 * module so the flag reaches the CLIENT debug logs by just setting the env var.
 *
 * internal-debug.ts normally reads the flag via `typeof __RANGO_DEBUG__`, a Vite
 * define. That delivery is unreliable on the client: in dev Vite ships the define
 * only as an injected global whose presence varies across consumer setups, so the
 * module can fall through to `process.env` (undefined in the browser) and the FE
 * debug flag silently stays false while the server logs work. A Vite `transform`
 * runs on the module regardless of how (or whether) the define is delivered, in
 * both dev and build and for every environment, so the discovery plugin uses this
 * to replace the module with the resolved literal.
 *
 * Returns null for any module that is not the router's internal-debug module.
 */
export function injectClientDebugFlag(
  id: string,
): { code: string; map: null } | null {
  // Cheap early-out: this hook runs on every module in every environment.
  if (!id.includes("internal-debug")) return null;
  const norm = id.replace(/\\/g, "/");
  // Scope to the router's own internal-debug module: the published package
  // (`/@rangojs/router/`, incl. pnpm's nested layout) or the monorepo workspace
  // (`/packages/rangojs-router/`). The package-anchored path avoids matching a
  // consumer file that merely sits under a directory named `rangojs-router`.
  const isInternalDebug =
    /\/internal-debug\.[cm]?[jt]sx?(\?|$)/.test(norm) &&
    (norm.includes("/@rangojs/router/") ||
      norm.includes("/packages/rangojs-router/"));
  if (!isInternalDebug) return null;
  // Emit the whole module: internal-debug.ts has a single export, kept in sync.
  return {
    code: `export const INTERNAL_RANGO_DEBUG = ${!!process.env.INTERNAL_RANGO_DEBUG};\n`,
    map: null,
  };
}
