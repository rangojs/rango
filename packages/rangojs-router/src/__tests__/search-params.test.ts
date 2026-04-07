/**
 * Tests for search-params module: runtime parser/serializer and type-level tests.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  parseSearchParams,
  serializeSearchParams,
  type SearchSchema,
  type ResolveSearchSchema,
  type RouteParams,
  type RouteSearchParams,
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
    expect(
      parseSearchParams(new URLSearchParams("x=false"), { x: "boolean" }),
    ).toEqual({ x: false });
    expect(
      parseSearchParams(new URLSearchParams("x=0"), { x: "boolean" }),
    ).toEqual({ x: false });
    expect(
      parseSearchParams(new URLSearchParams("x="), { x: "boolean" }),
    ).toEqual({ x: false });
  });

  it("should omit missing required params (undefined)", () => {
    const sp = new URLSearchParams("");
    const result = parseSearchParams(sp, {
      q: "string",
      page: "number",
      active: "boolean",
    });
    expect(result).toEqual({});
    expect("q" in result).toBe(false);
    expect("page" in result).toBe(false);
    expect("active" in result).toBe(false);
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
    expect("page" in requiredResult).toBe(false);

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
    expect(
      serializeSearchParams({ q: "react", page: undefined, sort: null }),
    ).toBe("q=react");
  });

  it("should encode special characters", () => {
    expect(serializeSearchParams({ q: "hello world" })).toBe("q=hello%20world");
  });

  it("should handle multiple params", () => {
    const result = serializeSearchParams({
      q: "react",
      page: 2,
      sort: "stars",
    });
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
  it("should resolve required string as string | undefined", () => {
    type S = ResolveSearchSchema<{ q: "string" }>;
    expectTypeOf<S>().toEqualTypeOf<{ q: string | undefined }>();
  });

  it("should resolve required number as number | undefined", () => {
    type S = ResolveSearchSchema<{ page: "number" }>;
    expectTypeOf<S>().toEqualTypeOf<{ page: number | undefined }>();
  });

  it("should resolve required boolean as boolean | undefined", () => {
    type S = ResolveSearchSchema<{ active: "boolean" }>;
    expectTypeOf<S>().toEqualTypeOf<{ active: boolean | undefined }>();
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
    type S = ResolveSearchSchema<{
      q: "string";
      page: "number?";
      sort: "string?";
    }>;
    expectTypeOf<S>().toEqualTypeOf<{
      q: string | undefined;
      page?: number;
      sort?: string;
    }>();
  });

  it("should resolve empty schema to empty object", () => {
    type S = ResolveSearchSchema<{}>;
    expectTypeOf<S>().toEqualTypeOf<{}>();
  });
});

// ============================================================================
// Type-level tests: HandlerContext.searchParams conditional type
// ============================================================================

describe("HandlerContext.searchParams and search types", () => {
  it("searchParams should always be URLSearchParams", () => {
    type Ctx = HandlerContext<{}, any>;
    expectTypeOf<Ctx["searchParams"]>().toEqualTypeOf<URLSearchParams>();
  });

  it("searchParams should be URLSearchParams even with search schema", () => {
    type Ctx = HandlerContext<{}, any, { q: "string"; page: "number?" }>;
    expectTypeOf<Ctx["searchParams"]>().toEqualTypeOf<URLSearchParams>();
  });

  it("search should be empty object when no search schema", () => {
    type Ctx = HandlerContext<{}, any>;
    expectTypeOf<Ctx["search"]>().toEqualTypeOf<{}>();
  });

  it("search should be typed object when search schema is provided", () => {
    type Ctx = HandlerContext<{}, any, { q: "string"; page: "number?" }>;
    expectTypeOf<Ctx["search"]>().toEqualTypeOf<{
      q: string | undefined;
      page?: number;
    }>();
  });
});

// ============================================================================
// Type-level tests: path() with search schema -> TypedRouteItem propagation
// ============================================================================

describe("path() search schema type inference", () => {
  const patterns = urls(({ path }) => [
    path(
      "/search",
      (ctx) => {
        // searchParams is always URLSearchParams
        expectTypeOf(ctx.searchParams).toEqualTypeOf<URLSearchParams>();
        // search is the typed parsed object
        expectTypeOf(ctx.search).toEqualTypeOf<{
          q: string | undefined;
          page?: number;
        }>();
        return null;
      },
      { name: "search", search: { q: "string", page: "number?" } },
    ),

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
      {
        name: "search",
        pattern: "/search",
        search: { q: "string", page: "number?" },
      },
    ]);
  });

  it("should return no search when not specified", () => {
    const code = `
      urls(({ path }) => [
        path("/about", AboutPage, { name: "about" }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([{ name: "about", pattern: "/about" }]);
  });

  it("should handle search with quoted keys", () => {
    const code = `
      urls(({ path }) => [
        path("/items", ItemsPage, { name: "items", search: { "q": "string", "page": "number?" } }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      {
        name: "items",
        pattern: "/items",
        search: { q: "string", page: "number?" },
      },
    ]);
  });

  it("should extract routes from typed path helpers like path.md", () => {
    const code = `
      urls(({ path }) => [
        path.md("/docs", () => "# docs", { name: "docs.md" }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([{ name: "docs.md", pattern: "/docs" }]);
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
    expect(source).toContain(
      'search: { path: "/search", search: { q: "string", page: "number?" } }',
    );
  });

  it("should generate plain strings when no search schemas", () => {
    const manifest = { about: "/about", home: "/" };
    const source = generateRouteTypesSource(manifest);
    expect(source).toContain('about: "/about"');
    expect(source).toContain('home: "/"');
    expect(source).not.toContain("readonly path");
  });
});

// ============================================================================
// Type-level tests: RouteParams (with explicit route map)
// ============================================================================

// Test route map with mixed plain strings and { path, search } entries
type TestRouteMap = {
  readonly home: "/";
  readonly about: "/about";
  readonly blogPost: "/blog/:slug";
  readonly userProfile: "/user/:userId/profile";
  readonly userSettings: "/user/:userId/settings/:tab?";
  readonly localized: "/:locale(en|gb)/blog";
  readonly localizedOptional: "/:locale(en|gb)?/blog/:slug";
  readonly search: {
    readonly path: "/search";
    readonly search: { q: "string"; page: "number?" };
  };
  readonly products: {
    readonly path: "/products/:category";
    readonly search: { sort: "string?"; page: "number?" };
  };
};

describe("RouteParams (explicit route map)", () => {
  it("should return empty object for static route", () => {
    type Params = RouteParams<"home", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });

  it("should extract single param", () => {
    type Params = RouteParams<"blogPost", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should extract multiple params", () => {
    type Params = RouteParams<"userProfile", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{ userId: string }>();
  });

  it("should extract mixed required and optional params", () => {
    type Params = RouteParams<"userSettings", TestRouteMap>;
    expectTypeOf<Params>().toMatchTypeOf<{ userId: string; tab?: string }>();
    expectTypeOf<{ userId: string; tab?: string }>().toMatchTypeOf<Params>();
  });

  it("should extract params from { path, search } entry", () => {
    type Params = RouteParams<"products", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{ category: string }>();
  });

  it("should return empty object for { path, search } entry with no params", () => {
    type Params = RouteParams<"search", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });

  it("should return empty object for unknown route name", () => {
    type Params = RouteParams<"nonexistent", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });

  it("should extract constrained param as literal union", () => {
    type Params = RouteParams<"localized", TestRouteMap>;
    expectTypeOf<Params>().toEqualTypeOf<{ locale: "en" | "gb" }>();
  });

  it("should extract optional constrained param as optional literal union", () => {
    type Params = RouteParams<"localizedOptional", TestRouteMap>;
    expectTypeOf<Params>().toMatchTypeOf<{
      locale?: "en" | "gb";
      slug: string;
    }>();
    expectTypeOf<{
      locale?: "en" | "gb";
      slug: string;
    }>().toMatchTypeOf<Params>();
  });
});

// ============================================================================
// Type-level tests: RouteSearchParams (with explicit route map)
// ============================================================================

describe("RouteSearchParams (explicit route map)", () => {
  it("should return empty object for route without search schema", () => {
    type Search = RouteSearchParams<"home", TestRouteMap>;
    expectTypeOf<Search>().toEqualTypeOf<{}>();
  });

  it("should return empty object for route with plain string pattern", () => {
    type Search = RouteSearchParams<"blogPost", TestRouteMap>;
    expectTypeOf<Search>().toEqualTypeOf<{}>();
  });

  it("should resolve search schema with required and optional params", () => {
    type Search = RouteSearchParams<"search", TestRouteMap>;
    expectTypeOf<Search>().toEqualTypeOf<{
      q: string | undefined;
      page?: number;
    }>();
  });

  it("should resolve search schema on route with path params", () => {
    type Search = RouteSearchParams<"products", TestRouteMap>;
    expectTypeOf<Search>().toEqualTypeOf<{ sort?: string; page?: number }>();
  });

  it("should return empty object for unknown route name", () => {
    type Search = RouteSearchParams<"nonexistent", TestRouteMap>;
    expectTypeOf<Search>().toEqualTypeOf<{}>();
  });
});

// ============================================================================
// Type-level tests: RouteParams + RouteSearchParams with urls() patterns
// ============================================================================

describe("RouteParams + RouteSearchParams from urls() patterns", () => {
  const testPatterns = urls(({ path }) => [
    path("/", () => null, { name: "home" }),
    path("/blog/:slug", () => null, { name: "blogPost" }),
    path("/search", () => null, {
      name: "search",
      search: { q: "string", page: "number?", sort: "string?" },
    }),
    path("/items/:category", () => null, {
      name: "items",
      search: { page: "number?", limit: "number?" },
    }),
  ]);

  type Routes = NonNullable<(typeof testPatterns)["_routes"]>;

  it("should extract params from urls()-defined routes", () => {
    type Params = RouteParams<"blogPost", Routes>;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should return empty params for static urls()-defined route", () => {
    type Params = RouteParams<"home", Routes>;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });

  it("should extract params from route with both path params and search", () => {
    type Params = RouteParams<"items", Routes>;
    expectTypeOf<Params>().toEqualTypeOf<{ category: string }>();
  });

  it("should resolve search params from urls()-defined route", () => {
    type Search = RouteSearchParams<"search", Routes>;
    expectTypeOf<Search>().toEqualTypeOf<{
      q: string | undefined;
      page?: number;
      sort?: string;
    }>();
  });

  it("should resolve search params on route with path params", () => {
    type Search = RouteSearchParams<"items", Routes>;
    expectTypeOf<Search>().toEqualTypeOf<{ page?: number; limit?: number }>();
  });

  it("should return empty search for route without search schema", () => {
    type Search = RouteSearchParams<"blogPost", Routes>;
    expectTypeOf<Search>().toEqualTypeOf<{}>();
  });
});
