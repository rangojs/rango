// Plugins
export { exposeActionId } from "./plugins/expose-action-id.ts";
export {
  exposeInternalIds,
  exposeRouterId,
} from "./plugins/expose-internal-ids.ts";
export type { ExposeInternalIdsApi } from "./plugins/expose-internal-ids.ts";
export { createVersionPlugin } from "./plugins/version-plugin.ts";
export { createVirtualStubPlugin } from "./plugins/virtual-stub-plugin.ts";
export {
  computeProductionHash,
  transformClientRefs,
  hashClientRefs,
} from "./plugins/client-ref-hashing.ts";
export { createVersionInjectorPlugin } from "./plugins/version-injector.ts";
export { createCjsToEsmPlugin } from "./plugins/cjs-to-esm.ts";

// Types
export type {
  RscEntries,
  RscPluginOptions,
  RangoNodeOptions,
  RangoCloudflareOptions,
  RangoOptions,
} from "./plugin-types.ts";

// Utils
export {
  sharedEsbuildOptions,
  createVirtualEntriesPlugin,
  onwarn,
  getManualChunks,
} from "./utils/shared-utils.ts";
export {
  flattenLeafEntries,
  buildRouteToStaticPrefix,
  jsonParseExpression,
} from "./utils/manifest-utils.ts";
export {
  findMatchingParenInBundle,
  extractHandlerExportsFromChunk,
  evictHandlerCode,
} from "./utils/bundle-analysis.ts";
export {
  encodePathParam,
  runWithConcurrency,
  groupByConcurrency,
  notifyOnError,
} from "./utils/prerender-utils.ts";
export { printBanner, rangoVersion } from "./utils/banner.ts";

// Core
export {
  createRouterDiscoveryPlugin,
  VIRTUAL_ROUTES_MANIFEST_ID,
} from "./router-discovery.ts";
export { rango } from "./rango.ts";
