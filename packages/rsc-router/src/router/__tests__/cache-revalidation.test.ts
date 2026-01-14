import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyCacheRevalidation } from "../cache-revalidation";
import type { ResolvedSegment } from "../../types";

// Mock the revalidation module
vi.mock("../revalidation.js", () => ({
  evaluateRevalidation: vi.fn(),
}));

import { evaluateRevalidation } from "../revalidation.js";

const mockEvaluateRevalidation = vi.mocked(evaluateRevalidation);

describe("applyCacheRevalidation", () => {
  // Use plain objects instead of JSX for mocking
  const mockComponent = { type: "div", props: { children: "Component" } };
  const mockLoading = { type: "div", props: { children: "Loading" } };

  const createMockSegment = (
    id: string,
    options: Partial<ResolvedSegment> = {}
  ): ResolvedSegment => ({
    id,
    type: "layout",
    component: mockComponent as any,
    loading: mockLoading as any,
    params: {},
    routeKey: "test",
    ...options,
  });

  const createMockHandlerContext = () =>
    ({
      params: {},
      request: new Request("http://localhost/test"),
      searchParams: new URLSearchParams(),
      pathname: "/test",
      url: new URL("http://localhost/test"),
    }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("segment filtering", () => {
    it("should skip segments client does not have", async () => {
      const segment = createMockSegment("M1L0C0");
      const cachedSegments = [segment];

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["OTHER_SEGMENT"]),
        entryRevalidateMap: new Map(),
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      // Component should remain intact - client doesn't have this segment
      expect(segment.component).not.toBeNull();
    });

    it("should skip intercept segments", async () => {
      const segment = createMockSegment("M1L0C0.@modal", {
        namespace: "intercept:modal",
      });
      const cachedSegments = [segment];

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["M1L0C0.@modal"]),
        entryRevalidateMap: new Map(),
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      // Component should remain intact - intercept segments handled separately
      expect(segment.component).not.toBeNull();
    });
  });

  describe("no revalidation rules", () => {
    it("should set component to null when no revalidation rules", async () => {
      const segment = createMockSegment("M1L0C0");
      const cachedSegments = [segment];

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["M1L0C0"]),
        entryRevalidateMap: new Map(), // No rules
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      expect(segment.component).toBeNull();
      expect(segment.loading).toBeUndefined();
    });

    it("should set component to null when entry has empty revalidate array", async () => {
      const segment = createMockSegment("M1L0C0");
      const cachedSegments = [segment];

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["M1L0C0"]),
        entryRevalidateMap: new Map([
          ["M1L0C0", { entry: {} as any, revalidate: [] }],
        ]),
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      expect(segment.component).toBeNull();
      expect(segment.loading).toBeUndefined();
    });
  });

  describe("with revalidation rules", () => {
    it("should keep component when revalidation returns true", async () => {
      mockEvaluateRevalidation.mockResolvedValue(true);

      const segment = createMockSegment("M1L0C0");
      const originalComponent = segment.component;
      const cachedSegments = [segment];

      const mockRevalidateFn = vi.fn();

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["M1L0C0"]),
        entryRevalidateMap: new Map([
          ["M1L0C0", { entry: {} as any, revalidate: [mockRevalidateFn] }],
        ]),
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      expect(segment.component).toBe(originalComponent);
      expect(mockEvaluateRevalidation).toHaveBeenCalled();
    });

    it("should set component to null when revalidation returns false", async () => {
      mockEvaluateRevalidation.mockResolvedValue(false);

      const segment = createMockSegment("M1L0C0");
      const cachedSegments = [segment];

      const mockRevalidateFn = vi.fn();

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["M1L0C0"]),
        entryRevalidateMap: new Map([
          ["M1L0C0", { entry: {} as any, revalidate: [mockRevalidateFn] }],
        ]),
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      expect(segment.component).toBeNull();
      expect(segment.loading).toBeUndefined();
    });
  });

  describe("multiple segments", () => {
    it("should process multiple segments independently", async () => {
      mockEvaluateRevalidation
        .mockResolvedValueOnce(true) // First segment needs revalidation
        .mockResolvedValueOnce(false); // Second segment doesn't

      const segment1 = createMockSegment("M1L0C0");
      const segment2 = createMockSegment("M1L0C0L0");
      const originalComponent1 = segment1.component;
      const cachedSegments = [segment1, segment2];

      const mockRevalidateFn = vi.fn();

      await applyCacheRevalidation({
        cachedSegments,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0"]),
        entryRevalidateMap: new Map([
          ["M1L0C0", { entry: {} as any, revalidate: [mockRevalidateFn] }],
          ["M1L0C0L0", { entry: {} as any, revalidate: [mockRevalidateFn] }],
        ]),
        prevParams: {},
        request: new Request("http://localhost/test"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
        handlerContext: createMockHandlerContext(),
      });

      expect(segment1.component).toBe(originalComponent1); // Kept
      expect(segment2.component).toBeNull(); // Cleared
    });
  });
});
