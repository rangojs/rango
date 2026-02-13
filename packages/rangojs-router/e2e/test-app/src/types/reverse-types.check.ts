/**
 * Type-level tests for reverse system
 * These tests verify that the reverse types work correctly at compile time.
 *
 * This file is type-checked by tsc to ensure the reverse system is properly typed.
 */

import type { Handler, HandlerContext, Middleware, Revalidate, GenericParams } from "@rangojs/router";

// Test 1: ctx.reverse in handlers accepts route names
const testHandlerReverse: Handler<"/"> = (ctx) => {
  // Should work - ctx.reverse accepts any string for named route resolution
  const _indexUrl = ctx.reverse("index");
  const _blogUrl = ctx.reverse("blog.index");

  // Should work - route with params
  const _blogPostUrl = ctx.reverse("blog.post", { slug: "hello-world" });
  const _productUrl = ctx.reverse("product.detail", { productId: "123" });

  // Should work - absolute route with dot notation (global lookup)
  const _absoluteUrl = ctx.reverse("some.nested.route");

  // Should work - path-based URL
  const _pathUrl = ctx.reverse("/api/data");

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

// Test 7: HandlerContext has typed reverse
type CheckCtxReverse = HandlerContext<{ id: string }>["reverse"];
// Verify reverse is a function type that returns string
type _AssertReverseCallable = CheckCtxReverse extends (name: string, params?: any) => string ? true : never;
const _checkReverseCallable: _AssertReverseCallable = true;

// Test 8: GenericParams compatibility
const testGenericHandler: Handler<GenericParams> = (ctx) => {
  // Should allow any string key
  const _anyParam = ctx.params["anyKey"];
  return null;
};

// Test 9: Verify ctx.reverse accepts various route name formats
// ctx.reverse is (name: string, params?) => string, accepts any route name
declare function testGlobalRoutes(): void;
if (false as boolean) {
  testGlobalRoutes();
  // ctx.reverse accepts any string - named routes resolve at runtime via server routeMap
  const ctx = {} as HandlerContext;
  ctx.reverse("index");
  ctx.reverse("blog.index");
  ctx.reverse("blog.post", { slug: "test" });
  ctx.reverse("product.detail", { productId: "test" });
  ctx.reverse("href.index");
  ctx.reverse("href.detail", { id: "test" });
}

// =============================================================================
// Test 10: ScopedReverseFunction composability pattern
// =============================================================================
// This tests that included url modules can use scopedReverse with their own patterns
// to get type-safe reverse for just their local routes.
// UrlPatterns is only available from server (it requires server context)
import type { UrlPatterns } from "@rangojs/router";
// ScopedReverseFunction, ExtractLocalRoutes, ExtractParams are safe client types
import type { ScopedReverseFunction, ExtractLocalRoutes, ExtractParams } from "@rangojs/router";
import { scopedReverse } from "@rangojs/router";

// Simulate a local module's patterns type (like blogPatterns)
// This mirrors what urls() returns: UrlPatterns<TEnv, { routeName: pattern }>
type LocalBlogRoutes = {
  index: "/";
  post: "/:slug";
};
type BlogPatternsType = UrlPatterns<unknown, LocalBlogRoutes>;

// Type-level assertion: scopedReverse should extract local routes from UrlPatterns
type ExtractedReverse = BlogPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedReverseFunction<TRoutes>
  : never;

// Verify the extracted type is ScopedReverseFunction with our local routes
type _AssertExtractsLocalRoutes = ExtractedReverse extends ScopedReverseFunction<LocalBlogRoutes>
  ? true
  : never;
const _checkExtractsLocalRoutes: _AssertExtractsLocalRoutes = true;

// Test 11: Local route name validation in ScopedReverseFunction
// When using scopedReverse<typeof blogPatterns>(ctx.reverse), these should type-check:
declare const localReverse: ScopedReverseFunction<LocalBlogRoutes>;

// Valid local route without params
const _localIndex: string = localReverse("index");

// Valid local route with params
const _localPost: string = localReverse("post", { slug: "hello" });

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

type NestedExtractedReverse = NestedPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedReverseFunction<TRoutes>
  : never;

declare const nestedReverse: NestedExtractedReverse;

// Local names in nested module should be type-safe
const _nestedIndex: string = nestedReverse("index");
const _nestedDetail: string = nestedReverse("detail", { itemId: "abc" });

// Test 14: Empty patterns edge case
type EmptyRoutes = {};
type EmptyPatternsType = UrlPatterns<unknown, EmptyRoutes>;
type EmptyExtractedReverse = EmptyPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedReverseFunction<TRoutes>
  : never;

// Empty patterns with no routes - no valid names to call
declare const emptyReverse: EmptyExtractedReverse;
// @ts-expect-error - no routes registered, all names rejected
const _emptyPathBased: string = emptyReverse("/fallback");
// @ts-expect-error - no routes registered, all names rejected
const _emptyAbsolute: string = emptyReverse("other.module.route");

// =============================================================================
// Test 15: scopedReverse() for handlers to get locally-typed reverse
// =============================================================================
// This tests that handlers can use scopedReverse<typeof patterns>(ctx.reverse)
// to get type-safe local route names.

// Simulate ctx.reverse (global type)
declare const globalReverse: (name: string, params?: Record<string, string>) => string;

// Use scopedReverse to narrow to local routes
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

// Test scopedReverse returns properly typed function
const localReverseFromHandler = scopedReverse<TestPatternsType>(globalReverse);

// These should all type-check
const _handlerIndex: string = localReverseFromHandler("index");
const _handlerDetail: string = localReverseFromHandler("detail", { id: "123" });
const _handlerSettings: string = localReverseFromHandler("settings");
const _handlerAbsolute: string = localReverseFromHandler("other.module.route");
const _handlerPath: string = localReverseFromHandler("/raw/path");

// Test 16: Handler usage pattern
const testHandlerWithScopedReverse: Handler<"/"> = (ctx) => {
  // This is the recommended pattern for composable modules
  const reverse = scopedReverse<TestPatternsType>(ctx.reverse);

  // Local routes are now type-safe
  const _idx = reverse("index");
  const _det = reverse("detail", { id: "abc" });

  // Cross-module still works
  const _cross = reverse("blog.post", { slug: "hello" });

  return null;
};

export {};
