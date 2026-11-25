import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type Context,
  type ReactNode,
} from "react";
import {
  auditCommit,
  auditFallback,
  auditHandover,
  auditMount,
  auditRead,
  auditReveal,
  auditUnmount,
  createBoundaryAudit,
  type BoundaryAudit,
} from "./suspense-audit.js";

// Hooks of the suspense audit (docs/internal/suspense-contract.md), called by
// dev-only components: React Compiler skips a component with a gated hook.

const AuditScopeContext: Context<string | undefined> =
  /* @__PURE__ */ createContext<string | undefined>(undefined);

/**
 * Names the copy of the tree a boundary sits in, after the scopes around it.
 * One segment can be on the page twice under one React key (an
 * `<Outlet keep />` entry hidden beside the one shown), and each copy's
 * boundary is its own I4 slot. Rendered in an audited dev build only.
 */
export function AuditScope({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}): ReactNode {
  const outer = useContext(AuditScopeContext);
  // createElement, not JSX: a jsx-runtime import keeps this dev-only module
  // in production client bundles (tools/check-bundle-guards.mjs).
  return createElement(AuditScopeContext.Provider, {
    value: outer === undefined ? scope : `${outer} > ${scope}`,
    children,
  });
}

function useRecord(base: string, segmentId: string): BoundaryAudit {
  const scope = useContext(AuditScopeContext);
  const boundary = scope === undefined ? base : `${base} [${scope}]`;
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
  }, [rec, value, streams, nodes]);
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
    auditRead(rec, stream);
  }, [rec, stream]);
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
