/**
 * Build-time Route Trie Construction
 *
 * Adapts generated manifests to the runtime-owned route trie builder.
 */

import { buildRouteTrie, type TrieNode } from "../router/route-trie-builder.js";
import type { FullManifest } from "./generate-manifest.js";
import { buildRouteToStaticPrefix } from "./prefix-tree-utils.js";

export { buildRouteTrie };
export type {
  NegotiateVariant,
  TrieLeaf,
  TrieNode,
} from "../router/route-trie-builder.js";

/**
 * Build a per-router trie from a generated manifest. This is the single
 * construction path shared by build/discovery (discover-routers.ts, serialized
 * into the production chunk) and the dev/HMR runtime rebuild
 * (rsc/manifest-init.ts). Keeping one code path is what guarantees the dev
 * runtime trie and the production serialized trie are byte-for-byte identical.
 *
 * Returns null when the manifest has no routes, matching the prior guard at
 * both call sites.
 */
export function buildPerRouterTrie(manifest: FullManifest): TrieNode | null {
  if (Object.keys(manifest.routeManifest).length === 0) {
    return null;
  }

  // Seed every route to the root static prefix (""), then override with each
  // route's include() scope prefix from the prefix tree so the trie returns the
  // correct `sp` for lazy-entry lookup in find-match.
  const routeToStaticPrefix: Record<string, string> = {};
  for (const name of Object.keys(manifest.routeManifest)) {
    routeToStaticPrefix[name] = "";
  }
  if (manifest.prefixTree) {
    buildRouteToStaticPrefix(manifest.prefixTree, routeToStaticPrefix);
  }

  return buildRouteTrie(
    manifest.routeManifest,
    routeToStaticPrefix,
    manifest.routeTrailingSlash,
    manifest.prerenderRoutes ? new Set(manifest.prerenderRoutes) : undefined,
    manifest.passthroughRoutes
      ? new Set(manifest.passthroughRoutes)
      : undefined,
    manifest.responseTypeRoutes,
  );
}
