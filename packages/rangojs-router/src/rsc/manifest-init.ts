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
  setRouterManifest,
  setRouterTrie,
  setRouterPrecomputedEntries,
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
  const generated = await generateManifestFull(router.urlpatterns, undefined, {
    routerId: router.id,
    ...(router.basename ? { urlPrefix: router.basename } : {}),
  });
  // Build the trie through the SAME shared helper the production discovery uses
  // (discover-routers.ts), so the dev runtime-rebuilt trie and the prod
  // serialized trie cannot drift. buildPerRouterTrie returns null when there
  // are no routes.
  const { buildPerRouterTrie } = await import("../build/route-trie.js");
  const trie = buildPerRouterTrie(generated);
  if (trie) {
    setRouterTrie(router.id, trie);
  }
  setRouterManifest(router.id, generated.routeManifest);

  // Match the production discovery path: precompute leaf-include entries so the
  // match-time shortcut in evaluateLazyEntry applies in dev/Cloudflare too.
  // Without this, dev re-runs each matched leaf include's handler at match time
  // (evaluateLazyEntry) AND again at render time (loadManifest); with it, the
  // match-time run is skipped and the handler runs once per first request.
  // Identical route ownership to the handler path (the shortcut is guarded by
  // the same prefixIsShared and #506 checks production uses).
  const { flattenLeafEntries } = await import("../build/prefix-tree-utils.js");
  const precomputed: Array<{
    staticPrefix: string;
    routes: Record<string, string>;
  }> = [];
  flattenLeafEntries(
    generated.prefixTree,
    generated.routeManifest,
    precomputed,
  );
  setRouterPrecomputedEntries(router.id, precomputed);

  // Merge into global manifest (needed for reverse/href across routers)
  const existing = hasCachedManifest() ? getGlobalRouteMap() : {};
  setCachedManifest({ ...existing, ...generated.routeManifest });
}
