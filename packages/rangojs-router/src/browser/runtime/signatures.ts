/**
 * Client Segment Runtime - Structural Signatures
 *
 * Pure functions to compute and compare StructuralSignature from ResolvedSegment.
 * Signatures determine React tree depth: changing any signature field for a
 * retained segment causes a remount.
 *
 * Depends only on types.ts.
 */

import type { ResolvedSegment } from "../../types.js";
import type { StructuralSignature } from "./types.js";

// ---------------------------------------------------------------------------
// Compute signature
// ---------------------------------------------------------------------------

/**
 * Derive loadingCategory from segment's loading property.
 * Mirrors the branching in renderSegments() (segment-system.tsx):
 *   undefined/null -> "none"    (OutletProvider only)
 *   false          -> "suppressed" (LoaderBoundary + Suspense, no RouteContentWrapper)
 *   truthy         -> "active"  (full nesting: LoaderBoundary + Suspense + RouteContentWrapper)
 */
function getLoadingCategory(
  loading: ResolvedSegment["loading"]
): StructuralSignature["loadingCategory"] {
  if (loading === undefined || loading === null) return "none";
  if (loading === false) return "suppressed";
  return "active";
}

/**
 * Compute the structural signature for a segment.
 * Two segments with the same signature produce the same React tree depth,
 * so React can reconcile without remounting.
 */
export function computeSignature(segment: ResolvedSegment): StructuralSignature {
  const sig: StructuralSignature = {
    kind: segment.type,
    loadingCategory: getLoadingCategory(segment.loading),
    hasMountPath: !!segment.mountPath,
    hasComponent: segment.component != null,
  };
  if (segment.slot !== undefined) {
    sig.slot = segment.slot;
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Compare signatures
// ---------------------------------------------------------------------------

/**
 * Check if two signatures are structurally equivalent.
 * If they differ, React will remount the subtree at this segment position.
 */
export function signaturesMatch(
  a: StructuralSignature,
  b: StructuralSignature
): boolean {
  return (
    a.kind === b.kind &&
    a.loadingCategory === b.loadingCategory &&
    a.hasMountPath === b.hasMountPath &&
    a.hasComponent === b.hasComponent &&
    a.slot === b.slot
  );
}

// ---------------------------------------------------------------------------
// Build signature map
// ---------------------------------------------------------------------------

/**
 * Build a Map<segmentId, StructuralSignature> for an array of segments.
 * Used when constructing a RouteSnapshot.
 */
export function buildSignatureMap(
  segments: ResolvedSegment[]
): Map<string, StructuralSignature> {
  const map = new Map<string, StructuralSignature>();
  for (const seg of segments) {
    map.set(seg.id, computeSignature(seg));
  }
  return map;
}

/**
 * Detect structural violations between old and new segment signatures.
 * Returns an array of segment IDs whose structure changed (would cause remount).
 * Empty array means safe to reconcile.
 */
export function detectStructuralViolations(
  oldSigs: Map<string, StructuralSignature>,
  newSigs: Map<string, StructuralSignature>,
  retainedIds: string[]
): string[] {
  const violations: string[] = [];
  for (const id of retainedIds) {
    const oldSig = oldSigs.get(id);
    const newSig = newSigs.get(id);
    if (oldSig && newSig && !signaturesMatch(oldSig, newSig)) {
      violations.push(id);
    }
  }
  return violations;
}
