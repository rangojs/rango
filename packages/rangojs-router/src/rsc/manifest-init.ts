/**
 * Router Manifest Initialization
 *
 * Builds a fresh route trie from every registered URL-pattern mount for
 * dev/HMR scenarios where the manifest exists but the trie needs rebuilding.
 */

import {
  ensureRouterManifest,
  getGlobalRouteMap,
  getRouterManifest,
  getRouterTrie,
  hasCachedManifest,
  isRouterTrieAuthoritative,
  setCachedManifest,
  setRouterManifest,
  setRouterTrie,
  setRouterPrecomputedEntries,
} from "../route-map-builder.js";
import { mergeFullManifests } from "../build/merge-full-manifests.js";
import { isTransitionWhenValidationEnabled } from "../transition-when-ref.js";
import type { TrieNode } from "../router/route-trie-builder.js";

// A zero-route router builds no trie; recording that keeps it from rebuilding.
const NO_TRIE: unique symbol = Symbol("rango.noTrie");

// The trie each router object last installed. Router ids need not be unique
// across instances (a test helper calling createRouter({ id }) per test), and
// the per-id trie map cannot tell which instance a trie came from.
const installedTries = new WeakMap<object, TrieNode | typeof NO_TRIE>();

/** True when the trie installed for `router.id` was built from this router. */
export function isRouterTrieBuiltFrom(router: { id?: string }): boolean {
  if (router.id === undefined) return false;
  const installed = installedTries.get(router);
  return (
    installed !== undefined &&
    installed === (getRouterTrie(router.id) ?? NO_TRIE)
  );
}

/** The router fields ensureRouterTrie reads. */
export interface TrieSource {
  id?: string;
  urlpatterns?: unknown;
  routeMap: Record<string, unknown>;
}

/**
 * Install the trie `router` matches through, as a request finds it: the build
 * manifest's trie when one is registered for its id, otherwise one built from
 * its routes the way the dev handler builds it (rsc/handler.ts). Ids can repeat
 * across router objects (tests), and another object's trie names other routes,
 * so a trie this object did not build is rebuilt. Seeds the per-router manifest
 * from `router.routeMap` when neither source set one, for reverse(). testing's
 * dispatch matches through it, never the regex fallback alone (#1104, #1107).
 */
export async function ensureRouterTrie(router: TrieSource): Promise<void> {
  const id = router.id;
  if (!id) return;
  if (!isRouterTrieAuthoritative(id) && !isRouterTrieBuiltFrom(router)) {
    await ensureRouterManifest(id);
    if (router.urlpatterns && !isRouterTrieAuthoritative(id)) {
      await buildRouterTrieFromUrlpatterns(router);
    }
  }
  if (!getRouterManifest(id)) {
    setRouterManifest(id, router.routeMap as Record<string, string>);
  }
}

/**
 * Build a fresh route trie from the router's URL-pattern mounts and store it in
 * the per-router cache. Also sets the per-router manifest and merges into the
 * global manifest for reverse()/href().
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
  const mounts =
    router.__urlpatternMounts ??
    (router.urlpatterns
      ? [{ patterns: router.urlpatterns, mountIndex: undefined }]
      : []);
  // mount.mountIndex mirrors the live router's per-mount counter partitioning
  // (context.ts getShortCode `M{i}` prefixes), so entries generated here carry
  // the same shortCodes as runtime registration. Build discovery
  // (discover-routers.ts / runtime-discovery.ts) numbers mounts GLOBALLY across
  // routers instead — that divergence is invisible: shortCodes never leave
  // their realm, and route names (the trie keys) carry no mount index (unnamed
  // routes are `$path_*`, see path-helper.ts).
  const mountManifests = [];
  for (const mount of mounts) {
    mountManifests.push(
      await generateManifestFull(mount.patterns, mount.mountIndex, {
        routerId: router.id,
        ...(router.basename ? { urlPrefix: router.basename } : {}),
        // Under the Vite plugin the realm validates like discovery does, so
        // a Cloudflare dev rebuild fails on an invalid when too.
        validateTransitionWhen: isTransitionWhenValidationEnabled(),
      }),
    );
  }
  const generated = mergeFullManifests(mountManifests);
  // Build the trie through the SAME shared helper the production discovery uses
  // (discover-routers.ts), so the dev runtime-rebuilt trie and the prod
  // serialized trie cannot drift. buildPerRouterTrie returns null when there
  // are no routes.
  const { buildPerRouterTrie } = await import("../build/route-trie.js");
  const trie = buildPerRouterTrie(generated);
  if (trie) setRouterTrie(router.id, trie);
  // Re-read: setRouterTrie stores a copy (nullPrototypeStaticChildren).
  installedTries.set(router, trie ? getRouterTrie(router.id)! : NO_TRIE);
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
