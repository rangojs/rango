/**
 * Runtime Trie Matching
 *
 * Walks the pre-built trie by path segments in O(path_length) time.
 * Falls back to null when no match is found (caller uses regex fallback).
 */

import type { TrieNode, TrieLeaf } from "../build/route-trie.js";

export interface TrieMatchResult {
  /** Route name */
  routeKey: string;
  /** Static prefix of the matched entry */
  sp: string;
  /** Matched route params */
  params: Record<string, string>;
  /** Optional param names (absent params have empty string value) */
  optionalParams?: string[];
  /** Ancestry shortCodes for layout pruning */
  ancestry: string[];
  /** Redirect target if trailing slash requires it */
  redirectTo?: string;
  /** Route has pre-rendered data available */
  pr?: true;
  /** Passthrough: handler kept for live fallback on unknown params */
  pt?: true;
  /** Response type for non-RSC routes (json, text, image, any) */
  responseType?: string;
  /** Negotiate variants: response-type routes sharing this path */
  negotiateVariants?: Array<{ routeKey: string; responseType: string }>;
  /** RSC-first: RSC route was defined before response-type variants */
  rscFirst?: true;
}

/**
 * Try to match a pathname against the trie.
 * Returns null if no match found (caller should fall back to regex).
 */
export function tryTrieMatch(
  trie: TrieNode | null,
  pathname: string,
): TrieMatchResult | null {
  if (!trie) return null;

  // Split pathname into segments, filtering empty strings from leading/trailing slashes
  const pathnameHasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
  const normalizedPath = pathnameHasTrailingSlash ? pathname.slice(0, -1) : pathname;

  // Handle root path
  if (normalizedPath === "" || normalizedPath === "/") {
    if (trie.r) {
      return validateAndBuild(trie.r, [], undefined, pathname, pathnameHasTrailingSlash);
    }
    return null;
  }

  // Remove leading slash and split
  const segments = normalizedPath.slice(1).split("/");

  // Try exact match with normalized path (no trailing slash)
  const result = walkTrie(trie, segments, 0, []);
  if (result) {
    return validateAndBuild(result.leaf, result.paramValues, result.wildcardValue, pathname, pathnameHasTrailingSlash);
  }

  return null;
}

interface WalkResult {
  leaf: TrieLeaf;
  paramValues: string[];
  wildcardValue?: string;
}

/**
 * Walk the trie by segments with priority: static > param > wildcard.
 * Uses backtracking to try all possible matches.
 */
function walkTrie(
  node: TrieNode,
  segments: string[],
  index: number,
  paramValues: string[],
): WalkResult | null {
  // All segments consumed: check for terminal
  if (index === segments.length) {
    if (node.r) {
      return { leaf: node.r, paramValues: [...paramValues] };
    }
    return null;
  }

  const segment = segments[index];
  const staticChild = node.s?.[segment];

  // Priority 1: Static match
  if (staticChild) {
    const result = walkTrie(staticChild, segments, index + 1, paramValues);
    if (result) return result;
  }

  // Priority 2: Param match
  if (node.p) {
    paramValues.push(segment);
    const result = walkTrie(node.p.c, segments, index + 1, paramValues);
    paramValues.pop();
    if (result) return result;
  }

  // Priority 3: Wildcard match (consumes rest)
  if (node.w) {
    const rest = joinRemainingSegments(segments, index);
    return {
      leaf: node.w,
      paramValues: [...paramValues],
      wildcardValue: rest,
    };
  }

  return null;
}

function joinRemainingSegments(segments: string[], start: number): string {
  if (start >= segments.length) return "";

  let rest = segments[start]!;
  for (let i = start + 1; i < segments.length; i++) {
    rest += "/" + segments[i]!;
  }
  return rest;
}

/**
 * Post-match: validate constraints and handle trailing slash logic.
 */
function validateAndBuild(
  leaf: TrieLeaf,
  paramValues: string[],
  wildcardValue: string | undefined,
  originalPathname: string,
  pathnameHasTrailingSlash: boolean,
): TrieMatchResult | null {
  // Build named params by zipping leaf.pa with positional paramValues
  const params: Record<string, string> = {};
  if (leaf.pa) {
    for (let i = 0; i < leaf.pa.length && i < paramValues.length; i++) {
      params[leaf.pa[i]] = paramValues[i];
    }
  }

  // Add wildcard param (wildcard leaves have pn from TrieNode.w type)
  if (wildcardValue !== undefined && "pn" in leaf) {
    params[(leaf as TrieLeaf & { pn: string }).pn] = wildcardValue;
  }

  // Validate constraints
  if (leaf.cv) {
    for (const paramName in leaf.cv) {
      const allowed = leaf.cv[paramName]!;
      const value = params[paramName];
      if (value !== undefined && value !== "" && !allowed.includes(value)) {
        return null;
      }
    }
  }

  // Fill in empty strings for optional params that weren't matched
  if (leaf.op) {
    for (const name of leaf.op) {
      if (!(name in params)) {
        params[name] = "";
      }
    }
  }

  // Trailing slash handling
  const tsMode = leaf.ts as "never" | "always" | "ignore" | undefined;
  let redirectTo: string | undefined;

  if (tsMode === "always" && !pathnameHasTrailingSlash && originalPathname !== "/") {
    redirectTo = originalPathname + "/";
  } else if (tsMode === "never" && pathnameHasTrailingSlash) {
    redirectTo = originalPathname.slice(0, -1);
  }

  const result: TrieMatchResult = {
    routeKey: leaf.n,
    sp: leaf.sp,
    params,
    ancestry: leaf.a,
  };

  if (leaf.op) result.optionalParams = leaf.op;
  if (redirectTo) result.redirectTo = redirectTo;
  if (leaf.pr) result.pr = true;
  if (leaf.pt) result.pt = true;
  if (leaf.rt) result.responseType = leaf.rt;
  if (leaf.nv) result.negotiateVariants = leaf.nv;
  if (leaf.rf) result.rscFirst = true;

  return result;
}
