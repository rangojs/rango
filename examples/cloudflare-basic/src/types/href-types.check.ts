/**
 * Type-level tests for href system
 * These tests verify that the href types work correctly at compile time.
 *
 * This file is type-checked by tsc to ensure the href system is properly typed.
 */

import type { Handler, HandlerContext } from "@rangojs/router";

// Test 1: ctx.href in handlers accepts valid route names
const testHandlerHref: Handler = (ctx) => {
  // Should work - valid route names from RegisteredRoutes
  const _homeUrl = ctx.href("home");
  const _aboutUrl = ctx.href("about");
  const _blogUrl = ctx.href("blog");

  // Should work - route with params
  const _blogPostUrl = ctx.href("blogPost", { slug: "hello-world" });
  const _featureUrl = ctx.href("featuresDetail", { slug: "routing" });

  // Should work - absolute route with dot notation (global lookup)
  const _absoluteUrl = ctx.href("some.nested.route");

  // Should work - path-based URL
  const _pathUrl = ctx.href("/api/data");

  return null;
};

// Test 2: Handler type with route pattern
const testParamHandler: Handler<"/blog/:slug"> = (ctx) => {
  // ctx.params should be typed
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

// Test 4: HandlerContext has typed href
type CheckCtxHref = HandlerContext<{ id: string }>["href"];
// Verify href is a function type that returns string
type _AssertHrefCallable = CheckCtxHref extends (
  name: string,
  params?: any,
) => string
  ? true
  : never;
const _checkHrefCallable: _AssertHrefCallable = true;

// Test 5: Verify that route names from global augmentation are available
// This relies on the global namespace augmentation in router.tsx
declare function testGlobalRoutes(): void;
if (false as boolean) {
  testGlobalRoutes();
  // If RegisteredRoutes is properly augmented, these should all type-check
  const ctx = {} as HandlerContext;
  ctx.href("/blog");
  ctx.href("about");
  ctx.href("blog");
  ctx.href("blogPost", { slug: "test" });
}

export {};
