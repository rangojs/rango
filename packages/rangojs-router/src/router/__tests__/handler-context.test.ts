import { describe, it, expect, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => undefined,
}));

vi.mock("../../route-map-builder.js", () => ({
  getSearchSchema: () => undefined,
}));

import { createHandlerContext } from "../handler-context";

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
