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

export {};
