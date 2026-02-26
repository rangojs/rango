// Plugins
export { exposeActionId } from "./plugins/expose-action-id.js";
export {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.js";
export type { ExposeInternalIdsApi } from "./plugins/expose-internal-ids.js";
export { createVersionPlugin } from "./plugins/version-plugin.js";
export { createVirtualStubPlugin } from "./plugins/virtual-stub-plugin.js";
export {
  computeProductionHash,
  transformClientRefs,
  hashClientRefs,
} from "./plugins/client-ref-hashing.js";
export { createVersionInjectorPlugin } from "./plugins/version-injector.js";
export { createCjsToEsmPlugin } from "./plugins/cjs-to-esm.js";

// Types
export type {
  RscEntries,
  RscPluginOptions,
  RangoNodeOptions,
  RangoCloudflareOptions,
  RangoOptions,
} from "./plugin-types.js";

// Utils
export {
  sharedEsbuildOptions,
  createVirtualEntriesPlugin,
  onwarn,
  getManualChunks,
} from "./utils/shared-utils.js";
export {
  flattenLeafEntries,
  buildRouteToStaticPrefix,
  jsonParseExpression,
} from "./utils/manifest-utils.js";
export {
  findMatchingParenInBundle,
  extractHandlerExportsFromChunk,
  evictHandlerCode,
} from "./utils/bundle-analysis.js";
export {
  encodePathParam,
  runWithConcurrency,
  groupByConcurrency,
  notifyOnError,
} from "./utils/prerender-utils.js";
export { printBanner, rangoVersion } from "./utils/banner.js";

// Core
export {
  createRouterDiscoveryPlugin,
  VIRTUAL_ROUTES_MANIFEST_ID,
} from "./router-discovery.js";
export { rango } from "./rango.js";
