import { describe, expect, it } from "vitest";
import { filterSegmentOrder } from "../browser/react/filter-segment-order";

describe("filterSegmentOrder", () => {
  it("keeps route/layout segment IDs", () => {
    const matched = ["M0", "M0L0", "M0L0L1"];
    expect(filterSegmentOrder(matched)).toEqual(matched);
  });

  it("filters out parallel and loader segments", () => {
    const matched = ["M0", "M0.@modal", "M0L0D0.user", "M0L0", "M0L0D12.posts"];

    expect(filterSegmentOrder(matched)).toEqual(["M0", "M0L0"]);
  });
});
