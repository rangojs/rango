/**
 * Flatten prefix tree leaf nodes into precomputed route entries.
 * Leaf nodes have no children (no nested includes), so their routes can be
 * used directly by evaluateLazyEntry() without running the handler.
 * Non-leaf nodes are skipped because they have nested lazy includes that
 * require the handler to run for discovery.
 */
export function flattenLeafEntries(
  prefixTree: Record<string, any>,
  routeManifest: Record<string, string>,
  result: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): void {
  function visit(node: any): void {
    const children = node.children || {};
    if (
      Object.keys(children).length === 0 &&
      node.routes &&
      node.routes.length > 0
    ) {
      // Leaf node: collect its routes from the manifest
      const routes: Record<string, string> = {};
      for (const name of node.routes) {
        if (name in routeManifest) {
          routes[name] = routeManifest[name];
        }
      }
      result.push({ staticPrefix: node.staticPrefix, routes });
    } else {
      // Non-leaf: recurse into children
      for (const child of Object.values(children)) {
        visit(child);
      }
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
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

/**
 * Wrap a value as `JSON.parse('...')` instead of a JS object literal.
 * V8's JSON parser is significantly faster than its full JS parser for large
 * objects, so this improves startup time for big route manifests.
 */
export function jsonParseExpression(value: unknown): string {
  const json = JSON.stringify(value);
  const escaped = json.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `JSON.parse('${escaped}')`;
}
