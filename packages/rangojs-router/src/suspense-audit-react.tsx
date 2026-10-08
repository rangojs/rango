import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  auditCommit,
  auditFallback,
  auditHandover,
  auditMount,
  auditReveal,
  auditUnmount,
  createBoundaryAudit,
  type BoundaryAudit,
} from "./suspense-audit.js";

/**
 * The hooks of the dev-only suspense audit (suspense-audit.ts). The boundary
 * hooks are called by dev-only components: a hook behind a NODE_ENV test
 * inside a product component makes React Compiler skip that component in
 * every mode.
 */

function useRecord(boundary: string, segmentId: string): BoundaryAudit {
  const ref = useRef<BoundaryAudit | null>(null);
  // One position can hold another segment's boundary: its Suspense is keyed.
  if (ref.current === null || ref.current.boundary !== boundary) {
    ref.current = createBoundaryAudit(boundary, segmentId);
  }
  return ref.current;
}

// Passive, not layout: React disconnects the layout effects of content a
// Suspense boundary hides, and that is not an unmount.
function useMount(rec: BoundaryAudit): void {
  useEffect(() => {
    auditMount(rec);
    return () => auditUnmount(rec);
  }, [rec]);
}

/**
 * One boundary: what each render hands it, what each commit carries, and its
 * mount. Called above the Suspense, which commits while the content waits.
 * `streams` and `nodes` are what else its content waits for (I3 only).
 */
export function useBoundaryAudit(
  boundary: string,
  segmentId: string,
  value: unknown,
  streams?: Record<string, unknown>,
  nodes?: unknown,
): BoundaryAudit {
  const rec = useRecord(boundary, segmentId);
  auditHandover(rec, value);
  useLayoutEffect(() => {
    auditCommit(rec, value, streams, nodes);
  });
  useMount(rec);
  return rec;
}

/** The boundary's content is on screen. */
export function useRevealAudit(rec: BoundaryAudit): void {
  useLayoutEffect(() => {
    auditReveal(rec);
  }, [rec]);
}

/**
 * One `useLoader` read of a per-loader stream (I1, I2 at the read site). A
 * read that suspends while mounting keeps no record: only a reader on screen
 * is audited.
 */
export function useReadAudit(loaderId: string, stream: unknown): void {
  const rec = useRecord(`read:${loaderId}`, loaderId);
  auditHandover(rec, stream);
  useLayoutEffect(() => {
    rec.mountId = 1;
    auditCommit(rec, stream);
    auditReveal(rec);
  });
}

/** Wraps a boundary's fallback: mounted means the fallback is on screen. */
export function AuditedFallback({
  audit,
  children,
}: {
  audit: BoundaryAudit;
  children: ReactNode;
}): ReactNode {
  useLayoutEffect(() => auditFallback(audit), [audit]);
  return children;
}

/** Wraps a segment's outlet children: the segment's mount (I4). */
export function AuditedOutlet({
  segmentId,
  children,
}: {
  segmentId: string;
  children: ReactNode;
}): ReactNode {
  useMount(useRecord(`outlet:${segmentId}`, segmentId));
  return children;
}
