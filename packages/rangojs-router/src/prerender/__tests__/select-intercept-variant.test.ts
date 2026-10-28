import { describe, expect, it } from "vitest";
import type { SerializedSegmentData } from "../../cache/types.js";
import { selectInterceptVariant, type PrerenderEntry } from "../store.js";

function segment(id: string, namespace?: string): SerializedSegmentData {
  return {
    encoded: id,
    metadata: { id, namespace, type: namespace ? "parallel" : "layout" },
  } as SerializedSegmentData;
}

const ITEM = "intercept:item";

const entry: PrerenderEntry = {
  segments: [
    segment("M0L0"),
    segment("M0L0L0"),
    segment("M0L0.@outer", ITEM),
    segment("M0L0L0.@modal", ITEM),
  ],
  handles: "encoded-handles",
};

const ids = (selected: PrerenderEntry | null): string[] | null =>
  selected?.segments.map((s) => s.metadata.id) ?? null;

describe("selectInterceptVariant", () => {
  it("keeps the main segments and the selected intercept's slot", () => {
    expect(ids(selectInterceptVariant(entry, "M0L0L0.@modal", "item"))).toEqual(
      ["M0L0", "M0L0L0", "M0L0L0.@modal"],
    );
    expect(ids(selectInterceptVariant(entry, "M0L0.@outer", "item"))).toEqual([
      "M0L0",
      "M0L0L0",
      "M0L0.@outer",
    ]);
  });

  it("keeps the handles string whole", () => {
    expect(
      selectInterceptVariant(entry, "M0L0L0.@modal", "item")?.handles,
    ).toBe("encoded-handles");
  });

  it("misses when the variant does not hold the selected slot", () => {
    expect(selectInterceptVariant(entry, "M0L0.@drawer", "item")).toBeNull();
  });

  it("misses for an intercept of another route name in the same slot", () => {
    expect(selectInterceptVariant(entry, "M0L0L0.@modal", "detail")).toBeNull();
  });
});
