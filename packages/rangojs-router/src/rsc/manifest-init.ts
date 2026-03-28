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
  if (
    generated._routeAncestry &&
    Object.keys(generated._routeAncestry).length > 0
  ) {
    const { buildRouteTrie } = await import("../build/route-trie.js");
    // Map each route to its include() staticPrefix so the trie
    // returns the correct sp for lazy entry lookup in findMatch.
    const routeToStaticPrefix: Record<string, string> = {};
    for (const name of Object.keys(generated.routeManifest)) {
      routeToStaticPrefix[name] = "";
    }
    // Override with prefix from include() entries so the trie
    // returns the correct sp for lazy entry lookup in findMatch.
    // Walk recursively to include routes in nested includes.
    if (generated.prefixTree) {
      const visitPrefixNode = (node: any): void => {
        const sp = node.staticPrefix || "";
        for (const route of node.routes || []) {
          routeToStaticPrefix[route] = sp;
        }
        for (const child of Object.values(node.children || {})) {
          visitPrefixNode(child);
        }
      };
      for (const node of Object.values(generated.prefixTree)) {
        visitPrefixNode(node);
      }
    }
    const trie = buildRouteTrie(
      generated.routeManifest,
      generated._routeAncestry,
      routeToStaticPrefix,
      generated.routeTrailingSlash,
      generated.prerenderRoutes
        ? new Set(generated.prerenderRoutes)
        : undefined,
      generated.passthroughRoutes
        ? new Set(generated.passthroughRoutes)
        : undefined,
      generated.responseTypeRoutes,
    );
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
