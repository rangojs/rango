/**
 * Build-time Route Trie Construction
 *
 * Builds a serializable trie from the route manifest for O(path_length)
 * route matching at runtime. Each trie leaf embeds the route's ancestry
 * shortCodes for layout pruning.
 */

import {
  parsePattern,
  type ParsedSegment,
} from "../router/pattern-matching.js";

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
  /** Ordered param names for this route (positional) */
  pa?: string[];
  /** Trailing slash mode */
  ts?: string;
  /** Route has pre-rendered data available */
  pr?: true;
  /** Passthrough: handler kept in bundle for live fallback on unknown params */
  pt?: true;
  /** Response type for non-RSC routes (json, text, image, any) */
  rt?: string;
  /** Negotiate variants: response-type routes sharing this path */
  nv?: Array<{ routeKey: string; responseType: string }>;
  /** RSC-first: RSC route was defined before response-type variants */
  rf?: true;
}

export interface TrieNode {
  /** Route terminal at this node */
  r?: TrieLeaf;
  /** Static segment children */
  s?: Record<string, TrieNode>;
  /** Param child: { n: paramName, c: child node } */
  p?: { n: string; c: TrieNode };
  /** Suffix-param children keyed by suffix (e.g., ".html" → { n: "productId", c: ... }) */
  xp?: Record<string, { n: string; c: TrieNode }>;
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
  leaf: Omit<TrieLeaf, "op" | "cv" | "pa">,
): void {
  // Collect param names, optional param names, and constraints across all segments
  const paramNames: string[] = [];
  const optionalParams: string[] = [];
  const constraints: Record<string, string[]> = {};

  for (const seg of segments) {
    if (seg.type === "param") {
      paramNames.push(seg.value);
      if (seg.optional) {
        optionalParams.push(seg.value);
      }
      if (seg.constraint) {
        constraints[seg.value] = seg.constraint;
      }
    }
  }

  const fullLeaf: TrieLeaf = {
    ...leaf,
    ...(paramNames.length > 0 ? { pa: paramNames } : {}),
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
    if (node.xp) {
      for (const child of Object.values(node.xp)) {
        visit(child.c);
      }
    }
    if (node.p) {
      visit(node.p.c);
    }
  }

  visit(root);
  return result;
}

/**
 * Merge a new leaf with an existing leaf, handling content negotiation.
 * When an RSC route and response-type routes share the same URL pattern,
 * the RSC route becomes the primary leaf and response-type routes are
 * appended to the nv (negotiate variants) array.
 * Multiple response types on the same path are supported (json + text + xml).
 */
function mergeLeaves(existing: TrieLeaf | undefined, leaf: TrieLeaf): TrieLeaf {
  if (!existing) return leaf;

  if (existing.rt && leaf.rt) {
    // Both are response-type: preserve old as variant
    const merged = leaf;
    merged.nv = existing.nv || [];
    merged.nv.push({ routeKey: existing.n, responseType: existing.rt });
    return merged;
  }
  if (leaf.rt && !existing.rt) {
    // RSC primary exists, new leaf is response-type: append variant
    // RSC was defined first (it was already the existing leaf)
    if (!existing.nv) {
      existing.nv = [];
      existing.rf = true;
    }
    existing.nv.push({ routeKey: leaf.n, responseType: leaf.rt });
    return existing;
  }
  if (!leaf.rt && existing.rt) {
    // Response-type was primary, new leaf is RSC: swap and move old to variants
    // RSC was defined second (response-type was already the existing leaf)
    if (!leaf.nv) leaf.nv = [];
    if (existing.nv) leaf.nv.push(...existing.nv);
    leaf.nv.push({ routeKey: existing.n, responseType: existing.rt });
    // rf intentionally not set — RSC came after response-type variants
    return leaf;
  }
  // Both RSC (last wins): overwrite
  return leaf;
}

function mergeLeaf(node: TrieNode, leaf: TrieLeaf): void {
  node.r = mergeLeaves(node.r, leaf);
}

function insertSegments(
  node: TrieNode,
  segments: ParsedSegment[],
  index: number,
  leaf: TrieLeaf,
): void {
  // Base case: all segments consumed, add terminal
  if (index >= segments.length) {
    mergeLeaf(node, leaf);
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
      mergeLeaf(node, leaf);
      // AND continue with param child (param present)
    }
    if (segment.suffix) {
      // Suffix param: keyed by suffix string (e.g., ".html")
      if (!node.xp) node.xp = {};
      if (!node.xp[segment.suffix]) {
        node.xp[segment.suffix] = { n: segment.value, c: {} };
      }
      insertSegments(node.xp[segment.suffix].c, segments, index + 1, leaf);
    } else {
      if (!node.p) {
        node.p = { n: segment.value, c: {} };
      }
      insertSegments(node.p.c, segments, index + 1, leaf);
    }
  } else if (segment.type === "wildcard") {
    // Wildcard consumes all remaining segments
    const wildLeaf = { ...leaf, pn: "*" };
    const existing = node.w ? ({ ...node.w } as TrieLeaf) : undefined;
    const merged = mergeLeaves(existing, wildLeaf);
    node.w = merged as TrieLeaf & { pn: string };
  }
}
