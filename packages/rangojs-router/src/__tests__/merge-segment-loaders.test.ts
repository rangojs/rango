import { describe, expect, it, vi } from "vitest";
import {
  insertMissingDiffSegments,
  mergeSegmentLoaders,
  needsLoaderMerge,
} from "../browser/merge-segment-loaders";

describe("merge-segment-loaders", () => {
  it("merges fresh loader data onto cached loader order", async () => {
    const fromCache = {
      id: "seg",
      component: "cached-component",
      layout: "cached-layout",
      loading: "cached-loading",
      loaderIds: ["a", "b", "c"],
      loaderDataPromise: Promise.resolve([1, 2, 3]),
    } as any;
    const fromServer = {
      id: "seg",
      component: "server-component",
      layout: "server-layout",
      loading: undefined,
      loaderIds: ["b"],
      loaderDataPromise: Promise.resolve([20]),
    } as any;

    const merged = mergeSegmentLoaders(fromServer, fromCache);

    // The server's re-render applies; the cached structure stays.
    expect(merged.component).toBe("server-component");
    expect(merged.layout).toBe("server-layout");
    expect(merged.loading).toBe("cached-loading");
    expect(merged.loaderIds).toEqual(["a", "b", "c"]);
    await expect(merged.loaderDataPromise).resolves.toEqual([1, 20, 3]);
  });

  it("drops cached loaderStreams so they cannot mask the merged aggregate", async () => {
    const fromCache = {
      id: "seg.@cart",
      component: "cached-component",
      loaderIds: ["cart", "other"],
      loaderDataPromise: Promise.resolve([{ count: 0 }, { other: true }]),
      loaderStreams: {
        cart: { ok: true, data: { count: 0 } },
        other: { ok: true, data: { other: true } },
      },
      awaitedLoaderIds: ["cart"],
    } as any;
    const fromServer = {
      id: "seg.@cart",
      component: "server-component",
      loaderIds: ["cart"],
      loaderDataPromise: Promise.resolve([{ count: 1 }]),
    } as any;

    const merged = mergeSegmentLoaders(fromServer, fromCache);

    expect(merged.loaderStreams).toBeUndefined();
    expect(merged.awaitedLoaderIds).toBeUndefined();
    await expect(merged.loaderDataPromise).resolves.toEqual([
      { count: 1 },
      { other: true },
    ]);
  });

  it("detects when loader merge is required", () => {
    const fromCache = {
      loaderIds: ["a", "b"],
      loaderDataPromise: Promise.resolve([1, 2]),
    } as any;
    const fromServer = {
      loaderIds: ["a"],
      loaderDataPromise: Promise.resolve([9]),
    } as any;

    expect(needsLoaderMerge(fromServer, fromCache)).toBe(true);
    expect(needsLoaderMerge(fromCache, fromServer)).toBe(false);
  });

  it("merges an empty aggregate: every loader held, all cached data kept", async () => {
    const fromCache = {
      id: "seg.@modal",
      component: "cached-component",
      loaderIds: ["a", "b"],
      loaderDataPromise: Promise.resolve([1, 2]),
    } as any;
    const fromServer = {
      id: "seg.@modal",
      component: "server-component",
      loaderIds: [],
      loaderDataPromise: [],
    } as any;

    expect(needsLoaderMerge(fromServer, fromCache)).toBe(true);
    const merged = mergeSegmentLoaders(fromServer, fromCache);
    expect(merged.component).toBe("server-component");
    expect(merged.loaderIds).toEqual(["a", "b"]);
    await expect(merged.loaderDataPromise).resolves.toEqual([1, 2]);
  });

  it("merges two settled aggregates into the array itself, not a fresh promise", () => {
    const fulfilled = Object.assign(Promise.resolve([1, 2, 3]), {
      status: "fulfilled",
      value: [1, 2, 3],
    });
    const merged = mergeSegmentLoaders(
      { id: "seg", loaderIds: ["b"], loaderDataPromise: [20] } as any,
      {
        id: "seg",
        loaderIds: ["a", "b", "c"],
        loaderDataPromise: fulfilled,
      } as any,
    );

    expect(merged.loaderDataPromise).toEqual([1, 20, 3]);
  });

  it("does not merge into a server segment without an aggregate", () => {
    // A parallel slot's loaders are loader segments of their own: the server
    // sends the slot with no aggregate, while the browser's copy carries the
    // one segment-system attached at render. It must not be merged.
    const fromCache = {
      id: "seg.@cart",
      component: "cached-component",
      loaderIds: ["cart"],
      loaderDataPromise: Promise.resolve([{ count: 0 }]),
    } as any;
    const fromServer = {
      id: "seg.@cart",
      component: "server-component",
    } as any;

    expect(needsLoaderMerge(fromServer, fromCache)).toBe(false);
  });

  it("inserts missing diff segments after parent layout and appends non-loader diffs", () => {
    const allSegments = [{ id: "M9L0L1" }, { id: "M9L0L1.child" }] as any[];
    const diffIds = ["M9L0L1D0.actionCounter", "M9L0L1.new-route"];
    const matchedIdSet = new Set<string>(["M9L0L1", "M9L0L1.child"]);
    const newSegmentMap = new Map<string, any>([
      ["M9L0L1D0.actionCounter", { id: "M9L0L1D0.actionCounter" }],
      ["M9L0L1.new-route", { id: "M9L0L1.new-route" }],
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    insertMissingDiffSegments(
      allSegments as any,
      diffIds,
      matchedIdSet,
      newSegmentMap,
    );

    expect(allSegments.map((segment) => segment.id)).toEqual([
      "M9L0L1",
      "M9L0L1D0.actionCounter",
      "M9L0L1.child",
      "M9L0L1.new-route",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("preserves server order when inserting multiple diff loaders for the same parent", () => {
    const allSegments = [{ id: "M0L0" }, { id: "M0L0.route" }] as any[];
    const diffIds = ["M0L0D0.loaderA", "M0L0D1.loaderB", "M0L0D2.loaderC"];
    const matchedIdSet = new Set<string>(["M0L0", "M0L0.route"]);
    const newSegmentMap = new Map<string, any>([
      ["M0L0D0.loaderA", { id: "M0L0D0.loaderA" }],
      ["M0L0D1.loaderB", { id: "M0L0D1.loaderB" }],
      ["M0L0D2.loaderC", { id: "M0L0D2.loaderC" }],
    ]);

    insertMissingDiffSegments(
      allSegments as any,
      diffIds,
      matchedIdSet,
      newSegmentMap,
    );

    // Siblings must appear in the same order the server returned them
    expect(allSegments.map((s) => s.id)).toEqual([
      "M0L0",
      "M0L0D0.loaderA",
      "M0L0D1.loaderB",
      "M0L0D2.loaderC",
      "M0L0.route",
    ]);
  });
});
