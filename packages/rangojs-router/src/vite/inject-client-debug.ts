import type { Connect } from "vite";

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
 */

/**
 * Scope to the router's own internal-debug module: the published package
 * (`/@rangojs/router/`, incl. pnpm's nested layout) or the monorepo workspace
 * (`/packages/rangojs-router/`). The package-anchored path avoids matching a
 * consumer file that merely sits under a directory named `rangojs-router`.
 * Accepts module ids and dev-server URLs (`/@fs/...internal-debug.ts?v=abc`).
 */
export function isRouterInternalDebugId(id: string): boolean {
  if (!id.includes("internal-debug")) return false;
  const norm = id.replace(/\\/g, "/");
  return (
    /\/internal-debug\.[cm]?[jt]sx?(\?|$)/.test(norm) &&
    (norm.includes("/@rangojs/router/") ||
      norm.includes("/packages/rangojs-router/"))
  );
}

/**
 * Transform: replace the module with the resolved literal.
 * Returns null for any module that is not the router's internal-debug module.
 */
export function injectClientDebugFlag(
  id: string,
): { code: string; map: null } | null {
  // Cheap early-out: this hook runs on every module in every environment.
  if (!isRouterInternalDebugId(id)) return null;
  // Emit the whole module: internal-debug.ts has a single export, kept in sync.
  return {
    code: `export const INTERNAL_RANGO_DEBUG = ${!!process.env.INTERNAL_RANGO_DEBUG};\n`,
    map: null,
  };
}

/**
 * Dev middleware companion: serve the internal-debug module `no-cache` so the
 * browser revalidates it (etag) instead of trusting an immutable cache entry.
 *
 * Why: the transform bakes the flag into module CONTENT, but a published
 * consumer resolves the module into node_modules, where dev serves it as
 * `internal-debug.ts?v=<hash>` with `Cache-Control: max-age=31536000,immutable`.
 * That `?v=` hash does not vary with env vars (verified on Vite 8: getConfigHash
 * hashes NODE_ENV, resolve, plugin names, optimizeDeps -- not arbitrary env
 * state), so toggling the flag changed the content under an unchanged immutable
 * URL: a browser that ever loaded the app with the flag off kept the
 * baked-`false` module across dev-server restarts, and INTERNAL_RANGO_DEBUG
 * never reached the FE logs while the server logs worked. The monorepo was
 * immune -- workspace source is outside node_modules and served no-cache --
 * which is why this bit only npm consumers.
 *
 * internal-debug.ts is the ONLY flag-varying module in the graph (its importers
 * are byte-identical across flag states), so forcing revalidation for this one
 * tiny module is sufficient and costs one conditional request per session. The
 * middleware is unconditional (not gated on the flag) so an already-poisoned
 * cache heals in both directions. Alternatives that do not work: a plugin
 * `resolveId` appending a flag query never fires in Vite 8 dev for
 * fs-resolvable relative imports, and the pre-#621 `define` no longer rotates
 * the optimizer hash (define contents are not part of getConfigHash).
 */
export function internalDebugNoCacheMiddleware(): Connect.NextHandleFunction {
  return function rangoInternalDebugNoCache(req, res, next) {
    if (req.url && isRouterInternalDebugId(req.url)) {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        return setHeader(
          name,
          name.toLowerCase() === "cache-control" ? "no-cache" : value,
        );
      };
    }
    next();
  };
}
