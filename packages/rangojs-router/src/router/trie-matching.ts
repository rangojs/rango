/**
 * Runtime Trie Matching
 *
 * Walks the pre-built trie by path segments in O(path_length) time.
 * Falls back to null when no match is found (caller uses regex fallback).
 */

import type {
  TrieNode,
  TrieLeaf,
  NegotiateVariant,
} from "./route-trie-builder.js";
import { safeDecodeURIComponent } from "./url-params.js";

export interface TrieMatchResult {
  /** Route name */
  routeKey: string;
  /** Static prefix of the matched entry */
  sp: string;
  /** Matched route params */
  params: Record<string, string>;
  /** Redirect target if trailing slash requires it */
  redirectTo?: string;
  /** Route has pre-rendered data available */
  pr?: true;
  /** Passthrough: handler kept for live fallback on unknown params */
  pt?: true;
  /** Response type for non-RSC routes (json, text, image, any) */
  responseType?: string;
  /** Negotiate variants: response-type routes sharing this path */
  negotiateVariants?: NegotiateVariant[];
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

  const pathnameHasTrailingSlash =
    pathname.length > 1 && pathname.endsWith("/");
  const normalizedPath = pathnameHasTrailingSlash
    ? pathname.slice(0, -1)
    : pathname;

  if (normalizedPath === "" || normalizedPath === "/") {
    if (trie.r) {
      return validateAndBuild(
        trie.r,
        [],
        undefined,
        pathname,
        pathnameHasTrailingSlash,
      );
    }
    // A root-level wildcard ("/*") matches "/" with an empty remainder, the
    // same value the regex matcher produces for the bare prefix. Without this
    // the trie misses, the regex fallback runs, and its no-config branch emits
    // a corrupt slice-off redirect. The static terminal still wins above.
    // A one-or-more catch-all (`w1`, from `:name+`) rejects this empty case.
    if (trie.w && !trie.w.w1) {
      return validateAndBuild(
        trie.w,
        [],
        "",
        pathname,
        pathnameHasTrailingSlash,
      );
    }
    return null;
  }

  const segments = normalizedPath.slice(1).split("/");

  const result = walkTrie(trie, segments, 0, []);
  if (result) {
    return validateAndBuild(
      result.leaf,
      result.paramValues,
      result.wildcardValue,
      pathname,
      pathnameHasTrailingSlash,
      result.validatedParams,
    );
  }

  return null;
}

interface WalkResult {
  leaf: TrieLeaf;
  paramValues: string[];
  wildcardValue?: string;
  /**
   * For a constraint-bearing leaf (leaf.cv set), the params map that
   * leafConstraintsPass already decoded AND validated during the walk. Carried
   * forward so validateAndBuild reuses it instead of re-decoding paramValues and
   * re-running constraintsSatisfied a second time on the winning leaf. Undefined
   * for unconstrained leaves (no decode/validate happened in the walk).
   */
  validatedParams?: Record<string, string>;
}

/**
 * Check a leaf's constraints (leaf.cv) against already-resolved named params.
 * Empty/undefined values are exempt (optional params that were not bound).
 */
function constraintsSatisfied(
  leaf: TrieLeaf,
  params: Record<string, string>,
): boolean {
  if (!leaf.cv) return true;
  for (const paramName in leaf.cv) {
    const allowed = leaf.cv[paramName]!;
    const value = params[paramName];
    if (value !== undefined && value !== "" && !allowed.includes(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Constraint check for a candidate terminal DURING the walk. Builds the named
 * params from positional walk values (decoded the same way validateAndBuild
 * does) and validates leaf.cv. Returning null lets walkTrie unwind to a
 * lower-priority sibling instead of committing to a leaf that would only be
 * rejected post-walk — that post-walk rejection is what forced the regex
 * fallback (and its false "trie gap" R3 warning) for perfectly valid configs.
 *
 * On success returns the built+validated params for a constraint-bearing leaf so
 * walkTrie can carry them to validateAndBuild (avoiding a second decode + a
 * second constraintsSatisfied pass on the winner); returns the shared EMPTY_PASS
 * sentinel for an unconstrained leaf (no work was done, nothing to carry).
 */
const EMPTY_PASS: Record<string, string> = {};
function leafConstraintsPass(
  leaf: TrieLeaf,
  paramValues: string[],
  wildcardValue: string | undefined,
): Record<string, string> | null {
  if (!leaf.cv) return EMPTY_PASS;
  const params: Record<string, string> = {};
  if (leaf.pa) {
    for (let i = 0; i < leaf.pa.length && i < paramValues.length; i++) {
      params[leaf.pa[i]] = safeDecodeURIComponent(paramValues[i]);
    }
  }
  if (wildcardValue !== undefined && "pn" in leaf) {
    params[(leaf as TrieLeaf & { pn: string }).pn] =
      safeDecodeURIComponent(wildcardValue);
  }
  return constraintsSatisfied(leaf, params) ? params : null;
}

/**
 * Walk the trie by segments with priority: static > suffix-param > param >
 * wildcard (Priority 1-4 below; matches the canonical M4 ordering in
 * docs/internal/matching-and-lazy-discovery.md).
 * Uses backtracking to try all possible matches. Per-leaf constraints are
 * enforced at each candidate terminal so a constraint miss backtracks to a
 * lower-priority sibling rather than aborting the whole match.
 */
function walkTrie(
  node: TrieNode,
  segments: string[],
  index: number,
  paramValues: string[],
): WalkResult | null {
  if (index === segments.length) {
    if (node.r) {
      const validatedParams = leafConstraintsPass(
        node.r,
        paramValues,
        undefined,
      );
      if (validatedParams) {
        return {
          leaf: node.r,
          paramValues: [...paramValues],
          validatedParams,
        };
      }
    }
    // A wildcard at this node matches the bare prefix with an empty remainder
    // (e.g. "/files" against "/files/*"), mirroring the regex matcher's `*=""`.
    // walkTrie otherwise only reaches node.w in the index<length branch below,
    // so without this a request to the wildcard's own prefix misses the trie
    // and the regex fallback emits a corrupt redirect. A static terminal
    // (node.r) still wins. A one-or-more catch-all (`w1`, from `:name+`) rejects
    // this empty case — it requires at least one trailing segment.
    if (node.w && !node.w.w1) {
      const validatedParams = leafConstraintsPass(node.w, paramValues, "");
      if (validatedParams) {
        return {
          leaf: node.w,
          paramValues: [...paramValues],
          wildcardValue: "",
          validatedParams,
        };
      }
    }
    return null;
  }

  const segment = segments[index];
  const staticChild = node.s?.[segment];

  if (staticChild) {
    const result = walkTrie(staticChild, segments, index + 1, paramValues);
    if (result) return result;
  }

  if (node.xp) {
    // node.xp keys are pre-sorted longest-suffix-first at build time
    // (route-trie-builder.ts sortSuffixParams), so the first match is the most
    // specific suffix: `/app.min.js` matches `:file.min.js` before `:file.js`.
    for (const suffix in node.xp) {
      if (segment.endsWith(suffix) && segment.length > suffix.length) {
        const paramValue = segment.slice(0, -suffix.length);
        paramValues.push(paramValue);
        const result = walkTrie(
          node.xp[suffix].c,
          segments,
          index + 1,
          paramValues,
        );
        paramValues.pop();
        if (result) return result;
      }
    }
  }

  // A required single-segment param captures 1+ chars (the regex matcher emits
  // `([^/]+)`), so an empty path segment from a double slash (`/a//b`) must NOT
  // bind `:s` to "". Reject it here so the trie matches the regex contract and
  // a malformed URL 404s instead of running the handler with an empty param.
  // The suffix-param branch above already requires `segment.length > suffix`,
  // and node.w may legitimately be empty, so only this branch needs the guard.
  if (node.p && segment !== "") {
    paramValues.push(segment);
    const result = walkTrie(node.p.c, segments, index + 1, paramValues);
    paramValues.pop();
    if (result) return result;
  }

  if (node.w) {
    const rest = joinRemainingSegments(segments, index);
    // A one-or-more catch-all (`w1`, from `:name+`) requires at least one
    // non-empty trailing segment. `rest` can still be "" here on a malformed
    // double-slash URL (e.g. `/docs//` splits to a trailing "" segment), so
    // guard this in-path site the same way the root and base-case sites are.
    if (!(node.w.w1 && rest === "")) {
      const validatedParams = leafConstraintsPass(node.w, paramValues, rest);
      if (validatedParams) {
        return {
          leaf: node.w,
          paramValues: [...paramValues],
          wildcardValue: rest,
          validatedParams,
        };
      }
    }
  }

  return null;
}

function joinRemainingSegments(segments: string[], start: number): string {
  if (start >= segments.length) return "";
  return segments.slice(start).join("/");
}

/**
 * Post-match: validate constraints and handle trailing slash logic.
 *
 * `validatedParams` is the params map walkTrie already decoded AND validated via
 * leafConstraintsPass for a constraint-bearing winning leaf. When present (and
 * non-empty) we reuse it verbatim and SKIP the second decode + the second
 * constraintsSatisfied pass — both are byte-identical to the walk-time work.
 * When absent (unconstrained leaf, or the root-path call sites that never walk)
 * we still BUILD the params here (that is not redundant — they must be returned)
 * and run constraintsSatisfied for safety; an unconstrained leaf's check is a
 * cheap early `!leaf.cv` return.
 */
function validateAndBuild(
  leaf: TrieLeaf,
  paramValues: string[],
  wildcardValue: string | undefined,
  originalPathname: string,
  pathnameHasTrailingSlash: boolean,
  validatedParams?: Record<string, string>,
): TrieMatchResult | null {
  let params: Record<string, string>;
  // EMPTY_PASS (the unconstrained sentinel) and undefined both mean "nothing was
  // pre-validated"; only a populated map carried from a constraint-bearing leaf
  // lets us skip the rebuild + re-check.
  if (validatedParams && validatedParams !== EMPTY_PASS) {
    params = validatedParams;
  } else {
    params = {};
    if (leaf.pa) {
      for (let i = 0; i < leaf.pa.length && i < paramValues.length; i++) {
        params[leaf.pa[i]] = safeDecodeURIComponent(paramValues[i]);
      }
    }

    if (wildcardValue !== undefined && "pn" in leaf) {
      params[(leaf as TrieLeaf & { pn: string }).pn] =
        safeDecodeURIComponent(wildcardValue);
    }

    if (!constraintsSatisfied(leaf, params)) {
      return null;
    }
  }

  const tsMode = leaf.ts as "never" | "always" | "ignore" | undefined;
  let redirectTo: string | undefined;

  if (
    tsMode === "always" &&
    !pathnameHasTrailingSlash &&
    originalPathname !== "/"
  ) {
    redirectTo = originalPathname + "/";
  } else if (tsMode === "never" && pathnameHasTrailingSlash) {
    redirectTo = originalPathname.slice(0, -1);
  }

  const result: TrieMatchResult = {
    routeKey: leaf.n,
    sp: leaf.sp,
    params,
  };

  if (redirectTo) result.redirectTo = redirectTo;
  if (leaf.pr) result.pr = true;
  if (leaf.pt) result.pt = true;
  if (leaf.rt) result.responseType = leaf.rt;
  if (leaf.nv) result.negotiateVariants = leaf.nv;
  if (leaf.rf) result.rscFirst = true;

  return result;
}
