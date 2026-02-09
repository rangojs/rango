/**
 * Type-level tests for href type system
 *
 * These tests verify that the type system works correctly at compile time.
 * They use expectTypeOf() from vitest which performs compile-time type checking.
 */

import { describe, it, expectTypeOf } from "vitest";
import type {
  HrefFunction,
  ScopedHrefFunction,
  ParamsFor,
  PrefixedRoutes,
  PrefixRoutePatterns,
  PrefixRouteKeys,
} from "../href.js";
import type { ExtractParams } from "../types.js";
import type { HandlerContext, GenericParams, DefaultEnv } from "../types.js";

// Test route definitions
type TestRoutes = {
  "index": "/";
  "about": "/about";
  "blog.index": "/blog";
  "blog.post": "/blog/:slug";
  "shop.cart": "/shop/cart";
  "shop.product": "/shop/product/:id";
  "user.profile": "/user/:userId/profile";
  "user.settings": "/user/:userId/settings/:tab?";
};

type BlogRoutes = {
  "index": "/";
  "post": "/:slug";
  "category": "/category/:categoryId";
};

type ShopRoutes = {
  "index": "/";
  "cart": "/cart";
  "product": "/product/:id";
  "checkout": "/checkout/:step(shipping|payment|confirm)";
};

describe("ExtractParams", () => {
  it("should extract simple params", () => {
    type Params = ExtractParams<"/blog/:slug">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should extract multiple params", () => {
    type Params = ExtractParams<"/user/:userId/post/:postId">;
    expectTypeOf<Params>().toEqualTypeOf<{ userId: string; postId: string }>();
  });

  it("should handle optional params", () => {
    type Params = ExtractParams<"/settings/:tab?">;
    expectTypeOf<Params>().toEqualTypeOf<{ tab?: string }>();
  });

  it("should handle constrained params", () => {
    type Params = ExtractParams<"/checkout/:step(shipping|payment)">;
    expectTypeOf<Params>().toEqualTypeOf<{ step: "shipping" | "payment" }>();
  });

  it("should return empty object for no params", () => {
    type Params = ExtractParams<"/about">;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });

  it("should handle mixed params", () => {
    type Params = ExtractParams<"/user/:id/settings/:tab?">;
    expectTypeOf<Params>().toEqualTypeOf<{ id: string; tab?: string }>();
  });
});

describe("ParamsFor", () => {
  it("should extract params for route with params", () => {
    type Params = ParamsFor<TestRoutes, "blog.post">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should return empty object for route without params", () => {
    type Params = ParamsFor<TestRoutes, "about">;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });

  it("should handle optional params", () => {
    type Params = ParamsFor<TestRoutes, "user.settings">;
    expectTypeOf<Params>().toEqualTypeOf<{ userId: string; tab?: string }>();
  });
});

describe("PrefixRoutePatterns", () => {
  it("should prefix patterns", () => {
    type Prefixed = PrefixRoutePatterns<BlogRoutes, "/blog">;
    expectTypeOf<Prefixed>().toEqualTypeOf<{
      "index": "/blog";
      "post": "/blog/:slug";
      "category": "/blog/category/:categoryId";
    }>();
  });

  it("should handle empty prefix", () => {
    type Prefixed = PrefixRoutePatterns<BlogRoutes, "">;
    expectTypeOf<Prefixed>().toEqualTypeOf<BlogRoutes>();
  });

  it("should handle root pattern", () => {
    type Routes = { "index": "/" };
    type Prefixed = PrefixRoutePatterns<Routes, "/blog">;
    expectTypeOf<Prefixed>().toEqualTypeOf<{ "index": "/blog" }>();
  });
});

describe("PrefixRouteKeys", () => {
  it("should prefix keys", () => {
    type Prefixed = PrefixRouteKeys<BlogRoutes, "blog">;
    expectTypeOf<Prefixed>().toEqualTypeOf<{
      "blog.index": "/";
      "blog.post": "/:slug";
      "blog.category": "/category/:categoryId";
    }>();
  });

  it("should handle empty prefix", () => {
    type Prefixed = PrefixRouteKeys<BlogRoutes, "">;
    expectTypeOf<Prefixed>().toEqualTypeOf<BlogRoutes>();
  });
});

describe("PrefixedRoutes", () => {
  it("should prefix both keys and patterns", () => {
    type Prefixed = PrefixedRoutes<BlogRoutes, "blog">;
    expectTypeOf<Prefixed>().toEqualTypeOf<{
      "blog.index": "/blog";
      "blog.post": "/blog/:slug";
      "blog.category": "/blog/category/:categoryId";
    }>();
  });
});

describe("HrefFunction type structure", () => {
  it("should be a callable function type", () => {
    type Href = HrefFunction<TestRoutes>;
    expectTypeOf<Href>().toBeCallableWith("about");
    expectTypeOf<Href>().toBeCallableWith("blog.post", { slug: "hello" });
  });

  it("should return string", () => {
    type Href = HrefFunction<TestRoutes>;
    expectTypeOf<Href>().returns.toBeString();
  });

  it("should accept valid route names", () => {
    type Href = HrefFunction<TestRoutes>;
    // These are valid route keys in TestRoutes
    expectTypeOf<"about">().toMatchTypeOf<Parameters<Href>[0]>();
    expectTypeOf<"index">().toMatchTypeOf<Parameters<Href>[0]>();
    expectTypeOf<"blog.index">().toMatchTypeOf<Parameters<Href>[0]>();
  });
});

describe("ScopedHrefFunction type structure", () => {
  it("should be a callable function type", () => {
    type ScopedHref = ScopedHrefFunction<BlogRoutes>;
    expectTypeOf<ScopedHref>().toBeCallableWith("index");
    expectTypeOf<ScopedHref>().toBeCallableWith("post", { slug: "hello" });
  });

  it("should return string", () => {
    type ScopedHref = ScopedHrefFunction<BlogRoutes>;
    expectTypeOf<ScopedHref>().returns.toBeString();
  });

  it("should allow absolute names with dot notation", () => {
    type ScopedHref = ScopedHrefFunction<BlogRoutes>;
    // Absolute names (with dot) are always allowed via template literal type
    expectTypeOf<ScopedHref>().toBeCallableWith("shop.cart");
    expectTypeOf<ScopedHref>().toBeCallableWith("any.thing.here");
  });

  it("should allow path-based URLs", () => {
    type ScopedHref = ScopedHrefFunction<BlogRoutes>;
    // Path-based (starting with /) are always allowed
    expectTypeOf<ScopedHref>().toBeCallableWith("/about");
    expectTypeOf<ScopedHref>().toBeCallableWith("/any/path/here");
  });
});

describe("HandlerContext.href", () => {
  it("should have href property that is a function", () => {
    type Ctx = HandlerContext<{ slug: string }, DefaultEnv>;
    expectTypeOf<Ctx["href"]>().toBeFunction();
  });

  it("should return string", () => {
    type Ctx = HandlerContext<GenericParams, DefaultEnv>;
    expectTypeOf<Ctx["href"]>().returns.toBeString();
  });

  it("should accept string as first argument", () => {
    type Ctx = HandlerContext<GenericParams, DefaultEnv>;
    type FirstArg = Parameters<Ctx["href"]>[0];
    expectTypeOf<FirstArg>().toBeString();
  });

  it("should accept optional Record<string, string> as second argument", () => {
    type Ctx = HandlerContext<GenericParams, DefaultEnv>;
    type SecondArg = Parameters<Ctx["href"]>[1];
    expectTypeOf<SecondArg>().toEqualTypeOf<Record<string, string> | undefined>();
  });
});

// Compile-time type assertions using conditional types
// These will cause compile errors if types are wrong

type AssertTrue<T extends true> = T;
type AssertEqual<T, U> = T extends U ? (U extends T ? true : false) : false;

// Verify ExtractParams works correctly
type _Test1 = AssertTrue<AssertEqual<ExtractParams<"/blog/:slug">, { slug: string }>>;
type _Test2 = AssertTrue<AssertEqual<ExtractParams<"/about">, {}>>;
type _Test3 = AssertTrue<AssertEqual<ExtractParams<"/:id?">, { id?: string }>>;
type _Test4 = AssertTrue<AssertEqual<ExtractParams<"/:a/:b">, { a: string; b: string }>>;

// Verify ParamsFor works correctly
type _Test5 = AssertTrue<AssertEqual<ParamsFor<TestRoutes, "blog.post">, { slug: string }>>;
type _Test6 = AssertTrue<AssertEqual<ParamsFor<TestRoutes, "about">, {}>>;

// Verify PrefixRoutePatterns works correctly
type _Test7 = AssertTrue<AssertEqual<
  PrefixRoutePatterns<{ index: "/" }, "/blog">,
  { index: "/blog" }
>>;

// Verify PrefixedRoutes works correctly
type _Test8 = AssertTrue<AssertEqual<
  PrefixedRoutes<{ index: "/"; post: "/:slug" }, "blog">,
  { "blog.index": "/blog"; "blog.post": "/blog/:slug" }
>>;

// ============================================================================
// PathResponse — full type chain through urls.json() → createRouter().routes()
// ============================================================================

import type { PathResponse, ValidPaths } from "../href-client.js";
import { urls } from "../urls.js";
import type { RouteResponse, ResponseEnvelope } from "../urls.js";

// Actual urls definitions using the real urls() / urls.json() API.
// This tests that response types propagate through the phantom type chain.
const rscPatterns = urls(({ path }) => [
  path("/", () => null, { name: "home" }),
  path("/about", () => null, { name: "about" }),
  path("/blog/:slug", () => null, { name: "blog.post" }),
]);

const apiPatterns = urls.json(({ path }) => [
  path("/health", () => ({ status: "ok" as const, timestamp: Date.now() }), { name: "health" }),
  path("/items", () => [{ id: "1", name: "Widget" }], { name: "items" }),
  path("/items/:id", (ctx) => ({ id: ctx.params.id, name: "Widget", price: 9.99 }), { name: "item" }),
]);

// --- Scoped RouteResponse (from UrlPatterns._responses phantom) ---

describe("RouteResponse (scoped, from UrlPatterns)", () => {
  it("should resolve typed response envelope from urls.json() patterns", () => {
    type Health = RouteResponse<typeof apiPatterns, "health">;
    expectTypeOf<Health>().toEqualTypeOf<ResponseEnvelope<{ status: "ok"; timestamp: number }>>();
  });

  it("should resolve array response envelope type", () => {
    type Items = RouteResponse<typeof apiPatterns, "items">;
    expectTypeOf<Items>().toEqualTypeOf<ResponseEnvelope<{ id: string; name: string }[]>>();
  });

  it("should resolve dynamic route response envelope type", () => {
    type Item = RouteResponse<typeof apiPatterns, "item">;
    expectTypeOf<Item>().toEqualTypeOf<ResponseEnvelope<{ id: string; name: string; price: number }>>();
  });
});

// --- Full chain: urls.json() → MergeRoutesWithResponses → routeMap → PathResponse ---
// This simulates what createRouter().routes(patterns) does at the type level.
// createRouter can't be imported in vitest (virtual module dep), so we apply
// the same MergeRoutesWithResponses logic that .routes(UrlPatterns) uses.

// Extract phantom types from the UrlPatterns (exactly what router.ts does)
type RscRoutes = NonNullable<(typeof rscPatterns)["_routes"]>;
type ApiRoutes = NonNullable<(typeof apiPatterns)["_routes"]>;
type ApiResponses = (typeof apiPatterns)["_responses"];

// MergeRoutesWithResponses is the type router.ts applies when merging _routes + _responses
type MergeRoutesWithResponses<
  TRoutes extends Record<string, string>,
  TResponses,
> = {
  [K in keyof TRoutes]: K extends keyof NonNullable<TResponses>
    ? { readonly path: TRoutes[K]; readonly response: NonNullable<TResponses>[K] }
    : TRoutes[K]
};

// Combined route map — same as typeof router.routeMap after .routes(rsc).routes(api)
type FullRoutes = RscRoutes & MergeRoutesWithResponses<ApiRoutes, ApiResponses>;

describe("PathResponse (full chain through routeMap)", () => {
  it("should resolve response envelope for static response route", () => {
    type Health = PathResponse<"/health", FullRoutes>;
    expectTypeOf<Health>().toEqualTypeOf<ResponseEnvelope<{ status: "ok"; timestamp: number }>>();
  });

  it("should resolve response envelope for array response", () => {
    type Items = PathResponse<"/items", FullRoutes>;
    expectTypeOf<Items>().toEqualTypeOf<ResponseEnvelope<{ id: string; name: string }[]>>();
  });

  it("should resolve response envelope for dynamic response route", () => {
    type Item = PathResponse<"/items/:id", FullRoutes>;
    expectTypeOf<Item>().toEqualTypeOf<ResponseEnvelope<{ id: string; name: string; price: number }>>();
  });

  it("should return ResponseEnvelope<never> for RSC routes (no response type)", () => {
    type Home = PathResponse<"/", FullRoutes>;
    expectTypeOf<Home>().toEqualTypeOf<ResponseEnvelope<never>>();

    type About = PathResponse<"/about", FullRoutes>;
    expectTypeOf<About>().toEqualTypeOf<ResponseEnvelope<never>>();
  });

  it("should return ResponseEnvelope<never> for non-existent pattern", () => {
    type Missing = PathResponse<"/nope", FullRoutes>;
    expectTypeOf<Missing>().toEqualTypeOf<ResponseEnvelope<never>>();
  });
});

describe("ParamsFor with response routes in routeMap", () => {
  it("should extract params from RSC route (string value)", () => {
    type Params = ParamsFor<FullRoutes, "blog.post">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should extract params from response route ({ path, response } value)", () => {
    type Params = ParamsFor<FullRoutes, "item">;
    expectTypeOf<Params>().toEqualTypeOf<{ id: string }>();
  });

  it("should return empty params for static response route", () => {
    type Params = ParamsFor<FullRoutes, "health">;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });
});

describe("ValidPaths with mixed routeMap", () => {
  it("should include paths from both RSC and response routes", () => {
    type Paths = ValidPaths<FullRoutes>;
    expectTypeOf<"/">().toMatchTypeOf<Paths>();
    expectTypeOf<"/about">().toMatchTypeOf<Paths>();
    expectTypeOf<"/health">().toMatchTypeOf<Paths>();
    expectTypeOf<"/items">().toMatchTypeOf<Paths>();
  });
});

describe("HrefFunction with mixed routeMap", () => {
  it("should accept RSC route names", () => {
    type Href = HrefFunction<FullRoutes>;
    expectTypeOf<Href>().toBeCallableWith("about");
    expectTypeOf<Href>().toBeCallableWith("home");
  });

  it("should accept response route names with params", () => {
    type Href = HrefFunction<FullRoutes>;
    expectTypeOf<Href>().toBeCallableWith("health");
    expectTypeOf<Href>().toBeCallableWith("item", { id: "123" });
  });
});
