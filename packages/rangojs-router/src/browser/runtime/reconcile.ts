/**
 * Client Segment Runtime - Reconcile
 *
 * Single reconcileSnapshot() implementation for all modes (navigate, action, revalidate).
 * Merges a ServerPatch onto a base RouteSnapshot, enforcing structural preservation rules.
 *
 * Depends on types.ts and signatures.ts.
 */

import type { ResolvedSegment } from "../../types.js";
import type {
  RouteSnapshot,
  ServerPatch,
  ReconcileResult,
  ReconcileMode,
  StructuralSignature,
} from "./types.js";
import {
  computeSignature,
  buildSignatureMap,
  signaturesMatch,
} from "./signatures.js";

export type { ReconcileResult, ReconcileMode };

// ---------------------------------------------------------------------------
// Loader merge helpers (adapted from merge-segment-loaders.ts)
// ---------------------------------------------------------------------------

/**
 * Check if a server segment needs loader data merged with cached segment.
 * True when server returned fewer loaders than base (partial revalidation).
 */
function needsLoaderMerge(
  fromServer: ResolvedSegment,
  fromBase: ResolvedSegment | undefined
): fromBase is ResolvedSegment {
  return !!(
    fromBase &&
    fromServer.loaderIds &&
    fromBase.loaderIds &&
    fromServer.loaderIds.length < fromBase.loaderIds.length &&
    fromServer.loaderDataPromise &&
    fromBase.loaderDataPromise
  );
}

/**
 * Merge partial loader data from server with base loader data.
 * Server may return only revalidated loaders; component needs all of them.
 */
function mergeLoaderData(
  fromServer: ResolvedSegment,
  fromBase: ResolvedSegment
): ResolvedSegment {
  const serverLoaderIds = fromServer.loaderIds || [];
  const baseLoaderIds = fromBase.loaderIds || [];

  return {
    ...fromBase,
    component: fromBase.component,
    loaderDataPromise: Promise.all([
      fromServer.loaderDataPromise!,
      fromBase.loaderDataPromise!,
    ]).then(([newData, baseData]) => {
      return baseLoaderIds.map((id: string, i: number) => {
        const newIndex = serverLoaderIds.indexOf(id);
        if (newIndex !== -1) {
          return (newData as any[])[newIndex];
        }
        return (baseData as any[])[i];
      });
    }),
    loaderIds: fromBase.loaderIds,
  };
}

// ---------------------------------------------------------------------------
// Diff segment insertion (adapted from merge-segment-loaders.ts)
// ---------------------------------------------------------------------------

/**
 * Insert diff segments not in the matched array (e.g., loader segments from
 * consolidation fetch). Inserts after parent layout based on ID pattern.
 *
 * Loader ID pattern: {parentLayoutId}D{index}.{loaderId}
 */
function insertMissingDiffSegments(
  allSegments: ResolvedSegment[],
  diff: string[],
  matchedIdSet: Set<string>,
  serverSegmentMap: Map<string, ResolvedSegment>
): void {
  for (const diffId of diff) {
    if (matchedIdSet.has(diffId)) continue;
    const fromServer = serverSegmentMap.get(diffId);
    if (!fromServer) continue;

    const loaderMatch = diffId.match(/^(.+?)D\d+\./);
    if (loaderMatch) {
      const parentLayoutId = loaderMatch[1];
      const parentIndex = allSegments.findIndex((s) => s.id === parentLayoutId);
      if (parentIndex !== -1) {
        allSegments.splice(parentIndex + 1, 0, fromServer);
      } else {
        allSegments.push(fromServer);
      }
    } else {
      allSegments.push(fromServer);
    }
  }
}

// ---------------------------------------------------------------------------
// Structural preservation
// ---------------------------------------------------------------------------

/**
 * Apply structural preservation rules for a retained segment.
 * Ensures loading, mountPath, and component don't change in ways that
 * would cause React tree remounts.
 */
function preserveStructure(
  serverSeg: ResolvedSegment,
  baseSeg: ResolvedSegment,
  mode: ReconcileMode
): ResolvedSegment {
  let merged = serverSeg;

  // Preserve loading value if it differs (all modes)
  if (serverSeg.loading !== baseSeg.loading) {
    merged = { ...merged, loading: baseSeg.loading };
  }

  // Preserve mountPath if presence changed (all modes)
  if (!!serverSeg.mountPath !== !!baseSeg.mountPath) {
    merged = { ...merged, mountPath: baseSeg.mountPath };
  }

  // Preserve component if server returns null for layout (all modes)
  if (serverSeg.component == null && baseSeg.component != null) {
    merged = { ...merged, component: baseSeg.component };
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Main reconcile function
// ---------------------------------------------------------------------------

/**
 * Reconcile a ServerPatch onto a base RouteSnapshot, producing a new snapshot.
 *
 * The `mode` parameter controls preservation rules:
 *   "navigate"    - preserve loading/mountPath/component for retained segments
 *   "action"      - same as navigate + structural violation detection (dev warning)
 *   "revalidate"  - same as navigate (only updates cache)
 *
 * All modes:
 * 1. For each matchedId in patch.matched:
 *    - If in patch.diff: use server segment (with preservation)
 *    - Else: copy from base snapshot
 * 2. Merge partial loaders when needed
 * 3. Insert diff segments not in matched
 * 4. Validate all matched segments present
 * 5. Compute signatures, build indices
 * 6. Copy slots/handleData from patch or base
 */
export function reconcileSnapshot(
  base: RouteSnapshot,
  patch: ServerPatch,
  mode: ReconcileMode
): ReconcileResult {
  const diffSet = new Set(patch.diff);
  const matchedIdSet = new Set(patch.matched);

  // Build server segment map for O(1) lookup
  const serverSegmentMap = new Map<string, ResolvedSegment>();
  for (const seg of patch.segments) {
    serverSegmentMap.set(seg.id, seg);
  }

  const allSegments: ResolvedSegment[] = [];
  const missing: string[] = [];

  // Step 1: Walk matched IDs, merge from server or base
  for (const matchedId of patch.matched) {
    if (diffSet.has(matchedId)) {
      // Server updated this segment
      const serverSeg = serverSegmentMap.get(matchedId);
      if (!serverSeg) {
        missing.push(matchedId);
        continue;
      }

      const baseSeg = base.segmentIndex.has(matchedId)
        ? base.segments[base.segmentIndex.get(matchedId)!]
        : undefined;

      let segment = serverSeg;

      // Merge loaders if needed (partial revalidation)
      if (baseSeg && needsLoaderMerge(serverSeg, baseSeg)) {
        segment = mergeLoaderData(serverSeg, baseSeg);
      }

      // Apply structural preservation for retained base segments
      if (baseSeg) {
        segment = preserveStructure(segment, baseSeg, mode);
      }

      allSegments.push(segment);
    } else {
      // Not in diff: copy from base
      const baseIdx = base.segmentIndex.get(matchedId);
      if (baseIdx !== undefined) {
        const baseSeg = base.segments[baseIdx];

        // For retained segments not in diff: clear truthy loading
        // (prevents suspense on cached content) but keep loading=false
        // (maintains LoaderBoundary tree structure).
        // Cast needed because loading can be `false` at runtime (suppressed boundary)
        // even though ReactNode type doesn't include boolean in all React versions.
        if (baseSeg.loading !== undefined && (baseSeg.loading as unknown) !== false) {
          allSegments.push({ ...baseSeg, loading: undefined });
        } else {
          allSegments.push(baseSeg);
        }
      } else {
        // Segment not in diff AND not in base - check server segments
        const serverSeg = serverSegmentMap.get(matchedId);
        if (serverSeg) {
          allSegments.push(serverSeg);
        } else {
          missing.push(matchedId);
        }
      }
    }
  }

  // Step 2: Validate all matched segments are present
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "MISSING_MATCHED_SEGMENT",
      details: `Missing segment IDs: ${missing.join(", ")}`,
    };
  }

  // Step 3: Insert diff segments not in matched (loader segments from consolidation)
  insertMissingDiffSegments(allSegments, patch.diff, matchedIdSet, serverSegmentMap);

  // Step 4: Structural violation detection (action mode)
  if (mode === "action") {
    const newSigs = buildSignatureMap(allSegments);
    const violations: string[] = [];

    for (const [id, oldSig] of base.signatures) {
      const newSig = newSigs.get(id);
      if (newSig && !signaturesMatch(oldSig, newSig)) {
        violations.push(id);
      }
    }

    if (violations.length > 0) {
      return {
        ok: false,
        reason: "STRUCTURE_VIOLATION",
        details: `Structural signature changed for retained segments: ${violations.join(", ")}`,
      };
    }
  }

  // Step 5: Build segment index and signatures
  const segmentIndex = new Map<string, number>();
  for (let i = 0; i < allSegments.length; i++) {
    segmentIndex.set(allSegments[i].id, i);
  }

  const signatures = buildSignatureMap(allSegments);

  // Step 6: Separate intercept segments
  // Intercept segments from patch if provided, otherwise preserve base
  const interceptSegments = patch.isPartial
    ? base.interceptSegments
    : (patch.segments.filter((s) => s.id.includes("$intercept")) || base.interceptSegments);

  // Step 7: Compose snapshot
  const snapshot: RouteSnapshot = {
    key: base.key, // Preserve key (caller may update for nav)
    url: base.url, // Preserve url (caller may update for nav)
    matched: patch.matched,
    segments: allSegments,
    segmentIndex,
    signatures,
    interceptSegments,
    slots: patch.slots ?? base.slots,
    handleData: base.handleData,
    interceptSourceUrl: base.interceptSourceUrl,
    version: base.version,
    updatedAt: Date.now(),
  };

  return { ok: true, snapshot };
}
