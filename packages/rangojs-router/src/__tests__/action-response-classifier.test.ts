import { describe, it, expect } from "vitest";
import {
  classifyActionResponse,
  type ClassifierInput,
} from "../browser/action-response-classifier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides?: Partial<ClassifierInput>): ClassifierInput {
  return {
    actionStartPathname: "/page",
    currentPathname: "/page",
    actionStartLocationKey: "key1",
    currentLocationKey: "key1",
    reconciledSegmentCount: 3,
    matchedCount: 3,
    consolidationSegments: null,
    otherFetchingActionCount: 0,
    currentInterceptSource: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("action-response-classifier", () => {
  describe("navigated-away scenario", () => {
    it("detects different pathname", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/page-a",
          currentPathname: "/page-b",
          actionStartLocationKey: "key1",
          currentLocationKey: "key1",
        }),
      );
      expect(result).toEqual({
        type: "navigated-away",
        historyKeyChanged: false,
        onInterceptRoute: false,
      });
    });

    it("detects different history key", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/page",
          currentPathname: "/other",
          actionStartLocationKey: "key1",
          currentLocationKey: "key2",
        }),
      );
      expect(result).toEqual({
        type: "navigated-away",
        historyKeyChanged: true,
        onInterceptRoute: false,
      });
    });

    it("detects on intercept route when history key changed", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/page",
          currentPathname: "/other",
          actionStartLocationKey: "key1",
          currentLocationKey: "key2",
          currentInterceptSource: "/source",
        }),
      );
      expect(result).toEqual({
        type: "navigated-away",
        historyKeyChanged: true,
        onInterceptRoute: true,
      });
    });

    it("historyKeyChanged=false when pathnames differ but keys match", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/page-a",
          currentPathname: "/page-b",
          actionStartLocationKey: "key1",
          currentLocationKey: "key1",
        }),
      );
      expect(result.type).toBe("navigated-away");
      if (result.type === "navigated-away") {
        expect(result.historyKeyChanged).toBe(false);
      }
    });

    it("historyKeyChanged=true when only keys differ", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/page",
          currentPathname: "/page",
          actionStartLocationKey: "key1",
          currentLocationKey: "key2",
        }),
      );
      expect(result.type).toBe("navigated-away");
      if (result.type === "navigated-away") {
        expect(result.historyKeyChanged).toBe(true);
      }
    });
  });

  describe("hmr-missing scenario", () => {
    it("returns hmr-missing when fewer reconciled segments than matched", () => {
      const result = classifyActionResponse(
        baseInput({
          reconciledSegmentCount: 2,
          matchedCount: 3,
        }),
      );
      expect(result).toEqual({ type: "hmr-missing" });
    });

    it("does not trigger when counts are equal", () => {
      const result = classifyActionResponse(
        baseInput({
          reconciledSegmentCount: 3,
          matchedCount: 3,
        }),
      );
      expect(result.type).not.toBe("hmr-missing");
    });
  });

  describe("consolidation-needed scenario", () => {
    it("returns consolidation-needed with segment IDs", () => {
      const result = classifyActionResponse(
        baseInput({
          consolidationSegments: ["L0", "L0R0"],
        }),
      );
      expect(result).toEqual({
        type: "consolidation-needed",
        segmentIds: ["L0", "L0R0"],
      });
    });

    it("does not trigger for empty consolidation array", () => {
      const result = classifyActionResponse(
        baseInput({
          consolidationSegments: [],
        }),
      );
      expect(result.type).not.toBe("consolidation-needed");
    });

    it("does not trigger for null consolidation", () => {
      const result = classifyActionResponse(
        baseInput({
          consolidationSegments: null,
        }),
      );
      expect(result.type).not.toBe("consolidation-needed");
    });
  });

  describe("concurrent-skip scenario", () => {
    it("returns concurrent-skip with count", () => {
      const result = classifyActionResponse(
        baseInput({
          otherFetchingActionCount: 2,
        }),
      );
      expect(result).toEqual({
        type: "concurrent-skip",
        otherFetchingCount: 2,
      });
    });

    it("does not trigger when no other actions fetching", () => {
      const result = classifyActionResponse(
        baseInput({
          otherFetchingActionCount: 0,
        }),
      );
      expect(result.type).not.toBe("concurrent-skip");
    });
  });

  describe("normal scenario", () => {
    it("returns normal when no special conditions", () => {
      const result = classifyActionResponse(baseInput());
      expect(result).toEqual({ type: "normal" });
    });

    it("returns normal when same pathname and key with all counts matching", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/same",
          currentPathname: "/same",
          actionStartLocationKey: "same-key",
          currentLocationKey: "same-key",
          reconciledSegmentCount: 5,
          matchedCount: 5,
          consolidationSegments: null,
          otherFetchingActionCount: 0,
        }),
      );
      expect(result).toEqual({ type: "normal" });
    });
  });

  describe("priority ordering", () => {
    it("navigated-away takes priority over hmr-missing", () => {
      const result = classifyActionResponse(
        baseInput({
          actionStartPathname: "/a",
          currentPathname: "/b",
          reconciledSegmentCount: 1,
          matchedCount: 3,
        }),
      );
      expect(result.type).toBe("navigated-away");
    });

    it("hmr-missing takes priority over consolidation", () => {
      const result = classifyActionResponse(
        baseInput({
          reconciledSegmentCount: 1,
          matchedCount: 3,
          consolidationSegments: ["L0"],
        }),
      );
      expect(result.type).toBe("hmr-missing");
    });

    it("consolidation takes priority over concurrent-skip", () => {
      const result = classifyActionResponse(
        baseInput({
          consolidationSegments: ["L0"],
          otherFetchingActionCount: 2,
        }),
      );
      expect(result.type).toBe("consolidation-needed");
    });

    it("concurrent-skip takes priority over normal", () => {
      const result = classifyActionResponse(
        baseInput({
          otherFetchingActionCount: 1,
        }),
      );
      expect(result.type).toBe("concurrent-skip");
    });
  });
});
