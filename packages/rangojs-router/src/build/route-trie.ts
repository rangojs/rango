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
import { buildRouteToStaticPrefix } from "./prefix-tree-utils.js";
import type { FullManifest } from "./generate-manifest.js";

// -- Trie data structures (compact keys for JSON serialization) --

export interface TrieLeaf {
  /** Route name (e.g., "site.l1_500") */
  n: string;
  /** Static prefix of the entry (e.g., "/site") */
  sp: string;
  /** Ancestry shortCodes from root to route [M0L0, M0L0L0, M0L0L0R499] */
  a: string[];
  /** Optional param names declared on the route. Absent params are
   * omitted from the matched params record (read as `undefined`). */
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
 * Build a per-router trie from a generated manifest. This is the single
 * construction path shared by build/discovery (discover-routers.ts, serialized
 * into the production chunk) and the dev/HMR runtime rebuild
 * (rsc/manifest-init.ts). Keeping one code path is what guarantees the dev
 * runtime trie and the production serialized trie are byte-for-byte identical
 * (modulo `leaf.a` ancestry, which embeds the mount index and is debug-only).
 *
 * Returns null when the manifest has no route ancestry (no routes), matching
 * the prior guard at both call sites.
 */
export function buildPerRouterTrie(manifest: FullManifest): TrieNode | null {
  const ancestry = manifest._routeAncestry;
  if (!ancestry || Object.keys(ancestry).length === 0) {
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
    ancestry,
    routeToStaticPrefix,
    manifest.routeTrailingSlash,
    manifest.prerenderRoutes ? new Set(manifest.prerenderRoutes) : undefined,
    manifest.passthroughRoutes
      ? new Set(manifest.passthroughRoutes)
      : undefined,
    manifest.responseTypeRoutes,
  );
}

/**
 * Insert a route into the trie. Optional params expand into two branches at
 * registration time (skip-first, then present), so each terminal lives at the
 * correct depth for its number of bound params and carries a branch-local
 * `pa` listing only those names. The trie's single-slot `node.p` is reused
 * across branches because matching ignores `node.p.n` — the leaf's `pa` is
 * the source of truth for naming. Skip-first ordering lets `mergeLeaf`'s
 * last-wins rule produce greedy-leftmost semantics for free at any shared
 * terminal depth.
 */
function insertRoute(
  node: TrieNode,
  segments: ParsedSegment[],
  index: number,
  leaf: Omit<TrieLeaf, "op" | "cv" | "pa">,
): void {
  // op (full optional list) and cv (full constraint map) are route-level and
  // identical on every terminal, so compute them once on the shared base.
  const optionalParams: string[] = [];
  const constraints: Record<string, string[]> = {};

  for (const seg of segments) {
    if (seg.type === "param") {
      if (seg.optional) {
        optionalParams.push(seg.value);
      }
      if (seg.constraint) {
        constraints[seg.value] = seg.constraint;
      }
    }
  }

  const leafBase: Omit<TrieLeaf, "pa"> = {
    ...leaf,
    ...(optionalParams.length > 0 ? { op: optionalParams } : {}),
    ...(Object.keys(constraints).length > 0 ? { cv: constraints } : {}),
  };

  insertSegments(node, segments, index, leafBase, []);
}

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

function buildLeaf(
  leafBase: Omit<TrieLeaf, "pa">,
  paramNames: string[],
): TrieLeaf {
  return paramNames.length > 0
    ? { ...leafBase, pa: [...paramNames] }
    : { ...leafBase };
}

function insertSegments(
  node: TrieNode,
  segments: ParsedSegment[],
  index: number,
  leafBase: Omit<TrieLeaf, "pa">,
  paramNames: string[],
): void {
  // Base case: all segments consumed, add terminal with branch-local pa
  if (index >= segments.length) {
    mergeLeaf(node, buildLeaf(leafBase, paramNames));
    return;
  }

  const segment = segments[index];

  if (segment.type === "static") {
    if (!node.s) node.s = {};
    if (!node.s[segment.value]) node.s[segment.value] = {};
    insertSegments(
      node.s[segment.value],
      segments,
      index + 1,
      leafBase,
      paramNames,
    );
  } else if (segment.type === "param") {
    if (segment.optional) {
      // SKIP first: continue at the same node without binding this name.
      // Skip-first ordering means the present-branch's TAKE overwrites any
      // shared terminal later, giving greedy-leftmost semantics.
      insertSegments(node, segments, index + 1, leafBase, paramNames);
    }
    if (segment.suffix) {
      // Suffix param: keyed by suffix string (e.g., ".html")
      if (!node.xp) node.xp = {};
      if (!node.xp[segment.suffix]) {
        node.xp[segment.suffix] = { n: segment.value, c: {} };
      }
      insertSegments(node.xp[segment.suffix].c, segments, index + 1, leafBase, [
        ...paramNames,
        segment.value,
      ]);
    } else {
      if (!node.p) {
        node.p = { n: segment.value, c: {} };
      }
      insertSegments(node.p.c, segments, index + 1, leafBase, [
        ...paramNames,
        segment.value,
      ]);
    }
  } else if (segment.type === "wildcard") {
    // Wildcard consumes all remaining segments. Carry any params bound before
    // the wildcard in pa so they zip correctly against paramValues at match.
    const wildLeaf: TrieLeaf & { pn: string } = {
      ...buildLeaf(leafBase, paramNames),
      pn: "*",
    };
    const existing = node.w ? ({ ...node.w } as TrieLeaf) : undefined;
    const merged = mergeLeaves(existing, wildLeaf);
    node.w = merged as TrieLeaf & { pn: string };
  }
}
