import { describe, it, expect } from "vitest";
import type { ResolvedSegment } from "../browser/types";
import type { SlotState } from "../types";
import {
  isInterceptSegment,
  splitInterceptSegments,
  hasActiveIntercept,
  isInterceptOnlyCache,
} from "../browser/intercept-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seg(
  id: string,
  overrides?: Partial<ResolvedSegment>,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intercept-utils", () => {
  describe("isInterceptSegment", () => {
    it("returns true for namespace starting with 'intercept:'", () => {
      const s = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });
      expect(isInterceptSegment(s)).toBe(true);
    });

    it("returns false for parallel segment with .@ in ID but no intercept namespace", () => {
      const s = seg("L0.@sidebar", { type: "parallel" });
      expect(isInterceptSegment(s)).toBe(false);
    });

    it("returns false for .@ in ID but non-parallel type", () => {
      const s = seg("L0.@sidebar", { type: "layout" });
      expect(isInterceptSegment(s)).toBe(false);
    });

    it("returns false for regular layout segment", () => {
      const s = seg("L0", { type: "layout" });
      expect(isInterceptSegment(s)).toBe(false);
    });

    it("returns false for regular route segment", () => {
      const s = seg("L0R0", { type: "route" });
      expect(isInterceptSegment(s)).toBe(false);
    });

    it("returns false for parallel segment without .@ in ID", () => {
      const s = seg("L0P0", { type: "parallel" });
      expect(isInterceptSegment(s)).toBe(false);
    });

    it("returns true for intercept: namespace even without .@ in ID", () => {
      const s = seg("someId", {
        type: "route",
        namespace: "intercept:dialog",
      });
      expect(isInterceptSegment(s)).toBe(true);
    });
  });

  describe("splitInterceptSegments", () => {
    it("splits mixed array into main and intercept", () => {
      const layout = seg("L0", { type: "layout" });
      const route = seg("L0R0");
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });

      const result = splitInterceptSegments([layout, route, modal]);

      expect(result.main).toEqual([layout, route]);
      expect(result.intercept).toEqual([modal]);
    });

    it("returns empty intercept for non-intercept segments", () => {
      const layout = seg("L0", { type: "layout" });
      const route = seg("L0R0");

      const result = splitInterceptSegments([layout, route]);

      expect(result.main).toEqual([layout, route]);
      expect(result.intercept).toEqual([]);
    });

    it("returns empty main for all-intercept segments", () => {
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });
      const dialog = seg("L0.@dialog", {
        type: "parallel",
        namespace: "intercept:dialog",
      });

      const result = splitInterceptSegments([modal, dialog]);

      expect(result.main).toEqual([]);
      expect(result.intercept).toEqual([modal, dialog]);
    });

    it("keeps regular parallel segments in main group", () => {
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });
      const sidebar = seg("L0.@sidebar", { type: "parallel" });

      const result = splitInterceptSegments([modal, sidebar]);

      expect(result.main).toEqual([sidebar]);
      expect(result.intercept).toEqual([modal]);
    });

    it("handles empty array", () => {
      const result = splitInterceptSegments([]);

      expect(result.main).toEqual([]);
      expect(result.intercept).toEqual([]);
    });

    it("preserves order within each group", () => {
      const s1 = seg("L0", { type: "layout" });
      const s2 = seg("L0.@a", { type: "parallel", namespace: "intercept:a" });
      const s3 = seg("L0R0");
      const s4 = seg("L0.@b", { type: "parallel", namespace: "intercept:b" });

      const result = splitInterceptSegments([s1, s2, s3, s4]);

      expect(result.main.map((s) => s.id)).toEqual(["L0", "L0R0"]);
      expect(result.intercept.map((s) => s.id)).toEqual(["L0.@a", "L0.@b"]);
    });
  });

  describe("hasActiveIntercept", () => {
    it("returns false when slots is undefined", () => {
      expect(hasActiveIntercept(undefined)).toBe(false);
    });

    it("returns false for empty slots", () => {
      expect(hasActiveIntercept({})).toBe(false);
    });

    it("returns true when any slot is active", () => {
      const slots: Record<string, SlotState> = {
        "@modal": { active: true },
      };
      expect(hasActiveIntercept(slots)).toBe(true);
    });

    it("returns false when all slots are inactive", () => {
      const slots: Record<string, SlotState> = {
        "@modal": { active: false },
        "@sidebar": { active: false },
      };
      expect(hasActiveIntercept(slots)).toBe(false);
    });

    it("returns true when at least one slot is active among multiple", () => {
      const slots: Record<string, SlotState> = {
        "@modal": { active: false },
        "@sidebar": { active: true },
      };
      expect(hasActiveIntercept(slots)).toBe(true);
    });
  });

  describe("isInterceptOnlyCache", () => {
    it("returns false for no intercept segments", () => {
      const segments = [
        seg("L0", { type: "layout" }),
        seg("L0R0"),
      ];
      expect(isInterceptOnlyCache(segments)).toBe(false);
    });

    it("returns true when any segment is an intercept", () => {
      const segments = [
        seg("L0", { type: "layout" }),
        seg("L0.@modal", { type: "parallel", namespace: "intercept:modal" }),
      ];
      expect(isInterceptOnlyCache(segments)).toBe(true);
    });

    it("returns true for all-intercept segments", () => {
      const segments = [
        seg("L0.@modal", { type: "parallel", namespace: "intercept:modal" }),
      ];
      expect(isInterceptOnlyCache(segments)).toBe(true);
    });

    it("returns false for empty array", () => {
      expect(isInterceptOnlyCache([])).toBe(false);
    });
  });
});
