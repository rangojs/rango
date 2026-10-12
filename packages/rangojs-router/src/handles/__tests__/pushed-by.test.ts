import { describe, expect, it } from "vitest";
import type { HandleData } from "../../server/handle-store.js";
import { pushedByKey, withSegmentHandles } from "../pushed-by.js";

describe("withSegmentHandles", () => {
  const target = (): HandleData => ({
    Crumbs: { L0: ["entry-layout"], R0: ["entry-page", "entry-loader"] },
    [pushedByKey("Crumbs")]: { R0: [null, "loader"] },
    Meta: { R0: [{ title: "Entry" }] },
  });
  const source = (): HandleData => ({
    Crumbs: { L0: ["screen-layout", "screen-loader"], R9: ["screen-page"] },
    [pushedByKey("Crumbs")]: { L0: [null, "layoutLoader"] },
    Meta: { L0: [{ title: "Screen" }] },
  });

  it("takes the named segments' buckets from source and the rest from target", () => {
    expect(withSegmentHandles(target(), source(), new Set(["L0"]))).toEqual({
      Crumbs: {
        L0: ["screen-layout", "screen-loader"],
        R0: ["entry-page", "entry-loader"],
      },
      [pushedByKey("Crumbs")]: {
        L0: [null, "layoutLoader"],
        R0: [null, "loader"],
      },
      Meta: { L0: [{ title: "Screen" }], R0: [{ title: "Entry" }] },
    });
  });

  it("moves a pushedBy record with its values, absent ones included", () => {
    // R0 from source, where nothing pushed under it and it has no record:
    // the target's values and record both go.
    const out = withSegmentHandles(target(), source(), new Set(["R0"]));
    expect(out.Crumbs).toEqual({ L0: ["entry-layout"] });
    expect(out[pushedByKey("Crumbs")]).toBeUndefined();
    expect(out.Meta).toBeUndefined();
  });

  it("with no ids, is the target in new containers", () => {
    const entry = target();
    const out = withSegmentHandles(entry, source(), new Set());
    expect(out).toEqual(entry);
    expect(out).not.toBe(entry);
    expect(out.Crumbs).not.toBe(entry.Crumbs);
    out.Crumbs.L0 = ["changed"];
    expect(entry.Crumbs.L0).toEqual(["entry-layout"]);
  });
});
