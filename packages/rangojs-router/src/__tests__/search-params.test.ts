/**
 * Tests for search-params module: runtime parser/serializer and type-level tests.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  parseSearchParams,
  serializeSearchParams,
  type SearchSchema,
  type ResolveSearchSchema,
} from "../search-params.js";
import type { HandlerContext } from "../types.js";
import { urls } from "../urls.js";

// ============================================================================
// Runtime tests: parseSearchParams
// ============================================================================

describe("parseSearchParams", () => {
  it("should parse required string param", () => {
    const sp = new URLSearchParams("q=react");
    const result = parseSearchParams(sp, { q: "string" });
    expect(result).toEqual({ q: "react" });
  });

  it("should parse required number param", () => {
    const sp = new URLSearchParams("page=2");
    const result = parseSearchParams(sp, { page: "number" });
    expect(result).toEqual({ page: 2 });
  });

  it("should parse required boolean param", () => {
    const sp = new URLSearchParams("active=true");
    const result = parseSearchParams(sp, { active: "boolean" });
    expect(result).toEqual({ active: true });
  });

  it("should parse boolean false values", () => {
    expect(parseSearchParams(new URLSearchParams("x=false"), { x: "boolean" })).toEqual({ x: false });
    expect(parseSearchParams(new URLSearchParams("x=0"), { x: "boolean" })).toEqual({ x: false });
    expect(parseSearchParams(new URLSearchParams("x="), { x: "boolean" })).toEqual({ x: false });
  });

  it("should use zero values for missing required params", () => {
    const sp = new URLSearchParams("");
    const result = parseSearchParams(sp, {
      q: "string",
      page: "number",
      active: "boolean",
    });
    expect(result).toEqual({ q: "", page: 0, active: false });
  });

  it("should omit missing optional params", () => {
    const sp = new URLSearchParams("q=react");
    const result = parseSearchParams(sp, {
      q: "string",
      page: "number?",
      sort: "string?",
    });
    expect(result).toEqual({ q: "react" });
    expect("page" in result).toBe(false);
    expect("sort" in result).toBe(false);
  });

  it("should parse present optional params", () => {
    const sp = new URLSearchParams("q=react&page=3&sort=stars");
    const result = parseSearchParams(sp, {
      q: "string",
      page: "number?",
      sort: "string?",
    });
    expect(result).toEqual({ q: "react", page: 3, sort: "stars" });
  });

  it("should handle NaN for number params", () => {
    const sp = new URLSearchParams("page=abc");
    const requiredResult = parseSearchParams(sp, { page: "number" });
    expect(requiredResult).toEqual({ page: 0 });

    const optionalResult = parseSearchParams(sp, { page: "number?" });
    expect("page" in optionalResult).toBe(false);
  });

  it("should handle optional boolean", () => {
    const sp = new URLSearchParams("show=1");
    const result = parseSearchParams(sp, { show: "boolean?" });
    expect(result).toEqual({ show: true });
  });
});

// ============================================================================
// Runtime tests: serializeSearchParams
// ============================================================================

describe("serializeSearchParams", () => {
  it("should serialize string values", () => {
    expect(serializeSearchParams({ q: "react" })).toBe("q=react");
  });

  it("should serialize number values", () => {
    expect(serializeSearchParams({ page: 2 })).toBe("page=2");
  });

  it("should serialize boolean values", () => {
    expect(serializeSearchParams({ active: true })).toBe("active=true");
  });

  it("should skip undefined and null values", () => {
    expect(serializeSearchParams({ q: "react", page: undefined, sort: null })).toBe("q=react");
  });

  it("should encode special characters", () => {
    expect(serializeSearchParams({ q: "hello world" })).toBe("q=hello%20world");
  });

  it("should handle multiple params", () => {
    const result = serializeSearchParams({ q: "react", page: 2, sort: "stars" });
    expect(result).toBe("q=react&page=2&sort=stars");
  });

  it("should return empty string for empty object", () => {
    expect(serializeSearchParams({})).toBe("");
  });
});

// ============================================================================
// Type-level tests: ResolveSearchSchema
// ============================================================================

describe("ResolveSearchSchema", () => {
  it("should resolve required string", () => {
    type S = ResolveSearchSchema<{ q: "string" }>;
    expectTypeOf<S>().toEqualTypeOf<{ q: string }>();
  });

  it("should resolve required number", () => {
    type S = ResolveSearchSchema<{ page: "number" }>;
    expectTypeOf<S>().toEqualTypeOf<{ page: number }>();
  });

  it("should resolve required boolean", () => {
    type S = ResolveSearchSchema<{ active: "boolean" }>;
    expectTypeOf<S>().toEqualTypeOf<{ active: boolean }>();
  });

  it("should resolve optional string", () => {
    type S = ResolveSearchSchema<{ sort: "string?" }>;
    expectTypeOf<S>().toEqualTypeOf<{ sort?: string }>();
  });

  it("should resolve optional number", () => {
    type S = ResolveSearchSchema<{ page: "number?" }>;
    expectTypeOf<S>().toEqualTypeOf<{ page?: number }>();
  });

  it("should resolve optional boolean", () => {
    type S = ResolveSearchSchema<{ show: "boolean?" }>;
    expectTypeOf<S>().toEqualTypeOf<{ show?: boolean }>();
  });

  it("should resolve mixed required and optional", () => {
    type S = ResolveSearchSchema<{ q: "string"; page: "number?"; sort: "string?" }>;
    expectTypeOf<S>().toEqualTypeOf<{ q: string; page?: number; sort?: string }>();
  });

  it("should resolve empty schema to empty object", () => {
    type S = ResolveSearchSchema<{}>;
    expectTypeOf<S>().toEqualTypeOf<{}>();
  });
});

// ============================================================================
// Type-level tests: HandlerContext.searchParams conditional type
// ============================================================================

describe("HandlerContext.searchParams type", () => {
  it("should be URLSearchParams when no search schema", () => {
    type Ctx = HandlerContext<{}, any>;
    expectTypeOf<Ctx["searchParams"]>().toEqualTypeOf<URLSearchParams>();
  });

  it("should be URLSearchParams with empty search schema", () => {
    type Ctx = HandlerContext<{}, any, {}>;
    expectTypeOf<Ctx["searchParams"]>().toEqualTypeOf<URLSearchParams>();
  });

  it("should be typed object when search schema is provided", () => {
    type Ctx = HandlerContext<{}, any, { q: "string"; page: "number?" }>;
    expectTypeOf<Ctx["searchParams"]>().toEqualTypeOf<{ q: string; page?: number }>();
  });
});

// ============================================================================
// Type-level tests: path() with search schema -> TypedRouteItem propagation
// ============================================================================

describe("path() search schema type inference", () => {
  const patterns = urls(({ path }) => [
    path("/search", (ctx) => {
      // Verify ctx.searchParams is typed
      const sp = ctx.searchParams;
      expectTypeOf(sp).toEqualTypeOf<{ q: string; page?: number }>();
      return null;
    }, { name: "search", search: { q: "string", page: "number?" } }),

    path("/about", () => null, { name: "about" }),
  ]);

  it("should infer search schema on route with search option", () => {
    type Routes = NonNullable<(typeof patterns)["_routes"]>;
    // The "search" route should have { path, search } value
    type SearchRoute = Routes["search"];
    expectTypeOf<SearchRoute>().toMatchTypeOf<{
      readonly path: "/search";
      readonly search: { q: "string"; page: "number?" };
    }>();
  });

  it("should keep plain string for route without search", () => {
    type Routes = NonNullable<(typeof patterns)["_routes"]>;
    type AboutRoute = Routes["about"];
    expectTypeOf<AboutRoute>().toEqualTypeOf<"/about">();
  });
});

// ============================================================================
// Static parser tests: extractRoutesFromSource with search
// ============================================================================

import { extractRoutesFromSource } from "../build/generate-route-types.js";

describe("extractRoutesFromSource with search", () => {
  it("should extract search schema from path options", () => {
    const code = `
      urls(({ path }) => [
        path("/search", SearchPage, { name: "search", search: { q: "string", page: "number?" } }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "search", pattern: "/search", search: { q: "string", page: "number?" } },
    ]);
  });

  it("should return no search when not specified", () => {
    const code = `
      urls(({ path }) => [
        path("/about", AboutPage, { name: "about" }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "about", pattern: "/about" },
    ]);
  });

  it("should handle search with quoted keys", () => {
    const code = `
      urls(({ path }) => [
        path("/items", ItemsPage, { name: "items", search: { "q": "string", "page": "number?" } }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "items", pattern: "/items", search: { q: "string", page: "number?" } },
    ]);
  });

  it("should extract routes from typed path helpers like path.md", () => {
    const code = `
      urls(({ path }) => [
        path.md("/docs", () => "# docs", { name: "docs.md" }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "docs.md", pattern: "/docs" },
    ]);
  });
});

// ============================================================================
// Static parser tests: generateRouteTypesSource with search
// ============================================================================

import { generateRouteTypesSource } from "../build/generate-route-types.js";

describe("generateRouteTypesSource with search schemas", () => {
  it("should generate { path, search } entries for routes with search", () => {
    const manifest = { search: "/search", about: "/about" };
    const searchSchemas = { search: { q: "string", page: "number?" } };
    const source = generateRouteTypesSource(manifest, searchSchemas);
    expect(source).toContain('about: "/about"');
    expect(source).toContain('search: { path: "/search", search: { q: "string", page: "number?" } }');
  });

  it("should generate plain strings when no search schemas", () => {
    const manifest = { about: "/about", home: "/" };
    const source = generateRouteTypesSource(manifest);
    expect(source).toContain('about: "/about"');
    expect(source).toContain('home: "/"');
    expect(source).not.toContain("readonly path");
  });
});
