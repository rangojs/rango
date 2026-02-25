/**
 * Build-time utilities for @rangojs/router
 *
 * Note: Route manifest is automatically generated at runtime on first request.
 * These build-time utilities are only needed for advanced use cases like
 * custom tooling or pre-generating manifests.
 *
 * @example Generate manifest programmatically (for custom tooling)
 * ```typescript
 * import { generateManifest } from "@rangojs/router/build";
 * import { urlpatterns } from "./urls";
 *
 * const manifest = generateManifest(urlpatterns);
 * console.log(manifest.routeManifest); // { home: "/", about: "/about", ... }
 * ```
 */

export {
  generateManifest,
  generateManifestCode,
  type GeneratedManifest,
} from "./generate-manifest.js";

export { buildRouteTrie, type TrieNode, type TrieLeaf } from "./route-trie.js";

export {
  writePerModuleRouteTypes,
  extractRoutesFromSource,
  generatePerModuleTypesSource,
  createScanFilter,
  type ScanFilter,
} from "./generate-route-types.js";

export { hashParams } from "../prerender/param-hash.js";
