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
  generateManifestFull,
  generateManifestCode,
  type GeneratedManifest,
} from "./generate-manifest.js";

// NOTE: buildRouteTrie / buildPerRouterTrie / collectFallbackClientRefs and the
// TrieNode/TrieLeaf types are realm-crossing build internals. They cannot move
// to a ./build/internal subpath (#569 decision 6) because the Vite discovery
// pipeline imports them at build time via `runner.import("@rangojs/router/build")`
// (see vite/discovery/discover-routers.ts) and the RSC runner does not resolve
// the subpath in that realm. Internalizing them needs runner subpath resolution
// or a different seam — tracked under #569.
export {
  buildRouteTrie,
  buildPerRouterTrie,
  type TrieNode,
  type TrieLeaf,
} from "./route-trie.js";

export { collectFallbackClientRefs } from "./collect-fallback-refs.js";

export {
  writePerModuleRouteTypes,
  extractRoutesFromSource,
  generatePerModuleTypesSource,
  createScanFilter,
  type ScanFilter,
} from "./generate-route-types.js";

export { hashParams } from "../prerender/param-hash.js";
