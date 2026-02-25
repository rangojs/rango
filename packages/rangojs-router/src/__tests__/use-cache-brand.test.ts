import { describe, it, expect } from "vitest";
import { CACHED_FN_SYMBOL, isCachedFunction } from "../cache/taint";
import { createRouteHelpers } from "../route-definition";
import { Static } from "../static-handler";
import { Prerender } from "../prerender";

describe("use-cache branding", () => {
  describe("isCachedFunction", () => {
    it("returns false for plain functions", () => {
      const fn = () => {};
      expect(isCachedFunction(fn)).toBe(false);
    });

    it("returns false for async functions", () => {
      const fn = async () => {};
      expect(isCachedFunction(fn)).toBe(false);
    });

    it("returns false for non-function values", () => {
      expect(isCachedFunction(null)).toBe(false);
      expect(isCachedFunction(undefined)).toBe(false);
      expect(isCachedFunction("string")).toBe(false);
      expect(isCachedFunction(42)).toBe(false);
      expect(isCachedFunction({})).toBe(false);
      expect(isCachedFunction([])).toBe(false);
    });

    it("returns true for functions branded with CACHED_FN_SYMBOL", () => {
      const fn = async () => {};
      (fn as any)[CACHED_FN_SYMBOL] = true;
      expect(isCachedFunction(fn)).toBe(true);
    });

    it("returns false for objects with CACHED_FN_SYMBOL (non-function)", () => {
      const obj = { [CACHED_FN_SYMBOL]: true };
      expect(isCachedFunction(obj)).toBe(false);
    });
  });

  describe("middleware() DSL guard", () => {
    it("throws when a cached function is passed to middleware()", () => {
      const helpers = createRouteHelpers();
      const cachedFn = async () => {};
      (cachedFn as any)[CACHED_FN_SYMBOL] = true;

      expect(() => {
        helpers.middleware(cachedFn as any);
      }).toThrow(/cannot be used as middleware/);
    });

    it("throws when multiple fns include a cached function", () => {
      const helpers = createRouteHelpers();
      const normalFn = async (_ctx: any, next: any) => { await next(); };
      const cachedFn = async () => {};
      (cachedFn as any)[CACHED_FN_SYMBOL] = true;

      expect(() => {
        helpers.middleware(normalFn as any, cachedFn as any);
      }).toThrow(/cannot be used as middleware/);
    });

    it("does not throw cached function error for normal middleware", () => {
      const helpers = createRouteHelpers();
      const normalFn = async (_ctx: any, next: any) => { await next(); };

      // Outside route context, middleware() throws a context error — but
      // critically NOT the "cannot be used as middleware" error. This proves
      // the guard only fires for cached functions.
      expect(() => {
        helpers.middleware(normalFn as any);
      }).not.toThrow(/cannot be used as middleware/);
    });
  });

  describe("Static() guard", () => {
    it("throws when a cached function is passed as handler", () => {
      const cachedFn = async () => null;
      (cachedFn as any)[CACHED_FN_SYMBOL] = true;

      expect(() => {
        Static(cachedFn as any, "__test-id__");
      }).toThrow(/cannot be used as a Static/);
    });

    it("does not throw for a normal handler", () => {
      const normalFn = async () => null;

      // Should not throw the cached function error
      expect(() => {
        Static(normalFn as any, "__test-id__");
      }).not.toThrow(/cannot be used as a Static/);
    });
  });

  describe("Prerender() guard", () => {
    it("throws when a cached function is passed as handler (static)", () => {
      const cachedFn = async () => null;
      (cachedFn as any)[CACHED_FN_SYMBOL] = true;

      expect(() => {
        Prerender(cachedFn as any, {}, "__test-id__");
      }).toThrow(/cannot be used as a Prerender\(\) handler/);
    });

    it("throws when a cached function is passed as handler (dynamic)", () => {
      const normalGetParams = async () => [{ slug: "a" }];
      const cachedHandler = async () => null;
      (cachedHandler as any)[CACHED_FN_SYMBOL] = true;

      expect(() => {
        Prerender(normalGetParams as any, cachedHandler as any, "__test-id__");
      }).toThrow(/cannot be used as a Prerender\(\) handler/);
    });

    it("throws when a cached function is passed as getParams", () => {
      const cachedGetParams = async () => [{ slug: "a" }];
      (cachedGetParams as any)[CACHED_FN_SYMBOL] = true;
      const normalHandler = async () => null;

      expect(() => {
        Prerender(cachedGetParams as any, normalHandler as any, "__test-id__");
      }).toThrow(/cannot be used as Prerender\(\) getParams/);
    });

    it("does not throw for normal handler", () => {
      const normalFn = async () => null;

      expect(() => {
        Prerender(normalFn as any, {}, "__test-id__");
      }).not.toThrow(/cannot be used as a Prerender/);
    });
  });
});
