/**
 * Mock for rsc-router:version virtual module.
 * Used by vitest since the virtual module is only available at build time.
 * Empty string disables version path in URLs for simpler test assertions.
 * No build table: a test installs one through setBuildVersions
 * (@rangojs/router/testing) when it needs per-router versions.
 */
export const VERSION = "";
export const ROUTER_VERSIONS: undefined = undefined;
