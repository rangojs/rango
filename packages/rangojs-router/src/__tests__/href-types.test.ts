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
import type { HandlerContext, GenericParams, DefaultEnv, RouterEnv } from "../types.js";

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
import type { RouteResponse, ResponseEnvelope, ResponseHandlerContext, ResponseError } from "../urls.js";
import { isResponseError } from "../client.js";

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

// MergeRoutesWithResponses is the type router.ts applies when merging _routes + _responses.
// RSC routes have TData = unknown (the TypedRouteItem default), so we skip those.
type MergeRoutesWithResponses<
  TRoutes extends Record<string, string>,
  TResponses,
> = {
  [K in keyof TRoutes]: K extends keyof NonNullable<TResponses>
    ? unknown extends NonNullable<TResponses>[K]
      ? TRoutes[K]
      : { readonly path: TRoutes[K]; readonly response: NonNullable<TResponses>[K] }
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

// ============================================================================
// ResponseHandlerContext — env extraction, searchParams, url, pathname
// ============================================================================

type TestEnv = RouterEnv<{ DB: "d1"; KV: "kv" }, { user: string }>;

describe("ResponseHandlerContext", () => {
  it("should extract bindings from RouterEnv", () => {
    type Ctx = ResponseHandlerContext<{}, TestEnv>;
    expectTypeOf<Ctx["env"]>().toEqualTypeOf<{ DB: "d1"; KV: "kv" }>();
  });

  it("should fallback to empty object for non-RouterEnv", () => {
    type Ctx = ResponseHandlerContext<{}, { DB: string }>;
    expectTypeOf<Ctx["env"]>().toEqualTypeOf<{}>();
  });

  it("should have searchParams", () => {
    type Ctx = ResponseHandlerContext<{}, TestEnv>;
    expectTypeOf<Ctx["searchParams"]>().toEqualTypeOf<URLSearchParams>();
  });

  it("should have url", () => {
    type Ctx = ResponseHandlerContext<{}, TestEnv>;
    expectTypeOf<Ctx["url"]>().toEqualTypeOf<URL>();
  });

  it("should have pathname", () => {
    type Ctx = ResponseHandlerContext<{}, TestEnv>;
    expectTypeOf<Ctx["pathname"]>().toEqualTypeOf<string>();
  });

  it("should have typed params", () => {
    type Ctx = ResponseHandlerContext<{ id: string; slug: string }, TestEnv>;
    expectTypeOf<Ctx["params"]>().toEqualTypeOf<{ id: string; slug: string }>();
  });
});

// ============================================================================
// ResponseEnvelope — discriminated union shape
// ============================================================================

describe("ResponseEnvelope", () => {
  it("should have data branch with T and no error", () => {
    type Success = Extract<ResponseEnvelope<{ name: string }>, { data: any }>;
    expectTypeOf<Success["data"]>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<Success>().toHaveProperty("error");
  });

  it("should have error branch with ResponseError and no data", () => {
    type Failure = Extract<ResponseEnvelope<{ name: string }>, { error: ResponseError }>;
    expectTypeOf<Failure["error"]>().toEqualTypeOf<ResponseError>();
  });

  it("should have message on ResponseError", () => {
    expectTypeOf<ResponseError>().toHaveProperty("message");
    expectTypeOf<ResponseError["message"]>().toBeString();
  });

  it("should have optional code and type on ResponseError", () => {
    expectTypeOf<ResponseError>().toHaveProperty("code");
    expectTypeOf<ResponseError>().toHaveProperty("type");
  });
});

// ============================================================================
// isResponseError — type narrowing
// ============================================================================

describe("isResponseError", () => {
  it("should narrow to error branch", () => {
    const result = {} as ResponseEnvelope<{ name: string }>;
    if (isResponseError(result)) {
      expectTypeOf(result.error).toEqualTypeOf<ResponseError>();
      // data should be undefined in the error branch
      expectTypeOf(result.data).toEqualTypeOf<undefined>();
    } else {
      expectTypeOf(result.data).toEqualTypeOf<{ name: string }>();
    }
  });

  it("should accept ResponseEnvelope input", () => {
    expectTypeOf(isResponseError<{ id: number }>).toBeCallableWith(
      {} as ResponseEnvelope<{ id: number }>
    );
  });

  it("should return boolean", () => {
    expectTypeOf(isResponseError<string>).returns.toBeBoolean();
  });
});

// ============================================================================
// User-land API: urls() with include(), mixed MIME types, scoped RouteResponse
// ============================================================================

// --- Sub-module patterns (each declared independently, like separate files) ---

// JSON API module (e.g. api/urls.tsx)
const userApiPatterns = urls.json(({ path }) => [
  path("/health", () => ({ status: "ok" as const, uptime: 123 }), { name: "health" }),
  path("/users", () => [{ id: "1", email: "a@b.com" }], { name: "users" }),
  path("/users/:userId", (ctx) => ({ id: ctx.params.userId, email: "a@b.com" }), { name: "user" }),
  path("/users/:userId/posts/:postId", (ctx) => ({
    id: ctx.params.postId,
    author: ctx.params.userId,
    title: "Hello",
  }), { name: "user.post" }),
]);

// Text module (e.g. seo/urls.tsx)
const seoPatterns = urls.text(({ path }) => [
  path("/robots.txt", () => "User-agent: *\nDisallow: /api/", { name: "robots" }),
  path("/sitemap.txt", () => "https://example.com/\nhttps://example.com/about", { name: "sitemap" }),
]);

// Main urlpatterns — mixes RSC pages, inline response routes, and includes
// This mirrors what a real app's urls.tsx looks like
const mainPatterns = urls(({ path, include }) => [
  // RSC pages
  path("/", () => null, { name: "home" }),
  path("/about", () => null, { name: "about" }),
  path("/blog/:slug", () => null, { name: "blog.post" }),

  // Inline JSON route alongside RSC
  path.json("/api/inline", () => ({ inline: true as const, count: 42 }), { name: "inlineApi" }),

  // Inline text route
  path.text("/version.txt", () => "1.0.0", { name: "version" }),

  // Include JSON API module
  include("/api/v1", userApiPatterns, { name: "api" }),

  // Include text module
  include("/seo", seoPatterns, { name: "seo" }),
]);

// --- Scoped RouteResponse (local typing before include) ---

describe("RouteResponse (scoped, local typing)", () => {
  it("should resolve typed response from local JSON patterns", () => {
    type Health = RouteResponse<typeof userApiPatterns, "health">;
    expectTypeOf<Health>().toEqualTypeOf<ResponseEnvelope<{ status: "ok"; uptime: number }>>();
  });

  it("should resolve array response from local JSON patterns", () => {
    type Users = RouteResponse<typeof userApiPatterns, "users">;
    expectTypeOf<Users>().toEqualTypeOf<ResponseEnvelope<{ id: string; email: string }[]>>();
  });

  it("should resolve parameterized response from local JSON patterns", () => {
    type User = RouteResponse<typeof userApiPatterns, "user">;
    expectTypeOf<User>().toEqualTypeOf<ResponseEnvelope<{ id: string; email: string }>>();
  });

  it("should resolve deeply nested response from local JSON patterns", () => {
    type Post = RouteResponse<typeof userApiPatterns, "user.post">;
    expectTypeOf<Post>().toEqualTypeOf<ResponseEnvelope<{ id: string; author: string; title: string }>>();
  });

  it("should resolve text patterns locally (text routes have string data)", () => {
    // Text routes have TData = string
    type Robots = RouteResponse<typeof seoPatterns, "robots">;
    expectTypeOf<Robots>().toEqualTypeOf<ResponseEnvelope<string>>();
  });
});

// --- Extract phantom types from mainPatterns (what createRouter().routes() does) ---

type MainRoutes = NonNullable<(typeof mainPatterns)["_routes"]>;
type MainResponses = (typeof mainPatterns)["_responses"];

// Apply MergeRoutesWithResponses (same logic router.ts uses)
type MainAppRoutes = MergeRoutesWithResponses<MainRoutes, MainResponses>;

describe("urls() with include() — full type chain", () => {
  // RSC routes remain plain strings
  it("should have RSC routes as string values", () => {
    type HomeValue = MainAppRoutes["home"];
    expectTypeOf<HomeValue>().toBeString();
  });

  // Inline response routes become { path, response } objects
  it("should have inline JSON route as { path, response } object", () => {
    type InlineValue = MainAppRoutes["inlineApi"];
    expectTypeOf<InlineValue>().toMatchTypeOf<{ readonly path: string; readonly response: unknown }>();
  });

  // Route names: RSC
  it("should resolve RSC route names in HrefFunction", () => {
    type Href = HrefFunction<MainAppRoutes>;
    expectTypeOf<Href>().toBeCallableWith("home");
    expectTypeOf<Href>().toBeCallableWith("about");
    expectTypeOf<Href>().toBeCallableWith("blog.post", { slug: "hello" });
  });

  // Route names: inline response routes
  it("should resolve inline response route names", () => {
    type Href = HrefFunction<MainAppRoutes>;
    expectTypeOf<Href>().toBeCallableWith("inlineApi");
    expectTypeOf<Href>().toBeCallableWith("version");
  });

  // Route names: included JSON API (prefixed with "api.")
  it("should resolve included JSON API route names with prefix", () => {
    type Href = HrefFunction<MainAppRoutes>;
    expectTypeOf<Href>().toBeCallableWith("api.health");
    expectTypeOf<Href>().toBeCallableWith("api.users");
    expectTypeOf<Href>().toBeCallableWith("api.user", { userId: "123" });
    expectTypeOf<Href>().toBeCallableWith("api.user.post", { userId: "1", postId: "42" });
  });

  // Route names: included text routes (prefixed with "seo.")
  it("should resolve included text route names with prefix", () => {
    type Href = HrefFunction<MainAppRoutes>;
    expectTypeOf<Href>().toBeCallableWith("seo.robots");
    expectTypeOf<Href>().toBeCallableWith("seo.sitemap");
  });
});

describe("PathResponse through urls() with include()", () => {
  // RSC routes
  it("should return ResponseEnvelope<never> for RSC routes", () => {
    type Home = PathResponse<"/", MainAppRoutes>;
    expectTypeOf<Home>().toEqualTypeOf<ResponseEnvelope<never>>();

    type About = PathResponse<"/about", MainAppRoutes>;
    expectTypeOf<About>().toEqualTypeOf<ResponseEnvelope<never>>();
  });

  // Inline JSON route
  it("should resolve inline JSON route response", () => {
    type Inline = PathResponse<"/api/inline", MainAppRoutes>;
    expectTypeOf<Inline>().toEqualTypeOf<ResponseEnvelope<{ inline: true; count: number }>>();
  });

  // Inline text route
  it("should resolve inline text route response as string", () => {
    type Version = PathResponse<"/version.txt", MainAppRoutes>;
    expectTypeOf<Version>().toEqualTypeOf<ResponseEnvelope<string>>();
  });

  // Included JSON API routes (URL-prefixed with /api/v1)
  it("should resolve included JSON API route response", () => {
    type Health = PathResponse<"/api/v1/health", MainAppRoutes>;
    expectTypeOf<Health>().toEqualTypeOf<ResponseEnvelope<{ status: "ok"; uptime: number }>>();
  });

  it("should resolve included JSON API array response", () => {
    type Users = PathResponse<"/api/v1/users", MainAppRoutes>;
    expectTypeOf<Users>().toEqualTypeOf<ResponseEnvelope<{ id: string; email: string }[]>>();
  });

  it("should resolve included JSON API parameterized response", () => {
    type User = PathResponse<"/api/v1/users/:userId", MainAppRoutes>;
    expectTypeOf<User>().toEqualTypeOf<ResponseEnvelope<{ id: string; email: string }>>();
  });

  it("should resolve included deeply nested route response", () => {
    type Post = PathResponse<"/api/v1/users/:userId/posts/:postId", MainAppRoutes>;
    expectTypeOf<Post>().toEqualTypeOf<ResponseEnvelope<{ id: string; author: string; title: string }>>();
  });

  // Included text routes (URL-prefixed with /seo)
  it("should resolve included text route response", () => {
    type Robots = PathResponse<"/seo/robots.txt", MainAppRoutes>;
    expectTypeOf<Robots>().toEqualTypeOf<ResponseEnvelope<string>>();
  });
});

describe("ParamsFor through urls() with include()", () => {
  it("should extract params from RSC route", () => {
    type Params = ParamsFor<MainAppRoutes, "blog.post">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should extract params from included API route", () => {
    type Params = ParamsFor<MainAppRoutes, "api.user">;
    expectTypeOf<Params>().toEqualTypeOf<{ userId: string }>();
  });

  it("should extract multiple params from included nested route", () => {
    type Params = ParamsFor<MainAppRoutes, "api.user.post">;
    expectTypeOf<Params>().toEqualTypeOf<{ userId: string; postId: string }>();
  });

  it("should return empty params for static included routes", () => {
    type Params = ParamsFor<MainAppRoutes, "api.health">;
    expectTypeOf<Params>().toEqualTypeOf<{}>();

    type SeoParams = ParamsFor<MainAppRoutes, "seo.robots">;
    expectTypeOf<SeoParams>().toEqualTypeOf<{}>();
  });

  it("should return empty params for inline response routes", () => {
    type Params = ParamsFor<MainAppRoutes, "inlineApi">;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });
});

describe("ValidPaths through urls() with include()", () => {
  it("should include all route paths from mixed sources", () => {
    type Paths = ValidPaths<MainAppRoutes>;
    // RSC
    expectTypeOf<"/">().toMatchTypeOf<Paths>();
    expectTypeOf<"/about">().toMatchTypeOf<Paths>();
    // Inline response
    expectTypeOf<"/api/inline">().toMatchTypeOf<Paths>();
    expectTypeOf<"/version.txt">().toMatchTypeOf<Paths>();
    // Included JSON API
    expectTypeOf<"/api/v1/health">().toMatchTypeOf<Paths>();
    expectTypeOf<"/api/v1/users">().toMatchTypeOf<Paths>();
    // Included text
    expectTypeOf<"/seo/robots.txt">().toMatchTypeOf<Paths>();
    expectTypeOf<"/seo/sitemap.txt">().toMatchTypeOf<Paths>();
  });
});

// ============================================================================
// Mountable module: blog with RSC pages + JSON APIs, nested include, scoped href
// ============================================================================

// blog/api/urls.tsx — Blog's own JSON API routes
const blogApiPatterns = urls.json(({ path }) => [
  path("/stats", () => ({ views: 1000, visitors: 500 }), { name: "stats" }),
  path("/:slug/likes", (ctx) => ({ slug: ctx.params.slug, count: 42 }), { name: "likes" }),
  path("/:slug/comments", (ctx) => ([
    { id: "c1", slug: ctx.params.slug, body: "Great post" },
  ]), { name: "comments" }),
]);

// blog/urls.tsx — Self-contained blog module (RSC pages + JSON APIs)
const blogModulePatterns = urls(({ path, include }) => [
  path("/", () => null, { name: "index" }),
  path("/:slug", () => null, { name: "post" }),
  path("/category/:catId", () => null, { name: "category" }),

  // Blog's own API — nested include inside the module
  include("/api", blogApiPatterns, { name: "api" }),
]);

// app/urls.tsx — Main app mounts the blog module
const appPatterns = urls(({ path, include }) => [
  path("/", () => null, { name: "home" }),
  path("/about", () => null, { name: "about" }),
  include("/blog", blogModulePatterns, { name: "blog" }),
]);

// --- Scoped RouteResponse on the blog API (local typing, before mount) ---

describe("Mountable module — scoped RouteResponse on blog API", () => {
  it("should resolve stats response locally", () => {
    type Stats = RouteResponse<typeof blogApiPatterns, "stats">;
    expectTypeOf<Stats>().toEqualTypeOf<ResponseEnvelope<{ views: number; visitors: number }>>();
  });

  it("should resolve parameterized likes response locally", () => {
    type Likes = RouteResponse<typeof blogApiPatterns, "likes">;
    expectTypeOf<Likes>().toEqualTypeOf<ResponseEnvelope<{ slug: string; count: number }>>();
  });

  it("should resolve array comments response locally", () => {
    type Comments = RouteResponse<typeof blogApiPatterns, "comments">;
    expectTypeOf<Comments>().toEqualTypeOf<ResponseEnvelope<{ id: string; slug: string; body: string }[]>>();
  });
});

// --- Scoped href within the blog module (ctx.href / useHref inside blog) ---

// Extract the blog module's own routes (what ctx.href sees inside blog handlers)
type BlogModuleRoutes = NonNullable<(typeof blogModulePatterns)["_routes"]>;
type BlogModuleResponses = (typeof blogModulePatterns)["_responses"];
type BlogModuleMerged = MergeRoutesWithResponses<BlogModuleRoutes, BlogModuleResponses>;

describe("Mountable module — ScopedHrefFunction inside blog module", () => {
  it("should accept local RSC route names", () => {
    type BlogHref = ScopedHrefFunction<BlogModuleMerged>;
    expectTypeOf<BlogHref>().toBeCallableWith("index");
    expectTypeOf<BlogHref>().toBeCallableWith("post", { slug: "hello" });
    expectTypeOf<BlogHref>().toBeCallableWith("category", { catId: "tech" });
  });

  it("should accept nested API route names (after internal include)", () => {
    type BlogHref = ScopedHrefFunction<BlogModuleMerged>;
    expectTypeOf<BlogHref>().toBeCallableWith("api.stats");
    expectTypeOf<BlogHref>().toBeCallableWith("api.likes", { slug: "hello" });
    expectTypeOf<BlogHref>().toBeCallableWith("api.comments", { slug: "hello" });
  });

  it("should accept absolute names to reach parent routes (dot-notation passthrough)", () => {
    type BlogHref = ScopedHrefFunction<BlogModuleMerged>;
    // Absolute names with dot notation pass through to the global router
    expectTypeOf<BlogHref>().toBeCallableWith("home.something");
  });
});

// --- Blog module's own RouteResponse (before mounting) ---

describe("Mountable module — RouteResponse on blog module (pre-mount)", () => {
  it("should resolve API response through nested include", () => {
    type Stats = RouteResponse<typeof blogModulePatterns, "api.stats">;
    expectTypeOf<Stats>().toEqualTypeOf<ResponseEnvelope<{ views: number; visitors: number }>>();
  });

  it("should resolve parameterized API response through nested include", () => {
    type Likes = RouteResponse<typeof blogModulePatterns, "api.likes">;
    expectTypeOf<Likes>().toEqualTypeOf<ResponseEnvelope<{ slug: string; count: number }>>();
  });

  it("should resolve array API response through nested include", () => {
    type Comments = RouteResponse<typeof blogModulePatterns, "api.comments">;
    expectTypeOf<Comments>().toEqualTypeOf<ResponseEnvelope<{ id: string; slug: string; body: string }[]>>();
  });
});

// --- After mounting: full app route map ---

type AppRoutes = NonNullable<(typeof appPatterns)["_routes"]>;
type AppResponses = (typeof appPatterns)["_responses"];
type AppMerged = MergeRoutesWithResponses<AppRoutes, AppResponses>;

describe("Mountable module — HrefFunction after mounting blog", () => {
  it("should accept top-level app routes", () => {
    type AppHref = HrefFunction<AppMerged>;
    expectTypeOf<AppHref>().toBeCallableWith("home");
    expectTypeOf<AppHref>().toBeCallableWith("about");
  });

  it("should accept blog RSC routes with blog. prefix", () => {
    type AppHref = HrefFunction<AppMerged>;
    expectTypeOf<AppHref>().toBeCallableWith("blog.index");
    expectTypeOf<AppHref>().toBeCallableWith("blog.post", { slug: "hello" });
    expectTypeOf<AppHref>().toBeCallableWith("blog.category", { catId: "tech" });
  });

  it("should accept blog API routes with blog.api. prefix (nested include)", () => {
    type AppHref = HrefFunction<AppMerged>;
    expectTypeOf<AppHref>().toBeCallableWith("blog.api.stats");
    expectTypeOf<AppHref>().toBeCallableWith("blog.api.likes", { slug: "hello" });
    expectTypeOf<AppHref>().toBeCallableWith("blog.api.comments", { slug: "hello" });
  });
});

describe("Mountable module — PathResponse after mounting blog", () => {
  // RSC routes — no response type
  it("should return ResponseEnvelope<never> for blog RSC routes", () => {
    type BlogIndex = PathResponse<"/blog", AppMerged>;
    expectTypeOf<BlogIndex>().toEqualTypeOf<ResponseEnvelope<never>>();

    type BlogPost = PathResponse<"/blog/:slug", AppMerged>;
    expectTypeOf<BlogPost>().toEqualTypeOf<ResponseEnvelope<never>>();
  });

  // Blog API routes — response types propagate through nested include
  it("should resolve blog API stats response", () => {
    type Stats = PathResponse<"/blog/api/stats", AppMerged>;
    expectTypeOf<Stats>().toEqualTypeOf<ResponseEnvelope<{ views: number; visitors: number }>>();
  });

  it("should resolve blog API likes response with params", () => {
    type Likes = PathResponse<"/blog/api/:slug/likes", AppMerged>;
    expectTypeOf<Likes>().toEqualTypeOf<ResponseEnvelope<{ slug: string; count: number }>>();
  });

  it("should resolve blog API comments array response", () => {
    type Comments = PathResponse<"/blog/api/:slug/comments", AppMerged>;
    expectTypeOf<Comments>().toEqualTypeOf<ResponseEnvelope<{ id: string; slug: string; body: string }[]>>();
  });
});

describe("Mountable module — ParamsFor after mounting blog", () => {
  it("should extract params from mounted blog post route", () => {
    type Params = ParamsFor<AppMerged, "blog.post">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should extract params from mounted blog category route", () => {
    type Params = ParamsFor<AppMerged, "blog.category">;
    expectTypeOf<Params>().toEqualTypeOf<{ catId: string }>();
  });

  it("should extract params from nested blog API likes route", () => {
    type Params = ParamsFor<AppMerged, "blog.api.likes">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should extract params from nested blog API comments route", () => {
    type Params = ParamsFor<AppMerged, "blog.api.comments">;
    expectTypeOf<Params>().toEqualTypeOf<{ slug: string }>();
  });

  it("should return empty params for static blog API stats route", () => {
    type Params = ParamsFor<AppMerged, "blog.api.stats">;
    expectTypeOf<Params>().toEqualTypeOf<{}>();
  });
});

describe("Mountable module — ValidPaths after mounting blog", () => {
  it("should include all paths: app + blog RSC + blog API", () => {
    type Paths = ValidPaths<AppMerged>;
    // App routes
    expectTypeOf<"/">().toMatchTypeOf<Paths>();
    expectTypeOf<"/about">().toMatchTypeOf<Paths>();
    // Blog RSC routes (prefixed /blog)
    expectTypeOf<"/blog">().toMatchTypeOf<Paths>();
    expectTypeOf<"/blog/category/:catId">().toMatchTypeOf<Paths>();
    // Blog API routes (double-prefixed /blog/api)
    expectTypeOf<"/blog/api/stats">().toMatchTypeOf<Paths>();
    expectTypeOf<"/blog/api/:slug/likes">().toMatchTypeOf<Paths>();
    expectTypeOf<"/blog/api/:slug/comments">().toMatchTypeOf<Paths>();
  });
});
