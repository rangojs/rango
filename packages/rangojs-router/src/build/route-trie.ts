/**
 * Build-time Route Trie Construction
 *
 * Builds a serializable trie from the route manifest for O(path_length)
 * route matching at runtime.
 */

import {
  parsePattern,
  type ParsedSegment,
} from "../router/pattern-matching.js";
import { buildRouteToStaticPrefix } from "./prefix-tree-utils.js";
import type { FullManifest } from "./generate-manifest.js";

// -- Trie data structures (compact keys for JSON serialization) --

/**
 * A response-type variant folded into a primary leaf's negotiate list. `pa` is
 * the variant's own positional param-name array, carried so the runtime can
 * re-key the matched params under the variant's names when it wins negotiation
 * (the trie match extracts params under the PRIMARY leaf's pa). Omitted when the
 * variant has no params; absent/identical pa means no re-key is needed.
 */
export interface NegotiateVariant {
  routeKey: string;
  responseType: string;
  pa?: string[];
}

export interface TrieLeaf {
  /** Route name (e.g., "site.l1_500") */
  n: string;
  /** Static prefix of the entry (e.g., "/site") */
  sp: string;
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
  /**
   * On-demand prerender eligible: the route opted into router.prerender()
   * refresh. Distinct from `pr` — an od route may have no build-baked entry yet
   * still needs a writable-overlay lookup at serve time.
   */
  od?: true;
  /** Response type for non-RSC routes (json, text, image, any) */
  rt?: string;
  /** Negotiate variants: response-type routes sharing this path */
  nv?: NegotiateVariant[];
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
  /**
   * Wildcard terminal: leaf + paramName (`pn`). `pn` is "*" for the bare `/*`
   * form and the param name for a named catch-all (`:name+`/`:name*`). `w1`
   * marks a one-or-more catch-all (`:name+`): the runtime walker then rejects
   * the zero-segment/empty-remainder case. Absent `w1` is zero-or-more.
   */
  w?: TrieLeaf & { pn: string; w1?: true };
}

/**
 * Build a route trie from build-time manifest data.
 *
 * @param routeManifest - Map of route name to full URL pattern
 * @param routeToStaticPrefix - Map of route name to its entry's staticPrefix
 * @param routeTrailingSlash - Optional map of route name to trailing slash mode
 * @param prerenderRouteNames - Optional set of prerendered route names (sets leaf.pr)
 * @param passthroughRouteNames - Optional set of passthrough route names (sets leaf.pt)
 * @param responseTypeRoutes - Optional map of route name to response type (sets leaf.rt)
 * @param onDemandRouteNames - Optional set of on-demand-eligible route names (sets leaf.od)
 */
export function buildRouteTrie(
  routeManifest: Record<string, string>,
  routeToStaticPrefix: Record<string, string>,
  routeTrailingSlash?: Record<string, string>,
  prerenderRouteNames?: Set<string>,
  passthroughRouteNames?: Set<string>,
  responseTypeRoutes?: Record<string, string>,
  onDemandRouteNames?: Set<string>,
): TrieNode {
  const root: TrieNode = {};

  for (const [routeName, pattern] of Object.entries(routeManifest)) {
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
      ...(trailingSlash ? { ts: trailingSlash } : {}),
      ...(prerenderRouteNames?.has(routeName) ? { pr: true } : {}),
      ...(passthroughRouteNames?.has(routeName) ? { pt: true } : {}),
      ...(onDemandRouteNames?.has(routeName) ? { od: true } : {}),
      ...(responseType ? { rt: responseType } : {}),
    });
  }

  sortSuffixParams(root);
  return root;
}

/**
 * Sort every node's suffix-param map (`node.xp`) by descending suffix length so
 * the matcher tries the most specific suffix first. Overlapping suffixes like
 * `.min.js` and `.js` must resolve by specificity, not route declaration order:
 * a request for `/app.min.js` should match `:file.min.js`, not `:file.js`.
 *
 * This started as a bug — `walkTrie` iterates `node.xp` in object order and
 * returns the first suffix the segment ends with, so the winner depended on
 * which route was declared first. Sorting at build time fixes it allocation-free
 * on the match hot path: the serialized production trie preserves this key order
 * through JSON.parse, so dev (per-request rebuild) and production match
 * identically. Array.prototype.sort is stable (ES2019+), so equal-length
 * suffixes keep their declaration order — the router's existing tiebreak.
 */
function sortSuffixParams(node: TrieNode): void {
  if (node.xp) {
    const sorted: Record<string, { n: string; c: TrieNode }> = {};
    for (const suffix of Object.keys(node.xp).sort(
      (a, b) => b.length - a.length,
    )) {
      sorted[suffix] = node.xp[suffix];
    }
    node.xp = sorted;
    for (const child of Object.values(node.xp)) {
      sortSuffixParams(child.c);
    }
  }
  if (node.s) {
    for (const child of Object.values(node.s)) {
      sortSuffixParams(child);
    }
  }
  if (node.p) {
    sortSuffixParams(node.p.c);
  }
}

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
    manifest.onDemandRoutes ? new Set(manifest.onDemandRoutes) : undefined,
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
  leaf: Omit<TrieLeaf, "cv" | "pa">,
): void {
  // cv (full constraint map) is route-level and identical on every terminal,
  // so compute it once on the shared base.
  const constraints: Record<string, string[]> = {};

  for (const seg of segments) {
    if (seg.type === "param") {
      if (seg.constraint) {
        constraints[seg.value] = seg.constraint;
      }
    }
  }

  const leafBase: Omit<TrieLeaf, "pa"> = {
    ...leaf,
    ...(Object.keys(constraints).length > 0 ? { cv: constraints } : {}),
  };

  insertSegments(node, segments, index, leafBase, []);
}

/**
 * Merge a new leaf with an existing leaf, handling content negotiation.
 * When an RSC route and response-type routes share the same URL pattern,
 * the RSC route becomes the primary leaf and response-type routes are
 * appended to the nv (negotiate variants) array.
 * Multiple response types on the same path are supported (json + text + xml).
 */
/**
 * Build a negotiate-variant entry from a leaf being folded into another leaf's
 * nv list. Carries the variant's positional param names (`pa`) so the runtime
 * can re-key matched params under the variant's names; omitted when the variant
 * has none (the common case where primary and variant share the same names is a
 * no-op re-key regardless).
 */
function toVariant(leaf: TrieLeaf, responseType: string): NegotiateVariant {
  return leaf.pa
    ? { routeKey: leaf.n, responseType, pa: leaf.pa }
    : { routeKey: leaf.n, responseType };
}

function mergeLeaves(existing: TrieLeaf | undefined, leaf: TrieLeaf): TrieLeaf {
  if (!existing) return leaf;

  if (existing.rt && leaf.rt) {
    // Both are response-type: preserve old as variant
    const merged = leaf;
    merged.nv = existing.nv || [];
    merged.nv.push(toVariant(existing, existing.rt));
    return merged;
  }
  if (leaf.rt && !existing.rt) {
    // RSC primary exists, new leaf is response-type: append variant
    // RSC was defined first (it was already the existing leaf)
    if (!existing.nv) {
      existing.nv = [];
      existing.rf = true;
    }
    existing.nv.push(toVariant(leaf, leaf.rt));
    return existing;
  }
  if (!leaf.rt && existing.rt) {
    // Response-type was primary, new leaf is RSC: swap and move old to variants
    // RSC was defined second (response-type was already the existing leaf)
    if (!leaf.nv) leaf.nv = [];
    if (existing.nv) leaf.nv.push(...existing.nv);
    leaf.nv.push(toVariant(existing, existing.rt));
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
    // `pn` is "*" for the bare `/*` and the param name for a named catch-all;
    // `w1` marks the one-or-more variant (`:name+`) so the walker rejects the
    // empty-remainder case.
    const wildLeaf: TrieLeaf & { pn: string; w1?: true } = {
      ...buildLeaf(leafBase, paramNames),
      pn: segment.value,
      ...(segment.oneOrMore ? { w1: true as const } : {}),
    };
    const existing = node.w;
    // Merge when there's no existing wildcard, when this is a response-type
    // content-negotiation variant of the same catch-all (one side carries `rt`),
    // or when it's the SAME catch-all identity (same param name + arity).
    // Otherwise two DISTINCT catch-all forms (`/x/*` vs `/x/:p+`) would collide on
    // the single wildcard slot with no non-lossy merge — so keep the first-declared
    // (matching the regex matcher's declaration-order tiebreak) rather than let
    // mergeLeaves' last-wins overwrite silently drop its `pn`/`w1` identity (which
    // stranded the first route and fell through to a corrupt regex-fallback redirect).
    const canMerge =
      existing === undefined ||
      Boolean(existing.rt) ||
      Boolean(wildLeaf.rt) ||
      (existing.pn === wildLeaf.pn &&
        Boolean(existing.w1) === Boolean(wildLeaf.w1));
    if (canMerge) {
      const merged = mergeLeaves(
        existing ? ({ ...existing } as TrieLeaf) : undefined,
        wildLeaf,
      );
      node.w = merged as TrieLeaf & { pn: string; w1?: true };
    }
  }
}
