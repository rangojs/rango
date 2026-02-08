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
      return validateAndBuild(trie.r, {}, pathname, pathnameHasTrailingSlash);
    }
    return null;
  }

  // Remove leading slash and split
  const segments = normalizedPath.slice(1).split("/");

  // Try exact match with normalized path (no trailing slash)
  const result = walkTrie(trie, segments, 0, {});
  if (result) {
    return validateAndBuild(result.leaf, result.params, pathname, pathnameHasTrailingSlash);
  }

  return null;
}

interface WalkResult {
  leaf: TrieLeaf;
  params: Record<string, string>;
}

/**
 * Walk the trie by segments with priority: static > param > wildcard.
 * Uses backtracking to try all possible matches.
 */
function walkTrie(
  node: TrieNode,
  segments: string[],
  index: number,
  params: Record<string, string>,
): WalkResult | null {
  // All segments consumed: check for terminal
  if (index === segments.length) {
    if (node.r) {
      return { leaf: node.r, params };
    }
    return null;
  }

  const segment = segments[index];

  // Priority 1: Static match
  if (node.s?.[segment]) {
    const result = walkTrie(node.s[segment], segments, index + 1, params);
    if (result) return result;
  }

  // Priority 2: Param match
  if (node.p) {
    const result = walkTrie(node.p.c, segments, index + 1, {
      ...params,
      [node.p.n]: segment,
    });
    if (result) return result;
  }

  // Priority 3: Wildcard match (consumes rest)
  if (node.w) {
    const rest = segments.slice(index).join("/");
    return {
      leaf: node.w,
      params: { ...params, [node.w.pn]: rest },
    };
  }

  return null;
}

/**
 * Post-match: validate constraints and handle trailing slash logic.
 */
function validateAndBuild(
  leaf: TrieLeaf,
  params: Record<string, string>,
  originalPathname: string,
  pathnameHasTrailingSlash: boolean,
): TrieMatchResult | null {
  // Validate constraints
  if (leaf.cv) {
    for (const [paramName, allowed] of Object.entries(leaf.cv)) {
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

  return {
    routeKey: leaf.n,
    sp: leaf.sp,
    params,
    optionalParams: leaf.op,
    ancestry: leaf.a,
    ...(redirectTo ? { redirectTo } : {}),
    ...(leaf.pr ? { pr: true } : {}),
  };
}
