import { describe, it, expect } from "vitest";
import {
  shouldLookupIntercept,
  clientHasInterceptSegments,
} from "../intercept";

describe("shouldLookupIntercept", () => {
  describe("same route navigation", () => {
    it("should return false when navigating within same route", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: true,
        isAction: false,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0"]),
      });

      expect(result).toBe(false);
    });

    it("should return false even with intercept segments when same route", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: true,
        isAction: false,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0.@modal"]),
      });

      expect(result).toBe(false);
    });
  });

  describe("navigation (non-action)", () => {
    it("should return true for navigation without intercept segments", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: false,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0"]),
      });

      expect(result).toBe(true);
    });

    it("should return true for navigation with intercept segments", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: false,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0.@modal"]),
      });

      expect(result).toBe(true);
    });

    it("should return true when isSameRouteNavigation is null", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: null,
        isAction: false,
        clientSegmentSet: new Set(["M1L0C0"]),
      });

      expect(result).toBe(true);
    });
  });

  describe("action requests", () => {
    it("should return false for action without intercept segments", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: true,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0"]),
      });

      expect(result).toBe(false);
    });

    it("should return true for action with intercept segments", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: true,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0.@modal"]),
      });

      expect(result).toBe(true);
    });

    it("should return true for action with @sidebar intercept segment", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: true,
        clientSegmentSet: new Set(["M1L0C0", "M1L0C0L0.@sidebar"]),
      });

      expect(result).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle empty client segment set", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: false,
        clientSegmentSet: new Set(),
      });

      expect(result).toBe(true);
    });

    it("should handle empty client segment set for action", () => {
      const result = shouldLookupIntercept({
        isSameRouteNavigation: false,
        isAction: true,
        clientSegmentSet: new Set(),
      });

      expect(result).toBe(false);
    });
  });
});

describe("clientHasInterceptSegments", () => {
  it("should return true when client has @modal segment", () => {
    const result = clientHasInterceptSegments(
      new Set(["M1L0C0", "M1L0C0L0.@modal"])
    );

    expect(result).toBe(true);
  });

  it("should return true when client has @sidebar segment", () => {
    const result = clientHasInterceptSegments(
      new Set(["M1L0C0", "M1L0C0L0.@sidebar"])
    );

    expect(result).toBe(true);
  });

  it("should return false when no intercept segments", () => {
    const result = clientHasInterceptSegments(
      new Set(["M1L0C0", "M1L0C0L0", "M1L0C0L0R0"])
    );

    expect(result).toBe(false);
  });

  it("should return false for empty set", () => {
    const result = clientHasInterceptSegments(new Set());

    expect(result).toBe(false);
  });

  it("should detect intercept in middle of segment ID", () => {
    const result = clientHasInterceptSegments(
      new Set(["M1L0C0.@modal.L0"])
    );

    expect(result).toBe(true);
  });
});
