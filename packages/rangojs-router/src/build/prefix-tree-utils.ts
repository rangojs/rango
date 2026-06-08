/**
 * Pure prefix-tree walks shared by the build/discovery layer and the runtime
 * trie builder. Kept in `build/` (not `vite/utils`) so runtime code
 * (rsc/manifest-init via build/route-trie) can consume them without importing
 * from the vite layer. `vite/utils/manifest-utils` re-exports them so existing
 * vite-side imports stay unchanged.
 */

/**
 * Flatten prefix tree leaf nodes into precomputed route entries.
 * Leaf nodes have no children (no nested includes), so their routes can be
 * used directly by evaluateLazyEntry() without running the handler.
 * Non-leaf nodes are skipped because they have nested lazy includes that
 * require the handler to run for discovery.
 *
 * A leaf is also skipped when its staticPrefix collides with an ancestor
 * include node's staticPrefix. That happens when a dynamic param collapses the
 * staticPrefix of nested includes onto the parent's (e.g. `/m/:id/edit` -> sp
 * `/m`): precomputing such a leaf under the collapsed prefix would let the
 * ancestor's lazy entry claim a route it cannot register (the route is behind
 * further nested lazy includes), producing a RouteNotFoundError at request time
 * (issue #506). Those routes are resolved via the handler chain instead.
 */
export function flattenLeafEntries(
  prefixTree: Record<string, any>,
  routeManifest: Record<string, string>,
  result: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): void {
  function visit(node: any, ancestorStaticPrefixes: Set<string>): void {
    const children = node.children || {};
    if (
      Object.keys(children).length === 0 &&
      node.routes &&
      node.routes.length > 0
    ) {
      // Leaf node. Skip if its staticPrefix collides with an ancestor include
      // node's staticPrefix (dynamic-param collapse) — see doc comment above.
      if (ancestorStaticPrefixes.has(node.staticPrefix)) {
        return;
      }
      // Collect its routes from the manifest
      const routes: Record<string, string> = {};
      for (const name of node.routes) {
        if (name in routeManifest) {
          routes[name] = routeManifest[name];
        }
      }
      result.push({ staticPrefix: node.staticPrefix, routes });
    } else {
      // Non-leaf: recurse into children, tracking this node's staticPrefix as
      // an ancestor so a collapsed nested leaf below it is not over-claimed.
      const nextAncestors = new Set(ancestorStaticPrefixes);
      nextAncestors.add(node.staticPrefix);
      for (const child of Object.values(children)) {
        visit(child, nextAncestors);
      }
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node, new Set());
  }
}

/**
 * Build the staticPrefix -> routes lookup the runtime shortcut consumes from a
 * flat precomputed-entry array.
 *
 * A staticPrefix owned by MORE THAN ONE leaf include cannot be collapsed to a
 * single routes object: `new Map(entries.map(e => [e.staticPrefix, e.routes]))`
 * is last-wins, so one include's routes are silently dropped and mis-assigned
 * to whichever entry evaluates first. Two distinct includes legitimately share a
 * staticPrefix when a dynamic param collapses their literal prefixes onto the
 * same value (e.g. `include("/shop/:cat", ...)` and a nested
 * `include("/shop/:brand", ...)` both extract "/shop/"). Merging them is also
 * wrong — assigning the merged set to the first matching entry makes findMatch
 * pick the wrong handler for routes belonging to the other include, which then
 * fails its `Store.manifest.has(routeKey)` invariant at render (500 on a valid
 * route, dev/prod identical).
 *
 * So any shared staticPrefix is OMITTED from the shortcut entirely. Those
 * includes fall through to the handler path in evaluateLazyEntry(), which is the
 * ground truth (identical to pre-precomputed behavior). The shortcut is purely an
 * optimization, so dropping a prefix can only cost a handler run, never change a
 * result.
 */
export function buildPrecomputedByPrefix(
  entries: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): Map<string, Record<string, string>> {
  const byPrefix = new Map<string, Record<string, string>>();
  const shared = new Set<string>();
  for (const e of entries) {
    if (byPrefix.has(e.staticPrefix)) {
      shared.add(e.staticPrefix);
    } else {
      byPrefix.set(e.staticPrefix, e.routes);
    }
  }
  for (const sp of shared) {
    byPrefix.delete(sp);
  }
  return byPrefix;
}

/**
 * Walk prefix tree to map each route name to its scope's staticPrefix.
 */
export function buildRouteToStaticPrefix(
  prefixTree: Record<string, any>,
  result: Record<string, string>,
): void {
  function visit(node: any): void {
    const sp = node.staticPrefix || "";
    for (const name of node.routes || []) {
      result[name] = sp;
    }
    for (const child of Object.values(node.children || {})) {
      visit(child);
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
}
