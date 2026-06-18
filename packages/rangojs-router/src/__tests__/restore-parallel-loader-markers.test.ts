import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreParallelLoaderMarkers } from "../segment-system.js";
import type { ResolvedSegment } from "../types";

// D6: restoreParallelLoaderMarkers ran on every render — allocating a Map and
// scanning all segments — even when no parallel slot existed (the common case).
// The fix adds a cheap `some(type === "parallel")` guard that returns the input
// array unchanged (SAME reference) when there is nothing to restore. The
// parallel case must keep its existing behavior (markers restored on the loader).

function seg(overrides: Partial<ResolvedSegment>): ResolvedSegment {
  return {
    id: "seg",
    type: "route",
    namespace: "",
    index: 0,
    component: null,
    ...overrides,
  } as ResolvedSegment;
}

// A segment whose `parallelLoading` access is counted. The main scan loop reads
// `.parallelLoading` for every loader/non-parallel segment; the fast-path guard
// returns BEFORE that loop, so a no-parallel list never reads it.
function countingSeg(
  overrides: Partial<ResolvedSegment>,
  onParallelLoadingRead: () => void,
): ResolvedSegment {
  const base = seg(overrides);
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "parallelLoading") onParallelLoadingRead();
      return Reflect.get(target, prop, receiver);
    },
  }) as ResolvedSegment;
}

describe("restoreParallelLoaderMarkers (D6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes the fast path (same array, no scan) when no parallel segment is present", () => {
    let parallelLoadingReads = 0;
    const onRead = () => {
      parallelLoadingReads++;
    };
    const segments = [
      countingSeg({ id: "L0", type: "layout" }, onRead),
      countingSeg({ id: "L0R0", type: "route" }, onRead),
      countingSeg({ id: "L0D0.x", type: "loader" }, onRead),
    ];

    const result = restoreParallelLoaderMarkers(segments);

    // Fast path: identical reference returned ...
    expect(result).toBe(segments);
    // ... and the scan loop (which reads `.parallelLoading`) never ran. Without
    // the guard the loop reads `.parallelLoading` on the loader segment.
    expect(parallelLoadingReads).toBe(0);
  });

  it("still restores parallelLoading markers when a parallel segment is present", () => {
    const segments = [
      seg({
        id: "L0.@side",
        type: "parallel",
        namespace: "ns1",
        loading: "PANEL_SKELETON" as unknown as ResolvedSegment["loading"],
      }),
      seg({
        id: "L0D0.x",
        type: "loader",
        namespace: "ns1",
        parallelLoading: undefined,
      }),
    ];

    const result = restoreParallelLoaderMarkers(segments);

    // Parallel case still does the work: a NEW array, with the loader's
    // parallelLoading restored from the parallel segment's loading.
    expect(result).not.toBe(segments);
    const loaderOut = result.find((s) => s.id === "L0D0.x")!;
    expect((loaderOut as { parallelLoading?: unknown }).parallelLoading).toBe(
      "PANEL_SKELETON",
    );
  });
});
