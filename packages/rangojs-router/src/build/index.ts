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
 * // Async: generateManifest awaits any async include() providers
 * // (`() => import("./routes")`) so the split groups appear in the manifest.
 * const manifest = await generateManifest(urlpatterns);
 * console.log(manifest.routeManifest); // { home: "/", about: "/about", ... }
 * ```
 */

export {
  generateManifest,
  generateManifestFull,
  generateManifestCode,
  type GeneratedManifest,
} from "./generate-manifest.js";

// buildRouteTrie / buildPerRouterTrie / collectFallbackClientRefs and the
// TrieNode/TrieLeaf types are NOT exported here: they are build-pipeline
// internals, not public API. Their only build-time consumer (the Vite
// discovery pass) imports them directly from source via a relative path
// (vite/discovery/discover-routers.ts), and the runtime RSC realm likewise
// imports route-trie.js directly (rsc/manifest-init.ts). Keeping them off the
// public ./build surface (#569 decision 6) means consumers can't mistake them
// for intended API. generateManifest* / route-types / hashParams stay public.
export {
  writePerModuleRouteTypes,
  extractRoutesFromSource,
  generatePerModuleTypesSource,
  createScanFilter,
  type ScanFilter,
} from "./generate-route-types.js";

export { hashParams } from "../prerender/param-hash.js";
