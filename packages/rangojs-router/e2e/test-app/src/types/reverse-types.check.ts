/**
 * Type-level tests for reverse system
 * These tests verify that the reverse types work correctly at compile time.
 *
 * This file is type-checked by tsc to ensure the reverse system is properly typed.
 */

import type {
  Handler,
  HandlerContext,
  LoaderContext,
  MiddlewareContext,
  Middleware,
  Revalidate,
  GenericParams,
} from "@rangojs/router";

// Test 1: ctx.reverse in handlers accepts route names
const testHandlerReverse: Handler<"/"> = (ctx) => {
  // Should work - ctx.reverse accepts valid generated route names
  const _indexUrl = ctx.reverse("index");
  const _blogUrl = ctx.reverse("blog.index");

  // Should work - route with params
  const _blogPostUrl = ctx.reverse("blog.post", { postId: "hello-world" });
  const _productUrl = ctx.reverse("product.detail", { productId: "123" });

  // Should work - absolute route with dot notation (global lookup)
  const _absoluteUrl = ctx.reverse("docs.article", { slug: "intro" });

  return null;
};

// Test 2: Handler type with route pattern extracts params
const testParamHandler: Handler<"/blog/:slug"> = (ctx) => {
  // ctx.params should be typed with { slug: string }
  const _slug: string = ctx.params.slug;
  return null;
};

// Test 3: Handler type with explicit params object
const testExplicitParamsHandler: Handler<{ slug: string; tab?: string }> = (
  ctx,
) => {
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
const testMiddlewareWithParams: Middleware<{ id: string }> = async (
  ctx,
  next,
) => {
  const _id: string | undefined = ctx.params.id;
  await next();
};

// Test 6: Revalidate function type
const testRevalidate: Revalidate<{ slug: string }> = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  const _currentSlug: string | undefined = currentParams.slug;
  const _nextSlug: string | undefined = nextParams.slug;
  return defaultShouldRevalidate;
};

// Test 7: HandlerContext has typed reverse
type CheckCtxReverse = HandlerContext<{ id: string }>["reverse"];
// Verify reverse is a function type that returns string
type _AssertReverseCallable = CheckCtxReverse extends (
  name: string,
  params?: any,
) => string
  ? true
  : never;
const _checkReverseCallable: _AssertReverseCallable = true;

// Test 8: GenericParams compatibility
const testGenericHandler: Handler<GenericParams> = (ctx) => {
  // Should allow any string key
  const _anyParam = ctx.params["anyKey"];
  return null;
};

// Test 9: Verify ctx.reverse accepts valid global route name formats
declare function testGlobalRoutes(): void;
if (false as boolean) {
  testGlobalRoutes();
  // Valid generated route names should type-check
  const ctx = {} as HandlerContext;
  ctx.reverse("index");
  ctx.reverse("blog.index");
  ctx.reverse("blog.post", { postId: "test" });
  ctx.reverse("product.detail", { productId: "test" });
  ctx.reverse("href.index");
  ctx.reverse("href.detail", { id: "test" });
  // Dot-prefixed local names remain permissive when no local route map is known
  ctx.reverse(".local-name");
}

// =============================================================================
// Test 10: ScopedReverseFunction composability pattern
// =============================================================================
// This tests that included url modules can use scopedReverse with their own patterns
// to get type-safe reverse for just their local routes.
// UrlPatterns is only available from server (it requires server context)
import type { UrlPatterns } from "@rangojs/router";
// ScopedReverseFunction, ExtractLocalRoutes, ExtractParams are safe client types
import type {
  ScopedReverseFunction,
  ExtractLocalRoutes,
  ExtractParams,
} from "@rangojs/router";
import { scopedReverse } from "@rangojs/router";

// Simulate a local module's patterns type (like blogPatterns)
// This mirrors what urls() returns: UrlPatterns<TEnv, { routeName: pattern }>
type LocalBlogRoutes = {
  index: "/";
  post: "/:slug";
};
type BlogPatternsType = UrlPatterns<unknown, LocalBlogRoutes>;

// Type-level assertion: scopedReverse should extract local routes from UrlPatterns
type ExtractedReverse =
  BlogPatternsType extends UrlPatterns<any, infer TRoutes>
    ? ScopedReverseFunction<TRoutes>
    : never;

// Verify the extracted type is ScopedReverseFunction with our local routes
type _AssertExtractsLocalRoutes =
  ExtractedReverse extends ScopedReverseFunction<LocalBlogRoutes>
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

type NestedExtractedReverse =
  NestedPatternsType extends UrlPatterns<any, infer TRoutes>
    ? ScopedReverseFunction<TRoutes>
    : never;

declare const nestedReverse: NestedExtractedReverse;

// Local names in nested module should be type-safe
const _nestedIndex: string = nestedReverse("index");
const _nestedDetail: string = nestedReverse("detail", { itemId: "abc" });

// Test 14: Empty patterns edge case
type EmptyRoutes = {};
type EmptyPatternsType = UrlPatterns<unknown, EmptyRoutes>;
type EmptyExtractedReverse =
  EmptyPatternsType extends UrlPatterns<any, infer TRoutes>
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
declare const globalReverse: (
  name: string,
  params?: Record<string, string>,
) => string;

// Use scopedReverse to narrow to local routes
type TestLocalRoutes = {
  index: "/";
  detail: "/:id";
  settings: "/settings";
};
type TestPatternsType = UrlPatterns<unknown, TestLocalRoutes>;

// Test ExtractLocalRoutes extracts routes from UrlPatterns
type ExtractedRoutes = ExtractLocalRoutes<TestPatternsType>;
type _AssertExtractedRoutesMatch = ExtractedRoutes extends TestLocalRoutes
  ? true
  : never;
const _checkExtractedRoutesMatch: _AssertExtractedRoutesMatch = true;

// Test scopedReverse returns properly typed function
const localReverseFromHandler = scopedReverse<TestPatternsType>(globalReverse);

// These should all type-check (scoped to local routes only)
const _handlerIndex: string = localReverseFromHandler("index");
const _handlerDetail: string = localReverseFromHandler("detail", { id: "123" });
const _handlerSettings: string = localReverseFromHandler("settings");

// Test 16: Handler usage pattern
const testHandlerWithScopedReverse: Handler<"/"> = (ctx) => {
  // scopedReverse restricts to local routes only
  const reverse = scopedReverse<TestPatternsType>(ctx.reverse);

  // Local routes are type-safe
  const _idx = reverse("index");
  const _det = reverse("detail", { id: "abc" });

  // For global routes, use ctx.reverse directly
  const _cross = ctx.reverse("blog.post", { postId: "hello" });

  return null;
};

// Test 16b: scopedReverse() works for extracted loaders and middleware too
type SharedLocalRoutes = {
  index: "/";
  detail: "/:id";
  settings: "/settings";
};
type SharedPatternsType = UrlPatterns<unknown, SharedLocalRoutes>;

const testLoaderWithScopedReverse = (
  ctx: LoaderContext<Record<string, string | undefined>>,
) => {
  const reverse = scopedReverse<SharedPatternsType>(ctx.reverse);

  const _idx = reverse("index");
  const _detail = reverse("detail", { id: "abc" });
  const _settings = reverse("settings");

  return { _idx, _detail, _settings };
};

const testMiddlewareWithScopedReverse = async (
  ctx: MiddlewareContext,
  next: () => Promise<Response>,
) => {
  const reverse = scopedReverse<SharedPatternsType>(ctx.reverse);

  const _idx = reverse("index");
  const _detail = reverse("detail", { id: "abc" });
  const _settings = reverse("settings");

  await next();
  return new Response(JSON.stringify({ _idx, _detail, _settings }));
};

// =============================================================================
// Test 17: getRequestContext().reverse() is type-safe with global route names
// =============================================================================
import { getRequestContext } from "@rangojs/router";

if (false as boolean) {
  const ctx = getRequestContext()!;

  // Should work - valid global route names (from RegisteredRoutes)
  const _blogIndex: string = ctx.reverse("blog.index");
  const _blogPost: string = ctx.reverse("blog.post", { postId: "hello" });
  const _hrefIndex: string = ctx.reverse("href.index");
  const _hrefDetail: string = ctx.reverse("href.detail", { id: "123" });
  const _index: string = ctx.reverse("index");
  const _docsArticle: string = ctx.reverse("docs.article", { slug: "intro" });

  // @ts-expect-error - invalid route name should fail
  ctx.reverse("nonexistent.route");

  // @ts-expect-error - missing required params should fail
  ctx.reverse("blog.post");

  // @ts-expect-error - wrong param name should fail
  ctx.reverse("blog.post", { wrongParam: "test" });
}

// =============================================================================
// Test 18: Explicit local route maps require local params but allow mount params
// =============================================================================
type LocalMountedRoutes = {
  settings: "/settings";
  user: "/users/:userId";
};

if (false as boolean) {
  const ctx = {} as HandlerContext<
    { tenantId: string; userId?: string },
    any,
    {},
    LocalMountedRoutes
  >;

  ctx.reverse(".settings");
  ctx.reverse(".settings", { tenantId: "override" });
  ctx.reverse(".user", { userId: "u1" });
  ctx.reverse(".user", { userId: "u1", tenantId: "override" });

  // @ts-expect-error - local route param is required when known from the local map
  ctx.reverse(".user");

  // @ts-expect-error - inherited mount params alone are not enough
  ctx.reverse(".user", { tenantId: "override" });
}

// =============================================================================
// Test 19: Inline handlers without an explicit local route map stay permissive
// =============================================================================
if (false as boolean) {
  const ctx = {} as HandlerContext<{ tenantId: string }>;

  // This remains intentionally permissive because inline handlers do not carry
  // a local route map that distinguishes module-owned params from mount params.
  ctx.reverse(".user");
  ctx.reverse(".user", { tenantId: "override" });
}

export {};
