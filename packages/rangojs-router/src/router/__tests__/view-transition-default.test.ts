import { describe, it, expect } from "vitest";
import { applyViewTransitionDefault } from "../segment-resolution/view-transition-default.js";

/**
 * Unit coverage for the createRouter({ viewTransition }) global default
 * mechanics. This pure resolver is the entire mechanism by which the global
 * default reaches a segment: it stamps `viewTransition: false` onto each
 * segment's transition config during resolution so the render gate (which
 * reads `transition.viewTransition !== false`) sees a concrete value. The
 * per-segment transition({ viewTransition }) value always wins.
 */
describe("applyViewTransitionDefault", () => {
  it("returns an absent transition unchanged regardless of the default", () => {
    expect(applyViewTransitionDefault(undefined, false)).toBeUndefined();
    expect(applyViewTransitionDefault(undefined, "auto")).toBeUndefined();
    expect(applyViewTransitionDefault(undefined, undefined)).toBeUndefined();
  });

  it("lets the per-segment value win over the global default", () => {
    // Per-segment "auto" survives a global false.
    expect(
      applyViewTransitionDefault({ viewTransition: "auto" }, false),
    ).toEqual({
      viewTransition: "auto",
    });
    // Per-segment false survives a global auto.
    expect(
      applyViewTransitionDefault({ viewTransition: false }, "auto"),
    ).toEqual({ viewTransition: false });
  });

  it("stamps viewTransition:false when unset and the global default is false", () => {
    expect(applyViewTransitionDefault({}, false)).toEqual({
      viewTransition: false,
    });
    expect(applyViewTransitionDefault({ enter: "fade" }, false)).toEqual({
      enter: "fade",
      viewTransition: false,
    });
  });

  it("does not stamp when the default is auto/undefined (unset already means wrap)", () => {
    const cfg = { enter: "fade" };
    // Same reference back: no allocation, no payload growth.
    expect(applyViewTransitionDefault(cfg, "auto")).toBe(cfg);
    expect(applyViewTransitionDefault(cfg, undefined)).toBe(cfg);
  });

  it("does not mutate the input config when stamping", () => {
    const cfg = { enter: "fade" };
    const out = applyViewTransitionDefault(cfg, false);
    expect(cfg).toEqual({ enter: "fade" });
    expect(out).not.toBe(cfg);
  });
});
