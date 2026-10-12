import { describe, expect, it, vi } from "vitest";
import { insertMissingDiffSegments } from "../browser/merge-segment-loaders";

describe("merge-segment-loaders", () => {
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
