// Pure prefix-tree walks live in the build layer so runtime code can consume
// them without importing from vite/. Re-exported here for the vite-side
// callers (discover-routers, virtual-module-codegen) that already import them
// from this module.
export {
  flattenLeafEntries,
  buildRouteToStaticPrefix,
} from "../../build/prefix-tree-utils.js";

/**
 * Wrap a value as `JSON.parse('...')` instead of a JS object literal.
 * V8's JSON parser is significantly faster than its full JS parser for large
 * objects, so this improves startup time for big route manifests.
 */
export function jsonParseExpression(value: unknown): string {
  const json = JSON.stringify(value);
  const escaped = json.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `JSON.parse('${escaped}')`;
}
