import { describe, it, expect, vi } from "vitest";
import { evaluateRevalidation } from "../revalidation";
import type { ResolvedSegment, HandlerContext } from "../../types";

// Helper to create a minimal segment for testing
const createSegment = (
  overrides: Partial<ResolvedSegment> = {}
): ResolvedSegment => ({
  id: "test-segment",
  namespace: "",
  type: "route",
  index: 0,
  component: null,
  params: {},
  ...overrides,
});

// Helper to create a minimal handler context
const createContext = (): HandlerContext<any, any> => ({
  params: {},
  request: new Request("http://localhost/"),
  searchParams: new URLSearchParams(),
  pathname: "/",
  url: new URL("http://localhost/"),
  env: {},
  var: {},
  get: () => undefined,
  set: () => {},
  _originalRequest: new Request("http://localhost/"),
  use: () => {
    throw new Error("not implemented");
  },
});

describe("evaluateRevalidation", () => {
  describe("default behavior without custom revalidations", () => {
    it("should revalidate route segment on POST (action)", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/", { method: "POST" }),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
    });

    it("should revalidate belongsToRoute segment on POST", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout", belongsToRoute: true }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/", { method: "POST" }),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
    });

    it("should NOT revalidate parent layout on POST", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout", belongsToRoute: false }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/", { method: "POST" }),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(false);
    });

    it("should revalidate route segment on GET when params change", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "new-slug" } }),
        prevParams: { slug: "old-slug" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/old-slug"),
        nextUrl: new URL("http://localhost/new-slug"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
    });

    it("should NOT revalidate route segment on GET when params unchanged", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "same" } }),
        prevParams: { slug: "same" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/same"),
        nextUrl: new URL("http://localhost/same"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(false);
    });

    it("should NOT revalidate layout on GET (conservative default)", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout", params: { slug: "new" } }),
        prevParams: { slug: "old" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/old"),
        nextUrl: new URL("http://localhost/new"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(false);
    });
  });

  describe("custom revalidation functions", () => {
    it("should short-circuit on hard decision (boolean true)", async () => {
      const revalidateFn = vi.fn().mockReturnValue(true);

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "always", fn: revalidateFn }],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
      expect(revalidateFn).toHaveBeenCalledTimes(1);
    });

    it("should short-circuit on hard decision (boolean false)", async () => {
      const revalidateFn = vi.fn().mockReturnValue(false);

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "new" } }),
        prevParams: { slug: "old" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/old"),
        nextUrl: new URL("http://localhost/new"),
        revalidations: [{ name: "never", fn: revalidateFn }],
        routeKey: "test",
        context: createContext(),
      });

      // Even though params changed, hard decision overrides
      expect(result).toBe(false);
    });

    it("should continue chain on soft decision", async () => {
      const firstFn = vi.fn().mockReturnValue({ defaultShouldRevalidate: true });
      const secondFn = vi.fn().mockReturnValue({ defaultShouldRevalidate: false });

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [
          { name: "first", fn: firstFn },
          { name: "second", fn: secondFn },
        ],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(false);
      expect(firstFn).toHaveBeenCalledTimes(1);
      expect(secondFn).toHaveBeenCalledTimes(1);
    });

    it("should stop chain when hard decision encountered", async () => {
      const firstFn = vi.fn().mockReturnValue(true); // Hard decision
      const secondFn = vi.fn();

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [
          { name: "first", fn: firstFn },
          { name: "second", fn: secondFn },
        ],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
      expect(firstFn).toHaveBeenCalledTimes(1);
      expect(secondFn).not.toHaveBeenCalled();
    });

    it("should treat null/undefined as defer to default", async () => {
      const deferFn = vi.fn().mockReturnValue(null);

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "new" } }),
        prevParams: { slug: "old" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/old"),
        nextUrl: new URL("http://localhost/new"),
        revalidations: [{ name: "defer", fn: deferFn }],
        routeKey: "test",
        context: createContext(),
      });

      // Defers to default (params changed = revalidate)
      expect(result).toBe(true);
    });
  });

  describe("action context", () => {
    it("should pass actionId to revalidation function", async () => {
      const revalidateFn = vi.fn().mockReturnValue(null);

      await evaluateRevalidation({
        segment: createSegment({ type: "layout" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/", { method: "POST" }),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "check", fn: revalidateFn }],
        routeKey: "test",
        context: createContext(),
        actionContext: {
          actionId: "src/actions.ts#addToCart",
          actionUrl: new URL("http://localhost/shop"),
        },
      });

      expect(revalidateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "src/actions.ts#addToCart",
          method: "POST",
        })
      );
    });

    it("should allow revalidation based on actionId pattern", async () => {
      const cartRevalidateFn = vi.fn(({ actionId }) => {
        return actionId?.includes("Cart") ?? false;
      });

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "loader", loaderName: "cart" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/", { method: "POST" }),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "cartRevalidate", fn: cartRevalidateFn }],
        routeKey: "test",
        context: createContext(),
        actionContext: {
          actionId: "src/actions.ts#addToCart",
          actionUrl: new URL("http://localhost/shop"),
        },
      });

      expect(result).toBe(true);
    });

    it("should NOT revalidate when actionId does not match pattern", async () => {
      const cartRevalidateFn = vi.fn(({ actionId }) => {
        return actionId?.includes("Cart") ?? false;
      });

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "loader", loaderName: "cart" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/", { method: "POST" }),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "cartRevalidate", fn: cartRevalidateFn }],
        routeKey: "test",
        context: createContext(),
        actionContext: {
          actionId: "src/actions.ts#updateProfile",
          actionUrl: new URL("http://localhost/account"),
        },
      });

      expect(result).toBe(false);
    });
  });

  describe("stale cache revalidation", () => {
    it("should pass stale flag to revalidation function", async () => {
      const revalidateFn = vi.fn().mockReturnValue(null);

      await evaluateRevalidation({
        segment: createSegment({ type: "route" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "check", fn: revalidateFn }],
        routeKey: "test",
        context: createContext(),
        stale: true,
      });

      expect(revalidateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          stale: true,
        })
      );
    });

    it("should revalidate when stale flag triggers custom function", async () => {
      const staleRevalidateFn = vi.fn(({ stale }) => stale === true);

      const result = await evaluateRevalidation({
        segment: createSegment({ type: "layout" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "staleCheck", fn: staleRevalidateFn }],
        routeKey: "test",
        context: createContext(),
        stale: true,
      });

      expect(result).toBe(true);
    });
  });

  describe("segment metadata", () => {
    it("should pass segment type to revalidation function", async () => {
      const revalidateFn = vi.fn().mockReturnValue(null);

      await evaluateRevalidation({
        segment: createSegment({ type: "parallel", slot: "@sidebar" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "check", fn: revalidateFn }],
        routeKey: "test",
        context: createContext(),
      });

      expect(revalidateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          segmentType: "parallel",
          slotName: "@sidebar",
        })
      );
    });

    it("should pass layout name to revalidation function", async () => {
      const revalidateFn = vi.fn().mockReturnValue(null);

      await evaluateRevalidation({
        segment: createSegment({ type: "layout", layoutName: "shop" }),
        prevParams: {},
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/"),
        nextUrl: new URL("http://localhost/"),
        revalidations: [{ name: "check", fn: revalidateFn }],
        routeKey: "test",
        context: createContext(),
      });

      expect(revalidateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          segmentType: "layout",
          layoutName: "shop",
        })
      );
    });
  });

  describe("param change detection", () => {
    it("should detect param addition as change", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "test", id: "123" } }),
        prevParams: { slug: "test" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/test"),
        nextUrl: new URL("http://localhost/test/123"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
    });

    it("should detect param removal as change", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "test" } }),
        prevParams: { slug: "test", id: "123" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/test/123"),
        nextUrl: new URL("http://localhost/test"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
    });

    it("should detect param value change", async () => {
      const result = await evaluateRevalidation({
        segment: createSegment({ type: "route", params: { slug: "new-product" } }),
        prevParams: { slug: "old-product" },
        getPrevSegment: null,
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/old-product"),
        nextUrl: new URL("http://localhost/new-product"),
        revalidations: [],
        routeKey: "test",
        context: createContext(),
      });

      expect(result).toBe(true);
    });
  });
});
