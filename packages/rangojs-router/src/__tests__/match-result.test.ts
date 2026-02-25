import { describe, it, expect, vi } from "vitest";
import { buildMatchResult } from "../router/match-result.js";
import type { ResolvedSegment } from "../types.js";
import type {
  MatchContext,
  MatchPipelineState,
} from "../router/match-context.js";

// Mock metrics and logging (not relevant to these tests)
vi.mock("../router/metrics.js", () => ({
  generateServerTiming: vi.fn(),
  logMetrics: vi.fn(),
}));
vi.mock("../router/logging.js", () => ({
  debugLog: vi.fn(),
}));

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
    type: "layout",
    component: `component-${id}`,
    ...overrides,
  } as any;
}

function makeCtx(overrides?: Partial<MatchContext<any>>): MatchContext<any> {
  return {
    isFullMatch: true,
    matched: { params: {} },
    routeKey: "test",
    request: { method: "GET" } as any,
    pathname: "/test",
    clientSegmentIds: [],
    interceptResult: null,
    routeMiddleware: [],
    ...overrides,
  } as any;
}

function makeState(
  overrides?: Partial<MatchPipelineState>,
): MatchPipelineState {
  return {
    cacheHit: false,
    segments: [],
    matchedIds: [],
    interceptSegments: [],
    slots: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildMatchResult", () => {
  describe("unique segment ID invariant", () => {
    it("produces unique matched IDs for full match with unique segments", () => {
      const segments = [
        seg("M0L0"),
        seg("M0L0C0"),
        seg("M0L0C0L0"),
        seg("M0L0C0L0R0", { type: "route" }),
      ];

      const result = buildMatchResult(segments, makeCtx(), makeState());

      expect(result.matched).toEqual([
        "M0L0",
        "M0L0C0",
        "M0L0C0L0",
        "M0L0C0L0R0",
      ]);
      expect(new Set(result.matched).size).toBe(result.matched.length);
    });

    it("deduplicates segment IDs when allSegments contains duplicates from include() scopes", () => {
      // Simulates the bug: include() scopes produce entries that resolve the
      // same shared layout segment. Without dedup, the client receives duplicate
      // IDs in matched[], changing the React tree depth and causing remounts.
      const segments = [
        seg("M0L0"),
        seg("M0L0C0"), // shared layout (first occurrence)
        seg("M0L0C0L0"),
        seg("M0L0C0"), // shared layout (DUPLICATE from second include scope)
        seg("M0L0C0L0R0", { type: "route" }),
      ];

      const result = buildMatchResult(segments, makeCtx(), makeState());

      // matched must have unique IDs - no duplicates
      expect(new Set(result.matched).size).toBe(result.matched.length);
      expect(result.matched).toEqual([
        "M0L0",
        "M0L0C0",
        "M0L0C0L0",
        "M0L0C0L0R0",
      ]);
    });

    it("deduplicates segments array (not just IDs) for full match", () => {
      const segments = [
        seg("M0L0"),
        seg("M0L0C0"),
        seg("M0L0"), // duplicate
        seg("M0L0C0L0R0", { type: "route" }),
      ];

      const result = buildMatchResult(segments, makeCtx(), makeState());

      // segments should also be deduped (keeping first occurrence)
      expect(result.segments.length).toBe(3);
      expect(result.segments.map((s) => s.id)).toEqual([
        "M0L0",
        "M0L0C0",
        "M0L0C0L0R0",
      ]);
    });

    it("deduplicates matched IDs for partial match", () => {
      const segments = [
        seg("M0L0"),
        seg("M0L0C0", { component: null }), // null = client already has it
        seg("M0L0C0L0", { component: null }), // null = client already has it
        seg("M0L0C0L0R0", { type: "route" }), // has component
      ];

      const state = makeState({
        // matchedIds with duplicates (simulating unfixed resolveAllSegmentsWithRevalidation)
        matchedIds: ["M0L0", "M0L0C0", "M0L0C0L0", "M0L0", "M0L0C0L0R0"],
      });

      const result = buildMatchResult(
        segments,
        makeCtx({ isFullMatch: false }),
        state,
      );

      // matched must have unique IDs
      expect(new Set(result.matched).size).toBe(result.matched.length);
      expect(result.matched).toEqual([
        "M0L0",
        "M0L0C0",
        "M0L0C0L0",
        "M0L0C0L0R0",
      ]);
    });

    it("preserves order while deduplicating (first occurrence wins)", () => {
      const segments = [
        seg("A"),
        seg("B"),
        seg("C"),
        seg("A"), // duplicate of first
        seg("B"), // duplicate of second
        seg("D", { type: "route" }),
      ];

      const result = buildMatchResult(segments, makeCtx(), makeState());

      expect(result.matched).toEqual(["A", "B", "C", "D"]);
    });
  });

  describe("diff array", () => {
    it("diff matches segments for full match (unique)", () => {
      const segments = [seg("L0"), seg("L0R0", { type: "route" })];

      const result = buildMatchResult(segments, makeCtx(), makeState());

      expect(result.diff).toEqual(["L0", "L0R0"]);
      expect(new Set(result.diff).size).toBe(result.diff.length);
    });

    it("diff only includes segments with component for partial match", () => {
      const segments = [
        seg("L0"), // has component
        seg("L0C0", { component: null }), // null = skip
        seg("L0C0R0", { type: "route" }), // has component
        seg("L0D0", { type: "loader", component: null }), // loader = keep even if null
      ];

      const state = makeState({
        matchedIds: ["L0", "L0C0", "L0C0R0", "L0D0"],
      });

      const result = buildMatchResult(
        segments,
        makeCtx({ isFullMatch: false }),
        state,
      );

      // diff = filtered segments (component !== null OR type === "loader")
      expect(result.diff).toEqual(["L0", "L0C0R0", "L0D0"]);
    });
  });
});
