/**
 * Type-level tests for href system
 * These tests verify that the href types work correctly at compile time.
 *
 * This file is type-checked by tsc to ensure the href system is properly typed.
 */

import type { Handler, HandlerContext, Middleware, Revalidate, GenericParams } from "@rangojs/router";

// Test 1: ctx.href in handlers accepts valid route names
const testHandlerHref: Handler = (ctx) => {
  // Should work - valid route names from RegisteredRoutes
  const _indexUrl = ctx.href("index");
  const _blogUrl = ctx.href("blog.index");

  // Should work - route with params
  const _blogPostUrl = ctx.href("blog.post", { slug: "hello-world" });
  const _productUrl = ctx.href("product.detail", { productId: "123" });

  // Should work - absolute route with dot notation (global lookup)
  const _absoluteUrl = ctx.href("some.nested.route");

  // Should work - path-based URL
  const _pathUrl = ctx.href("/api/data");

  return null;
};

// Test 2: Handler type with route pattern extracts params
const testParamHandler: Handler<"/blog/:slug"> = (ctx) => {
  // ctx.params should be typed with { slug: string }
  const _slug: string = ctx.params.slug;
  return null;
};

// Test 3: Handler type with explicit params object
const testExplicitParamsHandler: Handler<{ slug: string; tab?: string }> = (ctx) => {
  const _slug: string = ctx.params.slug;
  const _tab: string | undefined = ctx.params.tab;
  return null;
};

// Test 4: Middleware type uses DefaultEnv for typed ctx.get/ctx.set
const testMiddleware: Middleware = async (ctx, next) => {
  // These should be typed based on AppVariables
  const _user = ctx.get("user");
  ctx.set("visitCount", 5);
  await next();
};

// Test 5: Middleware with explicit params
const testMiddlewareWithParams: Middleware<{ id: string }> = async (ctx, next) => {
  const _id: string | undefined = ctx.params.id;
  await next();
};

// Test 6: Revalidate function type
const testRevalidate: Revalidate<{ slug: string }> = ({ currentParams, nextParams, defaultShouldRevalidate }) => {
  const _currentSlug: string | undefined = currentParams.slug;
  const _nextSlug: string | undefined = nextParams.slug;
  return defaultShouldRevalidate;
};

// Test 7: HandlerContext has typed href
type CheckCtxHref = HandlerContext<{ id: string }>["href"];
// Verify href is a function type that returns string
type _AssertHrefCallable = CheckCtxHref extends (name: string, params?: any) => string ? true : never;
const _checkHrefCallable: _AssertHrefCallable = true;

// Test 8: GenericParams compatibility
const testGenericHandler: Handler<GenericParams> = (ctx) => {
  // Should allow any string key
  const _anyParam = ctx.params["anyKey"];
  return null;
};

// Test 9: Verify that route names from global augmentation are available
// This relies on the global namespace augmentation in router.tsx
declare function testGlobalRoutes(): void;
if (false as boolean) {
  testGlobalRoutes();
  // If RegisteredRoutes is properly augmented, these should all type-check
  const ctx = {} as HandlerContext;
  ctx.href("index");
  ctx.href("blog.index");
  ctx.href("blog.post", { slug: "test" });
  ctx.href("product.detail", { productId: "test" });
  ctx.href("href.index");
  ctx.href("href.detail", { id: "test" });
}

// =============================================================================
// Test 10: useHref<typeof localPatterns>() composability pattern
// =============================================================================
// This tests that included url modules can use useHref with their own patterns
// to get type-safe href for just their local routes.
// UrlPatterns is only available from server (it requires server context)
import type { UrlPatterns } from "@rangojs/router/server";
// ScopedHrefFunction, ExtractLocalRoutes, ExtractParams are safe client types
import type { ScopedHrefFunction, ExtractLocalRoutes, ExtractParams } from "@rangojs/router";
import { scopedHref } from "@rangojs/router";

// Simulate a local module's patterns type (like blogPatterns)
// This mirrors what urls() returns: UrlPatterns<TEnv, { routeName: pattern }>
type LocalBlogRoutes = {
  index: "/";
  post: "/:slug";
};
type BlogPatternsType = UrlPatterns<unknown, LocalBlogRoutes>;

// Type-level assertion: useHref<typeof blogPatterns>() should extract local routes
type ExtractedHref = BlogPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedHrefFunction<TRoutes>
  : never;

// Verify the extracted type is ScopedHrefFunction with our local routes
type _AssertExtractsLocalRoutes = ExtractedHref extends ScopedHrefFunction<LocalBlogRoutes>
  ? true
  : never;
const _checkExtractsLocalRoutes: _AssertExtractsLocalRoutes = true;

// Test 11: Local route name validation in ScopedHrefFunction
// When using useHref<typeof blogPatterns>(), these should type-check:
declare const localHref: ScopedHrefFunction<LocalBlogRoutes>;

// Valid local route without params
const _localIndex: string = localHref("index");

// Valid local route with params
const _localPost: string = localHref("post", { slug: "hello" });

// Absolute routes (dot notation) - allowed as escape hatch
const _absoluteRoute: string = localHref("shop.cart");

// Path-based URLs - allowed as escape hatch
const _pathBased: string = localHref("/about");

// Test 12: ExtractParams extracts correct params from local patterns
type IndexParams = ExtractParams<LocalBlogRoutes["index"]>;
type PostParams = ExtractParams<LocalBlogRoutes["post"]>;

type _AssertIndexHasNoParams = keyof IndexParams extends never ? true : never;
const _checkIndexHasNoParams: _AssertIndexHasNoParams = true;

type _AssertPostHasSlug = PostParams extends { slug: string } ? true : never;
const _checkPostHasSlug: _AssertPostHasSlug = true;

// Test 13: Nested module patterns (like nestedHrefPatterns inside hrefPatterns)
type NestedRoutes = {
  index: "/";
  detail: "/:itemId";
};
type NestedPatternsType = UrlPatterns<unknown, NestedRoutes>;

type NestedExtractedHref = NestedPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedHrefFunction<TRoutes>
  : never;

declare const nestedHref: NestedExtractedHref;

// Local names in nested module should be type-safe
const _nestedIndex: string = nestedHref("index");
const _nestedDetail: string = nestedHref("detail", { itemId: "abc" });

// Test 14: Empty patterns edge case
type EmptyRoutes = {};
type EmptyPatternsType = UrlPatterns<unknown, EmptyRoutes>;
type EmptyExtractedHref = EmptyPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedHrefFunction<TRoutes>
  : never;

// Empty patterns should still allow path-based and absolute routes
declare const emptyHref: EmptyExtractedHref;
const _emptyPathBased: string = emptyHref("/fallback");
const _emptyAbsolute: string = emptyHref("other.module.route");

// =============================================================================
// Test 15: scopedHref() for handlers to get locally-typed href
// =============================================================================
// This tests that handlers can use scopedHref<typeof patterns>(ctx.href)
// to get type-safe local route names.

// Simulate ctx.href (global type)
declare const globalHref: (name: string, params?: Record<string, string>) => string;

// Use scopedHref to narrow to local routes
type TestLocalRoutes = {
  index: "/";
  detail: "/:id";
  settings: "/settings";
};
type TestPatternsType = UrlPatterns<unknown, TestLocalRoutes>;

// Test ExtractLocalRoutes extracts routes from UrlPatterns
type ExtractedRoutes = ExtractLocalRoutes<TestPatternsType>;
type _AssertExtractedRoutesMatch = ExtractedRoutes extends TestLocalRoutes ? true : never;
const _checkExtractedRoutesMatch: _AssertExtractedRoutesMatch = true;

// Test scopedHref returns properly typed function
const localHrefFromHandler = scopedHref<TestPatternsType>(globalHref);

// These should all type-check
const _handlerIndex: string = localHrefFromHandler("index");
const _handlerDetail: string = localHrefFromHandler("detail", { id: "123" });
const _handlerSettings: string = localHrefFromHandler("settings");
const _handlerAbsolute: string = localHrefFromHandler("other.module.route");
const _handlerPath: string = localHrefFromHandler("/raw/path");

// Test 16: Handler usage pattern
const testHandlerWithScopedHref: Handler = (ctx) => {
  // This is the recommended pattern for composable modules
  const href = scopedHref<TestPatternsType>(ctx.href);

  // Local routes are now type-safe
  const _idx = href("index");
  const _det = href("detail", { id: "abc" });

  // Cross-module still works
  const _cross = href("blog.post", { slug: "hello" });

  return null;
};

export {};
