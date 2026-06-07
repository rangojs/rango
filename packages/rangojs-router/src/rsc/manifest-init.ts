/**
 * Router Manifest Initialization
 *
 * Builds a fresh route trie from router.urlpatterns for dev/HMR scenarios
 * where the manifest exists but the trie needs rebuilding.
 */

import {
  getGlobalRouteMap,
  hasCachedManifest,
  setCachedManifest,
  getRouteTrie,
  setRouteTrie,
  setRouterManifest,
  setRouterTrie,
} from "../route-map-builder.js";

/**
 * Build a fresh route trie from router.urlpatterns and store it in the
 * per-router cache. Also sets the per-router manifest and merges into
 * the global manifest for reverse()/href().
 *
 * Called when manifest data may exist but the per-router trie is missing,
 * which happens in dev mode after HMR: the virtual module sets the manifest
 * from fresh gen files but skips the trie (which would be stale from initial
 * discovery). The trie is essential for correct wildcard priority -- without
 * it, the regex fallback matches catch-all patterns before specific routes.
 */
export async function buildRouterTrieFromUrlpatterns(
  router: any,
): Promise<void> {
  const { generateManifestFull } =
    await import("../build/generate-manifest.js");
  const generated = generateManifestFull(
    router.urlpatterns,
    undefined,
    router.basename ? { urlPrefix: router.basename } : undefined,
  );
  // Build the trie through the SAME shared helper the production discovery uses
  // (discover-routers.ts), so the dev runtime-rebuilt trie and the prod
  // serialized trie cannot drift. buildPerRouterTrie returns null when there
  // are no routes.
  const { buildPerRouterTrie } = await import("../build/route-trie.js");
  const trie = buildPerRouterTrie(generated);
  if (trie) {
    setRouterTrie(router.id, trie);
    // Set global trie only if not already set by another router
    if (!getRouteTrie()) {
      setRouteTrie(trie);
    }
  }
  setRouterManifest(router.id, generated.routeManifest);
  // Merge into global manifest (needed for reverse/href across routers)
  const existing = hasCachedManifest() ? getGlobalRouteMap() : {};
  setCachedManifest({ ...existing, ...generated.routeManifest });
}
