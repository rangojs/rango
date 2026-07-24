import type { FullManifest, PrefixTreeNode } from "./generate-manifest.js";

function clonePrefixNode(node: PrefixTreeNode): PrefixTreeNode {
  return {
    staticPrefix: node.staticPrefix,
    fullPrefix: node.fullPrefix,
    ...(node.namePrefix === undefined ? {} : { namePrefix: node.namePrefix }),
    children: clonePrefixTree(node.children),
    routes: [...node.routes],
  };
}

function clonePrefixTree(
  tree: Record<string, PrefixTreeNode>,
): Record<string, PrefixTreeNode> {
  return Object.fromEntries(
    Object.entries(tree).map(([prefix, node]) => [
      prefix,
      clonePrefixNode(node),
    ]),
  );
}

function removeRoutesFromPrefixTree(
  tree: Record<string, PrefixTreeNode>,
  routeNames: ReadonlySet<string>,
): Record<string, PrefixTreeNode> {
  return Object.fromEntries(
    Object.entries(tree).map(([prefix, node]) => [
      prefix,
      {
        staticPrefix: node.staticPrefix,
        fullPrefix: node.fullPrefix,
        ...(node.namePrefix === undefined
          ? {}
          : { namePrefix: node.namePrefix }),
        children: removeRoutesFromPrefixTree(node.children, routeNames),
        routes: node.routes.filter((name) => !routeNames.has(name)),
      },
    ]),
  );
}

function mergePrefixTrees(
  earlier: Record<string, PrefixTreeNode>,
  later: Record<string, PrefixTreeNode>,
): Record<string, PrefixTreeNode> {
  const merged = clonePrefixTree(earlier);
  for (const [prefix, laterNode] of Object.entries(later)) {
    const earlierNode = merged[prefix];
    if (!earlierNode) {
      merged[prefix] = clonePrefixNode(laterNode);
      continue;
    }

    merged[prefix] = {
      staticPrefix: laterNode.staticPrefix,
      fullPrefix: laterNode.fullPrefix,
      ...(laterNode.namePrefix === undefined
        ? {}
        : { namePrefix: laterNode.namePrefix }),
      children: mergePrefixTrees(earlierNode.children, laterNode.children),
      routes: [...new Set([...earlierNode.routes, ...laterNode.routes])],
    };
  }
  return merged;
}

function mergeRouteRecord<T>(
  earlier: Record<string, T> | undefined,
  later: Record<string, T> | undefined,
  overwrittenRoutes: ReadonlySet<string>,
  cloneValue: (value: T) => T,
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
  for (const [name, value] of Object.entries(earlier ?? {})) {
    if (!overwrittenRoutes.has(name)) merged[name] = cloneValue(value);
  }
  for (const [name, value] of Object.entries(later ?? {})) {
    merged[name] = cloneValue(value);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeRouteList(
  earlier: readonly string[] | undefined,
  later: readonly string[] | undefined,
  overwrittenRoutes: ReadonlySet<string>,
): string[] | undefined {
  const merged = [
    ...(earlier ?? []).filter((name) => !overwrittenRoutes.has(name)),
    ...(later ?? []),
  ];
  const unique = [...new Set(merged)];
  return unique.length > 0 ? unique : undefined;
}

/** Merge ordered per-mount manifests without mutating any input manifest. */
export function mergeFullManifests(
  manifests: readonly FullManifest[],
): FullManifest {
  let merged: FullManifest = {
    prefixTree: {},
    routeManifest: {},
  };

  for (const manifest of manifests) {
    const overwrittenRoutes = new Set(Object.keys(manifest.routeManifest));
    const prefixTreeWithoutOverwrites = removeRoutesFromPrefixTree(
      merged.prefixTree,
      overwrittenRoutes,
    );

    merged = {
      prefixTree: mergePrefixTrees(
        prefixTreeWithoutOverwrites,
        manifest.prefixTree,
      ),
      routeManifest: {
        ...merged.routeManifest,
        ...manifest.routeManifest,
      },
      routeTrailingSlash: mergeRouteRecord(
        merged.routeTrailingSlash,
        manifest.routeTrailingSlash,
        overwrittenRoutes,
        (value) => value,
      ),
      prerenderRoutes: mergeRouteList(
        merged.prerenderRoutes,
        manifest.prerenderRoutes,
        overwrittenRoutes,
      ),
      passthroughRoutes: mergeRouteList(
        merged.passthroughRoutes,
        manifest.passthroughRoutes,
        overwrittenRoutes,
      ),
      responseTypeRoutes: mergeRouteRecord(
        merged.responseTypeRoutes,
        manifest.responseTypeRoutes,
        overwrittenRoutes,
        (value) => value,
      ),
      routeSearchSchemas: mergeRouteRecord(
        merged.routeSearchSchemas,
        manifest.routeSearchSchemas,
        overwrittenRoutes,
        (value) => ({ ...value }),
      ),
      _prerenderDefs: mergeRouteRecord(
        merged._prerenderDefs,
        manifest._prerenderDefs,
        overwrittenRoutes,
        (value) => value,
      ),
    };
  }

  return merged;
}
