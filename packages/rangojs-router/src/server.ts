/**
 * @rangojs/router/server — Internal subpath
 *
 * This module is NOT user-facing. Import from "@rangojs/router" instead.
 *
 * Exports here are consumed by the Vite plugin (discovery, manifest injection,
 * virtual modules) and the RSC handler internals. They are not part of the
 * public API and may change without notice.
 */

// Router registry (used by Vite plugin for build-time discovery)
export { RSC_ROUTER_BRAND, RouterRegistry } from "./router.js";

// Host router registry (used by Vite plugin for host-router lazy discovery)
export {
  HostRouterRegistry,
  type HostRouterRegistryEntry,
} from "./host/router.js";

// Route map builder (Vite plugin injects these via virtual modules)
export {
  registerRouteMap,
  setCachedManifest,
  clearCachedManifest,
  clearAllRouterData,
  getGlobalRouteMap,
  getRouterManifest,
  setManifestReadyPromise,
  setRouterManifest,
  setRouterTrie,
  setRouterPrecomputedEntries,
  registerRouterManifestLoader,
  ensureRouterManifest,
} from "./route-map-builder.js";

// Loader registry (Vite plugin registers lazy loader imports)
export {
  registerLoaderById,
  setLoaderImports,
} from "./server/loader-registry.js";

// Request context creation (used by RSC handler, not user-facing)
export {
  createRequestContext,
  type CreateRequestContextOptions,
} from "./server/request-context.js";

// Component utilities (used internally for server/client boundary checks)
export { isClientComponent, assertClientComponent } from "./component-utils.js";

// Client URL projection registry (Vite discovery/bootstrap bridge)
export {
  clearClientUrlProjections,
  setClientUrlProjection,
  type ClientUrlProjection,
} from "./client-urls/server-projection.js";
