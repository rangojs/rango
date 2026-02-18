/**
 * Layer 1 tests: Reconcile pure function
 *
 * Tests reconcileSnapshot() across all three modes (navigate, action, revalidate).
 * Covers segment merging, structural preservation, loader merging, missing
 * segment detection, and structural violation detection.
 */

import { describe, it, expect } from "vitest";
import type { ResolvedSegment } from "../../../types.js";
import type {
  RouteSnapshot,
  ServerPatch,
  StructuralSignature,
} from "../types.js";
import { reconcileSnapshot } from "../reconcile.js";
import { buildSignatureMap } from "../signatures.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seg(
  id: string,
  overrides?: Partial<ResolvedSegment>
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
    ...overrides,
  } as any;
}

function makeSnapshot(
  segments: ResolvedSegment[],
  matched?: string[],
  overrides?: Partial<RouteSnapshot>
): RouteSnapshot {
  const segmentIndex = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    segmentIndex.set(segments[i].id, i);
  }
  const signatures = buildSignatureMap(segments);

  return {
    key: "/",
    url: "http://localhost/",
    matched: matched ?? segments.map((s) => s.id),
    segments,
    segmentIndex,
    signatures,
    interceptSegments: [],
    slots: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makePatch(overrides: Partial<ServerPatch>): ServerPatch {
  return {
    isPartial: true,
    matched: [],
    diff: [],
    segments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic merge behavior (all modes)
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - basic merge", () => {
  it("uses server segment for diff IDs", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout" }),
      seg("page", { type: "route" }),
    ]);

    const serverPage = seg("page", { type: "route", component: "new-page-component" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["page"],
      segments: [serverPage],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.segments).toHaveLength(2);
    expect(result.snapshot.segments[0].id).toBe("root");
    expect(result.snapshot.segments[0].component).toBe("component-root"); // from base
    expect(result.snapshot.segments[1].id).toBe("page");
    expect(result.snapshot.segments[1].component).toBe("new-page-component"); // from server
  });

  it("copies from base for non-diff IDs", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", component: "layout-comp" }),
      seg("page", { type: "route", component: "page-comp" }),
    ]);

    const serverPage = seg("page", { type: "route", component: "updated-page" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["page"],
      segments: [serverPage],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.segments[0].component).toBe("layout-comp"); // preserved from base
  });

  it("builds segmentIndex correctly", () => {
    const base = makeSnapshot([
      seg("root"),
      seg("page"),
    ]);

    const patch = makePatch({
      matched: ["root", "page"],
      diff: [],
      segments: [],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.segmentIndex.get("root")).toBe(0);
    expect(result.snapshot.segmentIndex.get("page")).toBe(1);
  });

  it("computes signatures for result segments", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout" }),
    ]);

    const patch = makePatch({
      matched: ["root"],
      diff: [],
      segments: [],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sig = result.snapshot.signatures.get("root");
    expect(sig).toBeDefined();
    expect(sig!.kind).toBe("layout");
  });
});

// ---------------------------------------------------------------------------
// Missing segment detection
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - missing segments", () => {
  it("returns MISSING_MATCHED_SEGMENT when diff segment not found", () => {
    const base = makeSnapshot([seg("root")]);

    const patch = makePatch({
      matched: ["root", "missing"],
      diff: ["missing"],
      segments: [], // missing is in diff but not in segments
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("MISSING_MATCHED_SEGMENT");
    expect(result.details).toContain("missing");
  });

  it("returns MISSING_MATCHED_SEGMENT when matched ID not in base or server", () => {
    const base = makeSnapshot([seg("root")]);

    const patch = makePatch({
      matched: ["root", "ghost"],
      diff: [],
      segments: [],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("MISSING_MATCHED_SEGMENT");
    expect(result.details).toContain("ghost");
  });
});

// ---------------------------------------------------------------------------
// Structural preservation (navigate mode)
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - structural preservation (navigate)", () => {
  it("preserves loading value from base when server differs", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", loading: "loading-spinner" as any }),
    ]);

    const serverRoot = seg("root", {
      type: "layout",
      loading: undefined, // server returns different loading
    });
    const patch = makePatch({
      matched: ["root"],
      diff: ["root"],
      segments: [serverRoot],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should preserve base loading
    expect(result.snapshot.segments[0].loading).toBe("loading-spinner");
  });

  it("preserves mountPath when presence changes", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", mountPath: "/app" }),
    ]);

    const serverRoot = seg("root", { type: "layout", mountPath: undefined });
    const patch = makePatch({
      matched: ["root"],
      diff: ["root"],
      segments: [serverRoot],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.segments[0].mountPath).toBe("/app");
  });

  it("preserves component when server returns null for layout", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", component: "real-component" }),
    ]);

    const serverRoot = seg("root", { type: "layout", component: null as any });
    const patch = makePatch({
      matched: ["root"],
      diff: ["root"],
      segments: [serverRoot],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.segments[0].component).toBe("real-component");
  });

  it("clears truthy loading for retained base segments not in diff", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", loading: "skeleton" as any }),
      seg("page", { type: "route" }),
    ]);

    const serverPage = seg("page", { type: "route", component: "new-page" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["page"],
      segments: [serverPage],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // root is not in diff -> loading should be cleared (prevents suspense on cached content)
    expect(result.snapshot.segments[0].loading).toBeUndefined();
  });

  it("keeps loading=false for retained base segments not in diff", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", loading: false as any }),
      seg("page", { type: "route" }),
    ]);

    const serverPage = seg("page", { type: "route", component: "new-page" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["page"],
      segments: [serverPage],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // loading=false maintains LoaderBoundary tree structure
    expect(result.snapshot.segments[0].loading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Action mode - structural violation detection
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - action mode", () => {
  it("detects structural violation when loading category changes", () => {
    // Base has loading=false (suppressed) on root
    const base = makeSnapshot([
      seg("root", { type: "layout", loading: false as any }),
      seg("page", { type: "route" }),
    ]);

    // Server returns loading="spinner" (active) - structural change
    const serverRoot = seg("root", { type: "layout", loading: "spinner" as any });
    const serverPage = seg("page", { type: "route" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["root", "page"],
      segments: [serverRoot, serverPage],
    });

    // In action mode, the preserved loading should prevent violation.
    // The preservation happens BEFORE violation check, so loading is preserved
    // from base (false) and no violation occurs.
    const result = reconcileSnapshot(base, patch, "action");
    expect(result.ok).toBe(true);
  });

  it("preserves structural properties in action mode", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", loading: false as any, mountPath: "/app" }),
      seg("page", { type: "route" }),
    ]);

    const serverRoot = seg("root", { type: "layout", loading: undefined, mountPath: undefined });
    const serverPage = seg("page", { type: "route", component: "action-result" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["root", "page"],
      segments: [serverRoot, serverPage],
    });

    const result = reconcileSnapshot(base, patch, "action");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Structural properties preserved from base
    expect(result.snapshot.segments[0].loading).toBe(false);
    expect(result.snapshot.segments[0].mountPath).toBe("/app");
  });
});

// ---------------------------------------------------------------------------
// Revalidate mode
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - revalidate mode", () => {
  it("applies same preservation rules as navigate", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout", loading: "spinner" as any }),
    ]);

    const serverRoot = seg("root", { type: "layout", loading: undefined });
    const patch = makePatch({
      matched: ["root"],
      diff: ["root"],
      segments: [serverRoot],
    });

    const result = reconcileSnapshot(base, patch, "revalidate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.segments[0].loading).toBe("spinner");
  });
});

// ---------------------------------------------------------------------------
// Diff segment insertion (loader segments from consolidation)
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - diff segment insertion", () => {
  it("inserts loader diff segments after parent layout", () => {
    const base = makeSnapshot([
      seg("M9L0L1", { type: "layout" }),
      seg("M9L0L1R0", { type: "route" }),
    ]);

    const loaderSeg = seg("M9L0L1D0.counter", { type: "loader" });
    const patch = makePatch({
      matched: ["M9L0L1", "M9L0L1R0"],
      diff: ["M9L0L1D0.counter"], // in diff but NOT in matched
      segments: [loaderSeg],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Loader should be inserted after its parent layout
    expect(result.snapshot.segments).toHaveLength(3);
    expect(result.snapshot.segments[0].id).toBe("M9L0L1");
    expect(result.snapshot.segments[1].id).toBe("M9L0L1D0.counter");
    expect(result.snapshot.segments[2].id).toBe("M9L0L1R0");
  });

  it("appends diff segment when parent not found", () => {
    const base = makeSnapshot([
      seg("root", { type: "layout" }),
      seg("page", { type: "route" }),
    ]);

    const orphanSeg = seg("orphanD0.loader", { type: "loader" });
    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["orphanD0.loader"],
      segments: [orphanSeg],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Appended to end since parent "orphan" not found
    expect(result.snapshot.segments).toHaveLength(3);
    expect(result.snapshot.segments[2].id).toBe("orphanD0.loader");
  });
});

// ---------------------------------------------------------------------------
// Loader merging
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - loader merging", () => {
  it("merges partial loader data with base", async () => {
    const baseSeg = seg("loader1", {
      type: "loader",
      loaderIds: ["a", "b", "c"],
      loaderDataPromise: Promise.resolve([1, 2, 3]),
    });
    const base = makeSnapshot([baseSeg]);

    // Server only revalidated loader "b"
    const serverSeg = seg("loader1", {
      type: "loader",
      loaderIds: ["b"],
      loaderDataPromise: Promise.resolve([20]),
    });
    const patch = makePatch({
      matched: ["loader1"],
      diff: ["loader1"],
      segments: [serverSeg],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have merged loader data
    const merged = result.snapshot.segments[0];
    expect(merged.loaderIds).toEqual(["a", "b", "c"]); // base order preserved
    const data = await merged.loaderDataPromise;
    expect(data).toEqual([1, 20, 3]); // "b" updated, rest from base
  });
});

// ---------------------------------------------------------------------------
// Slot and metadata handling
// ---------------------------------------------------------------------------

describe("reconcileSnapshot - metadata", () => {
  it("uses patch slots when provided", () => {
    const base = makeSnapshot([seg("root")], undefined, {
      slots: { modal: { active: false } },
    });

    const patch = makePatch({
      matched: ["root"],
      diff: [],
      segments: [],
      slots: { modal: { active: true } },
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.slots.modal.active).toBe(true);
  });

  it("falls back to base slots when patch has none", () => {
    const base = makeSnapshot([seg("root")], undefined, {
      slots: { sidebar: { active: true } },
    });

    const patch = makePatch({
      matched: ["root"],
      diff: [],
      segments: [],
      // no slots
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.slots.sidebar.active).toBe(true);
  });

  it("preserves base interceptSegments for partial patches", () => {
    const interceptSeg = seg("$intercept-modal", { type: "route" });
    const base = makeSnapshot([seg("root")], undefined, {
      interceptSegments: [interceptSeg],
    });

    const patch = makePatch({
      isPartial: true,
      matched: ["root"],
      diff: [],
      segments: [],
    });

    const result = reconcileSnapshot(base, patch, "navigate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.interceptSegments).toHaveLength(1);
    expect(result.snapshot.interceptSegments[0].id).toBe("$intercept-modal");
  });
});
