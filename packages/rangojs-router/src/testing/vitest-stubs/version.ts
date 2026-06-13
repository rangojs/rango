// Stub for the build-only `@rangojs/router:version` virtual module, shipped so
// consumers do not have to author it. The rango Vite plugin injects this at
// build time; in a bare Vitest process it must be aliased to a stub. Empty
// string keeps generated URLs free of a version path segment.
export const VERSION = "";
