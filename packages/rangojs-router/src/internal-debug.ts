// Runtime fallback for non-Vite contexts (Node, tests, raw imports). In the Vite
// pipeline -- dev and build, every environment -- the router discovery plugin's
// transform replaces this module with the build-time-resolved flag (see
// vite/inject-client-debug.ts), so the CLIENT debug flag no longer depends on a
// `__RANGO_DEBUG__` define being delivered to the browser (which dev did only as
// an injected global whose presence varied across consumer setups).
//
// Keep this module to the single INTERNAL_RANGO_DEBUG export: the transform
// replaces the whole file, so a second export would be dropped from the bundle.
export const INTERNAL_RANGO_DEBUG: boolean =
  typeof process !== "undefined" &&
  Boolean((process as any).env?.INTERNAL_RANGO_DEBUG);
