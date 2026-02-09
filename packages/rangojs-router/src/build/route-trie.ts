/**
 * Build-time Route Trie Construction
 *
 * Builds a serializable trie from the route manifest for O(path_length)
 * route matching at runtime. Each trie leaf embeds the route's ancestry
 * shortCodes for layout pruning.
 */

import { parsePattern, type ParsedSegment } from "../router/pattern-matching.js";

// -- Trie data structures (compact keys for JSON serialization) --

export interface TrieLeaf {
  /** Route name (e.g., "site.l1_500") */
  n: string;
  /** Static prefix of the entry (e.g., "/site") */
  sp: string;
  /** Ancestry shortCodes from root to route [M0L0, M0L0L0, M0L0L0R499] */
  a: string[];
  /** Optional param names (absent params get empty string value) */
  op?: string[];
  /** Constraint validation: paramName -> allowed values */
  cv?: Record<string, string[]>;
  /** Trailing slash mode */
  ts?: string;
  /** Route has pre-rendered data available */
  pr?: true;
  /** Passthrough: handler kept in bundle for live fallback on unknown params */
  pt?: true;
  /** Response type for non-RSC routes (json, text, image, any) */
  rt?: string;
}

export interface TrieNode {
  /** Route terminal at this node */
  r?: TrieLeaf;
  /** Static segment children */
  s?: Record<string, TrieNode>;
  /** Param child: { n: paramName, c: child node } */
  p?: { n: string; c: TrieNode };
  /** Wildcard terminal: leaf + paramName */
  w?: TrieLeaf & { pn: string };
}

/**
 * Build a route trie from build-time manifest data.
 *
 * @param routeManifest - Map of route name to full URL pattern
 * @param routeAncestry - Map of route name to ancestry shortCodes
 * @param routeToStaticPrefix - Map of route name to its entry's staticPrefix
 * @param routeTrailingSlash - Optional map of route name to trailing slash mode
 */
export function buildRouteTrie(
  routeManifest: Record<string, string>,
  routeAncestry: Record<string, string[]>,
  routeToStaticPrefix: Record<string, string>,
  routeTrailingSlash?: Record<string, string>,
  prerenderRouteNames?: Set<string>,
  passthroughRouteNames?: Set<string>,
  responseTypeRoutes?: Record<string, string>,
): TrieNode {
  const root: TrieNode = {};

  for (const [routeName, pattern] of Object.entries(routeManifest)) {
    const ancestry = routeAncestry[routeName] || [];
    const staticPrefix = routeToStaticPrefix[routeName] || "";
    const trailingSlash = routeTrailingSlash?.[routeName];
    const responseType = responseTypeRoutes?.[routeName];

    // Detect and strip trailing slash from pattern for parsing
    const hasTrailingSlash = pattern.length > 1 && pattern.endsWith("/");
    const normalizedPattern = hasTrailingSlash ? pattern.slice(0, -1) : pattern;

    const segments = parsePattern(normalizedPattern);
    insertRoute(root, segments, 0, {
      n: routeName,
      sp: staticPrefix,
      a: ancestry,
      ...(trailingSlash ? { ts: trailingSlash } : {}),
      ...(prerenderRouteNames?.has(routeName) ? { pr: true } : {}),
      ...(passthroughRouteNames?.has(routeName) ? { pt: true } : {}),
      ...(responseType ? { rt: responseType } : {}),
    });
  }

  return root;
}

/**
 * Insert a route into the trie, handling optional params by forking
 * the insertion path (one terminal without the param, one with).
 */
function insertRoute(
  node: TrieNode,
  segments: ParsedSegment[],
  index: number,
  leaf: Omit<TrieLeaf, "op" | "cv">,
): void {
  // Collect optional param names and constraints across all segments
  const optionalParams: string[] = [];
  const constraints: Record<string, string[]> = {};

  for (const seg of segments) {
    if (seg.type === "param" && seg.optional) {
      optionalParams.push(seg.value);
    }
    if (seg.type === "param" && seg.constraint) {
      constraints[seg.value] = seg.constraint;
    }
  }

  const fullLeaf: TrieLeaf = {
    ...leaf,
    ...(optionalParams.length > 0 ? { op: optionalParams } : {}),
    ...(Object.keys(constraints).length > 0 ? { cv: constraints } : {}),
  };

  insertSegments(node, segments, index, fullLeaf);
}

/**
 * Recursively insert segments into the trie.
 * For optional params, we add a terminal at the current node (param absent)
 * AND continue inserting into the param child (param present).
 */
/**
 * Extract ancestry map from a built trie by visiting all leaf nodes.
 * Returns { routeName: ancestryShortCodes[] } for every route in the trie.
 */
export function extractAncestryFromTrie(
  root: TrieNode,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  function visit(node: TrieNode): void {
    if (node.r) {
      result[node.r.n] = node.r.a;
    }
    if (node.w) {
      result[node.w.n] = node.w.a;
    }
    if (node.s) {
      for (const child of Object.values(node.s)) {
        visit(child);
      }
    }
    if (node.p) {
      visit(node.p.c);
    }
  }

  visit(root);
  return result;
}

function insertSegments(
  node: TrieNode,
  segments: ParsedSegment[],
  index: number,
  leaf: TrieLeaf,
): void {
  // Base case: all segments consumed, add terminal
  if (index >= segments.length) {
    node.r = leaf;
    return;
  }

  const segment = segments[index];

  if (segment.type === "static") {
    if (!node.s) node.s = {};
    if (!node.s[segment.value]) node.s[segment.value] = {};
    insertSegments(node.s[segment.value], segments, index + 1, leaf);
  } else if (segment.type === "param") {
    if (segment.optional) {
      // Optional param: add terminal at current node (param absent)
      node.r = leaf;
      // AND continue with param child (param present)
    }
    if (!node.p) {
      node.p = { n: segment.value, c: {} };
    }
    insertSegments(node.p.c, segments, index + 1, leaf);
  } else if (segment.type === "wildcard") {
    // Wildcard consumes all remaining segments
    node.w = { ...leaf, pn: "*" };
  }
}
