import { describe, it, expect, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => undefined,
}));

vi.mock("../../route-map-builder.js", () => ({
  getSearchSchema: () => undefined,
}));

import { createHandlerContext, createReverseFunction } from "../handler-context";

/**
 * Helper to build a minimal HandlerContext for testing search param behavior.
 * Only the searchParams/url fields are relevant; other arguments use defaults.
 */
function buildContext(searchParams: URLSearchParams) {
  const url = new URL("http://localhost/test");
  url.search = searchParams.toString();

  return createHandlerContext(
    {},            // params
    new Request(url.href),
    searchParams,
    "/test",
    url,
  );
}

describe("createHandlerContext", () => {
  describe("search param cleaning", () => {
    it("should preserve multi-valued query params", () => {
      const params = new URLSearchParams("tag=a&tag=b&tag=c");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect(result.getAll("tag")).toEqual(["a", "b", "c"]);
    });

    it("should strip _rsc-prefixed system params", () => {
      const params = new URLSearchParams("q=hello&_rscAction=nav&_rscKey=abc");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect(result.get("q")).toBe("hello");
      expect(result.has("_rscAction")).toBe(false);
      expect(result.has("_rscKey")).toBe(false);
    });

    it("should strip _rsc params while preserving multi-valued user params", () => {
      const params = new URLSearchParams("color=red&color=blue&_rscKey=x&size=L");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect(result.getAll("color")).toEqual(["red", "blue"]);
      expect(result.get("size")).toBe("L");
      expect(result.has("_rscKey")).toBe(false);
    });

    it("should produce empty searchParams when all params are system params", () => {
      const params = new URLSearchParams("_rscA=1&_rscB=2");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect([...result.entries()]).toEqual([]);
    });

    it("should pass through params unchanged when no system params exist", () => {
      const params = new URLSearchParams("page=2&sort=name");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect(result.get("page")).toBe("2");
      expect(result.get("sort")).toBe("name");
    });

    it("should reflect cleaned params in the context url", () => {
      const params = new URLSearchParams("q=test&_rscKey=abc");
      const ctx = buildContext(params);

      expect(ctx.url.searchParams.get("q")).toBe("test");
      expect(ctx.url.searchParams.has("_rscKey")).toBe(false);
    });
  });
});

describe("createReverseFunction", () => {
  // Simulates route map from include("/tenant/:tenantId", innerPatterns)
  // where innerPatterns has path("/", ...) and path("/settings", ...)
  const routeMap: Record<string, string> = {
    "tenant.index": "/tenant/:tenantId",
    "tenant.settings": "/tenant/:tenantId/settings",
    "tenant.user": "/tenant/:tenantId/users/:userId",
    "about": "/about",
  };

  describe("reverse with auto-filled params", () => {
    it("should auto-fill mount params from currentParams", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "acme" },
      );
      expect(reverse(".settings")).toBe("/tenant/acme/settings");
    });

    it("should auto-fill params for local route back to index", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.settings",
        { tenantId: "acme" },
      );
      expect(reverse(".index")).toBe("/tenant/acme");
    });

    it("should allow explicit params to override auto-filled params", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "acme" },
      );
      expect(reverse(".settings", { tenantId: "other" })).toBe(
        "/tenant/other/settings",
      );
    });

    it("should combine auto-filled mount params with explicit route params", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "acme" },
      );
      expect(reverse(".user", { userId: "u1" })).toBe(
        "/tenant/acme/users/u1",
      );
    });

    it("should use auto-filled params from a route with multiple params", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.user",
        { tenantId: "acme", userId: "u1" },
      );
      // Reversing back to settings only needs tenantId, userId is extra (ignored)
      expect(reverse(".settings")).toBe("/tenant/acme/settings");
    });

    it("should auto-fill params for global (non-dot-prefixed) routes", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "acme" },
      );
      expect(reverse("tenant.settings")).toBe("/tenant/acme/settings");
    });

    it("should work for routes without params when currentParams are present", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "acme" },
      );
      // Extra params from currentParams are ignored since /about has no :param
      expect(reverse("about")).toBe("/about");
    });

    it("should return raw pattern when no currentParams and no hrefParams", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index");
      // Without any params, substitution is skipped (existing behavior)
      expect(reverse(".settings")).toBe("/tenant/:tenantId/settings");
    });

    it("should throw when hrefParams provided but missing required param", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index");
      // Passing an empty object triggers substitution, which then throws
      expect(() => reverse(".settings", {})).toThrow(
        'Missing param "tenantId"',
      );
    });

    it("should throw for missing params not covered by currentParams", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "acme" },
      );
      // .user needs userId which isn't in currentParams
      expect(() => reverse(".user")).toThrow('Missing param "userId"');
    });

    it("should URL-encode auto-filled param values", () => {
      const reverse = createReverseFunction(
        routeMap,
        "tenant.index",
        { tenantId: "hello world" },
      );
      expect(reverse(".settings")).toBe("/tenant/hello%20world/settings");
    });
  });
});
