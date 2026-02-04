import { describe, it, expect } from "vitest";
import { createPipelineState } from "../match-context";

describe("match-context", () => {
  describe("createPipelineState()", () => {
    it("should create initial state with default values", () => {
      const state = createPipelineState();

      expect(state.cacheHit).toBe(false);
      expect(state.segments).toEqual([]);
      expect(state.matchedIds).toEqual([]);
      expect(state.interceptSegments).toEqual([]);
      expect(state.slots).toEqual({});
    });

    it("should create state without cached data by default", () => {
      const state = createPipelineState();

      expect(state.cachedSegments).toBeUndefined();
      expect(state.cachedMatchedIds).toBeUndefined();
      expect(state.shouldRevalidate).toBeUndefined();
    });

    it("should allow mutation of state properties", () => {
      const state = createPipelineState();

      state.cacheHit = true;
      state.segments.push({
        id: "seg1",
        namespace: "seg1",
        type: "route",
        index: 0,
        component: null,
        params: {},
      });
      state.matchedIds.push("seg1");
      state.slots["@modal"] = { active: true, segments: [] };

      expect(state.cacheHit).toBe(true);
      expect(state.segments).toHaveLength(1);
      expect(state.matchedIds).toContain("seg1");
      expect(state.slots["@modal"]).toBeDefined();
    });

    it("should create independent state instances", () => {
      const state1 = createPipelineState();
      const state2 = createPipelineState();

      state1.cacheHit = true;
      state1.segments.push({
        id: "seg1",
        namespace: "seg1",
        type: "route",
        index: 0,
        component: null,
        params: {},
      });

      expect(state2.cacheHit).toBe(false);
      expect(state2.segments).toHaveLength(0);
    });

    it("should support setting cache-related properties", () => {
      const state = createPipelineState();

      state.cacheHit = true;
      state.shouldRevalidate = true;
      state.cachedSegments = [
        { id: "cached1", namespace: "cached1", type: "route", index: 0, component: "CachedComponent", params: {} },
      ];
      state.cachedMatchedIds = ["cached1"];

      expect(state.cacheHit).toBe(true);
      expect(state.shouldRevalidate).toBe(true);
      expect(state.cachedSegments).toHaveLength(1);
      expect(state.cachedMatchedIds).toContain("cached1");
    });

    it("should support intercept segments", () => {
      const state = createPipelineState();

      state.interceptSegments.push({
        id: "modal-seg",
        namespace: "modal-seg",
        type: "route",
        index: 0,
        component: "ModalComponent",
        params: {},
      });

      expect(state.interceptSegments).toHaveLength(1);
      expect(state.interceptSegments[0].id).toBe("modal-seg");
    });

    it("should support slots with nested segments", () => {
      const state = createPipelineState();

      state.slots["@modal"] = {
        active: true,
        segments: [
          { id: "modal1", namespace: "modal1", type: "route", index: 0, component: "Modal1", params: {} },
          { id: "modal2", namespace: "modal2", type: "route", index: 0, component: "Modal2", params: {} },
        ],
      };

      expect(state.slots["@modal"].active).toBe(true);
      expect(state.slots["@modal"].segments).toHaveLength(2);
    });
  });
});
