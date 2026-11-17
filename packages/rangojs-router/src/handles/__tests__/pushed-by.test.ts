import { describe, expect, it } from "vitest";
import type { HandleData } from "../../server/handle-store.js";
import {
  mergeLoaderReadHandleData,
  pushedByKey,
  withSegmentHandles,
} from "../pushed-by.js";

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

describe("mergeLoaderReadHandleData", () => {
  // A layout L0 and its route R0, which registers "title" and "other"; the
  // route's handler pushed first, then each loader.
  const segmentOrder = ["L0", "R0"];
  const matched = ["L0", "R0D0.title", "R0D1.other", "R0"];
  const page = (): HandleData => ({
    Meta: { L0: [{ title: "Site" }], R0: [{ title: "Old" }, { desc: "x" }] },
    [pushedByKey("Meta")]: { R0: ["title", "other"] },
    Crumbs: { L0: ["Home"], R0: ["Page", "Old crumb"] },
    [pushedByKey("Crumbs")]: { R0: [null, "title"] },
  });

  it("puts the read's values in place of the loader's own, in their position", () => {
    const out = mergeLoaderReadHandleData(
      page(),
      segmentOrder,
      matched,
      "title",
      { Meta: [{ title: "New" }], Crumbs: ["New crumb"] },
    );
    expect(out).toEqual({
      Meta: { L0: [{ title: "Site" }], R0: [{ title: "New" }, { desc: "x" }] },
      [pushedByKey("Meta")]: { R0: ["title", "other"] },
      Crumbs: { L0: ["Home"], R0: ["Page", "New crumb"] },
      [pushedByKey("Crumbs")]: { R0: [null, "title"] },
    });
  });

  it("drops the loader's earlier values of a handle it no longer pushes", () => {
    const out = mergeLoaderReadHandleData(
      page(),
      segmentOrder,
      matched,
      "title",
      { Meta: [{ title: "New" }] },
    );
    expect(out!.Crumbs).toEqual({ L0: ["Home"], R0: ["Page"] });
    expect(out![pushedByKey("Crumbs")]).toBeUndefined();
  });

  it("clears the loader's values when the read pushed nothing", () => {
    const out = mergeLoaderReadHandleData(
      page(),
      segmentOrder,
      matched,
      "title",
      {},
    );
    expect(out).toEqual({
      Meta: { L0: [{ title: "Site" }], R0: [{ desc: "x" }] },
      [pushedByKey("Meta")]: { R0: ["other"] },
      Crumbs: { L0: ["Home"], R0: ["Page"] },
    });
  });

  it("appends a first push to the segment that registers the loader", () => {
    const out = mergeLoaderReadHandleData(
      page(),
      segmentOrder,
      matched,
      "other",
      { Crumbs: ["Other crumb"] },
    );
    expect(out!.Crumbs).toEqual({
      L0: ["Home"],
      R0: ["Page", "Old crumb", "Other crumb"],
    });
    expect(out![pushedByKey("Crumbs")]).toEqual({
      R0: [null, "title", "other"],
    });
    // "other" no longer pushes Meta: its description goes.
    expect(out!.Meta).toEqual({
      L0: [{ title: "Site" }],
      R0: [{ title: "Old" }],
    });
  });

  it("files under the segment holding the loader's values when two register it", () => {
    const both = ["L0", "L0D0.title", "R0D0.title", "R0"];
    const out = mergeLoaderReadHandleData(page(), segmentOrder, both, "title", {
      Meta: [{ title: "New" }],
    });
    expect(out!.Meta).toEqual({
      L0: [{ title: "Site" }],
      R0: [{ title: "New" }, { desc: "x" }],
    });
    // Nothing of it on the page yet: the outermost registration, as a render
    // starts the layout's loaders first.
    const fresh = mergeLoaderReadHandleData({}, segmentOrder, both, "title", {
      Meta: [{ title: "New" }],
    });
    expect(fresh!.Meta).toEqual({ L0: [{ title: "New" }] });
  });

  it.each([
    ["a parallel slot", "R0.@side"],
    ["an intercept's slot", "R0.@modal"],
  ])("files under %s that registers the loader", (_kind, slot) => {
    const out = mergeLoaderReadHandleData(
      {
        Meta: { R0: [{ title: "Page" }], [slot]: [{ title: "Old" }] },
        [pushedByKey("Meta")]: { [slot]: ["title"] },
      },
      ["R0", slot],
      ["R0", `${slot}D0.title`, slot],
      "title",
      { Meta: [{ title: "New" }] },
    );
    expect(out!.Meta).toEqual({
      R0: [{ title: "Page" }],
      [slot]: [{ title: "New" }],
    });
  });

  it("is undefined for a loader no segment registers", () => {
    expect(
      mergeLoaderReadHandleData(page(), segmentOrder, matched, "unregistered", {
        Meta: [{ title: "New" }],
      }),
    ).toBeUndefined();
  });

  it("matches the loader id whole, after the first loader marker", () => {
    const ids = ["R0", "R0D0.src/a.ts#Title", "R0D1.src/a.ts#TitleD2.x"];
    const out = mergeLoaderReadHandleData(
      {
        Meta: { R0: [{ title: "Old" }] },
        [pushedByKey("Meta")]: { R0: ["src/a.ts#Title"] },
      },
      ["R0"],
      ids,
      "src/a.ts#Title",
      { Meta: [{ title: "New" }] },
    );
    expect(out!.Meta).toEqual({ R0: [{ title: "New" }] });
  });

  it("leaves the page's data as it was", () => {
    const current = page();
    const before = JSON.stringify(current);
    mergeLoaderReadHandleData(current, segmentOrder, matched, "title", {
      Meta: [{ title: "New" }],
    });
    expect(JSON.stringify(current)).toBe(before);
  });
});
