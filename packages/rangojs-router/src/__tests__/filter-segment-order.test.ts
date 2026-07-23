import { describe, expect, it } from "vitest";
import {
  filterSegmentOrder,
  filterRouteSegmentIds,
} from "../browser/react/filter-segment-order";
import { collectHandleData, createHandle } from "../handle";

describe("filterSegmentOrder", () => {
  it("keeps route/layout segment IDs", () => {
    const matched = ["M0", "M0L0", "M0L0L1"];
    expect(filterSegmentOrder(matched)).toEqual(matched);
  });

  it("keeps parallel slot ids and drops loader sub-ids", () => {
    const matched = ["M0", "M0.@modal", "M0L0D0.user", "M0L0", "M0L0D12.posts"];

    expect(filterSegmentOrder(matched)).toEqual(["M0", "M0.@modal", "M0L0"]);
  });

  it("keeps layout-mounted slot ordering when slot already follows parent", () => {
    const matched = ["L0", "L0.@panel", "L0L1", "L0L1.@aside"];
    expect(filterSegmentOrder(matched)).toEqual(matched);
  });

  /**
   * Regression: in the fresh path, route-mounted parallels resolve BEFORE
   * the route segment is pushed (fresh.ts ~335 vs ~355) and the same in the
   * revalidation path (revalidation.ts ~916/919). Raw matched order for a
   * route with parallels is therefore [..., R0.@panel, R0] — slot before
   * route. collectHandleData consumes segmentOrder verbatim with later-wins
   * semantics, so without normalization the route handler's Meta would
   * override the slot's more specific Meta. filterSegmentOrder() normalizes
   * so each slot id appears immediately after its parent.
   */
  it("places route-mounted slot ids AFTER the route segment", () => {
    const matched = ["L0", "R0.@panel", "R0"];
    expect(filterSegmentOrder(matched)).toEqual(["L0", "R0", "R0.@panel"]);
  });

  it("groups multiple slots under the same parent in matched order", () => {
    const matched = ["R0.@meta", "R0.@breadcrumbs", "R0"];
    expect(filterSegmentOrder(matched)).toEqual([
      "R0",
      "R0.@meta",
      "R0.@breadcrumbs",
    ]);
  });
});

/**
 * filterRouteSegmentIds feeds useSegments().segmentIds and is shared by SSR
 * (ssr/index.tsx) and the client event controller (event-controller.ts). Both
 * call sites must produce identical output or SSR and post-hydration disagree
 * and React reports a hydration mismatch.
 */
describe("filterRouteSegmentIds", () => {
  it("keeps route/layout ids unchanged", () => {
    const matched = ["M0", "M0L0", "M0L0L1"];
    expect(filterRouteSegmentIds(matched)).toEqual(matched);
  });

  it("drops parallel slot ids (.@) and loader sub-ids (D digit)", () => {
    const matched = ["L0", "L0.@panel", "R0", "R0.@meta", "R0L0D0.user"];
    expect(filterRouteSegmentIds(matched)).toEqual(["L0", "R0"]);
  });

  it("does NOT reorder (unlike filterSegmentOrder)", () => {
    // Raw match order with slot before route is preserved minus the slot.
    const matched = ["R0.@panel", "R0", "L0"];
    expect(filterRouteSegmentIds(matched)).toEqual(["R0", "L0"]);
  });

  it("SSR and client derive identical ids from the same matched list", () => {
    // Both ssr/index.tsx and event-controller.ts call this helper; a single
    // implementation guarantees agreement. Exercise a representative match.
    const matched = ["M0", "M0.@modal", "M0L0", "M0L0D2.posts", "M0L0L1"];
    const ssrSide = filterRouteSegmentIds(matched);
    const clientSide = filterRouteSegmentIds(matched);
    expect(ssrSide).toEqual(clientSide);
    expect(ssrSide).toEqual(["M0", "M0L0", "M0L0L1"]);
  });
});

/**
 * Consumer-level regression for the order normalization: a route handler
 * pushes a Meta default/title; a parallel slot under that same route pushes
 * a more specific Meta. The slot must override the route, never the other
 * way around.
 */
describe("collectHandleData with parallel slot ordering", () => {
  const Meta = createHandle<{ title?: string }, { title: string }>(
    (segments) =>
      Object.assign({ title: "" }, ...segments.flat()) as { title: string },
    "test#Meta",
  );

  it("route-mounted slot's Meta overrides the route's Meta", () => {
    const data = {
      [Meta.$$id]: {
        R0: [{ title: "Generic Product" }],
        "R0.@panel": [{ title: "Product A specific title" }],
      },
    };
    // Raw match order has slot before route — what fresh.ts/revalidation.ts emit.
    const segmentOrder = filterSegmentOrder(["R0.@panel", "R0"]);

    const result = collectHandleData(Meta, data, segmentOrder);

    expect(result).toEqual({ title: "Product A specific title" });
  });

  it("layout-mounted slot's Meta overrides the layout's Meta", () => {
    const data = {
      [Meta.$$id]: {
        L0: [{ title: "Layout default" }],
        "L0.@panel": [{ title: "Slot specific" }],
      },
    };
    const segmentOrder = filterSegmentOrder(["L0", "L0.@panel"]);

    const result = collectHandleData(Meta, data, segmentOrder);

    expect(result).toEqual({ title: "Slot specific" });
  });
});
