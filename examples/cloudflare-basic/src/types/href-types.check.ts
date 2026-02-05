/**
 * Type-level tests for href system
 * These tests verify that the href types work correctly at compile time.
 *
 * This file is type-checked by tsc to ensure the href system is properly typed.
 */

import type { Handler, HandlerContext } from "@rangojs/router";

// Test 1: ctx.href in handlers accepts route names
const testHandlerHref: Handler = (ctx) => {
  // Should work - ctx.href accepts any string for named route resolution
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

// Test 5: Verify ctx.href accepts various route name formats
// ctx.href is (name: string, params?) => string, accepts any route name
declare function testGlobalRoutes(): void;
if (false as boolean) {
  testGlobalRoutes();
  // ctx.href accepts any string - named routes resolve at runtime via server routeMap
  const ctx = {} as HandlerContext;
  ctx.href("/blog");
  ctx.href("about");
  ctx.href("blog");
  ctx.href("blogPost", { slug: "test" });
}

// =============================================================================
// Test 6: ScopedHrefFunction composability pattern
// =============================================================================
// This tests that included url modules can use scopedHref with their own patterns
// to get type-safe href for just their local routes.
// UrlPatterns is only available from server (it requires server context)
import type { UrlPatterns } from "@rangojs/router/server";
// ScopedHrefFunction and ExtractParams are safe client types
import type { ScopedHrefFunction, ExtractParams } from "@rangojs/router";

// Simulate a local module's patterns type
// When you define: const myPatterns = urls(({ path }) => [...])
// The resulting type is: UrlPatterns<TEnv, { routeName: pattern }>
type LocalRoutes = {
  index: "/";
  detail: "/:slug";
  settings: "/settings";
};
type LocalPatternsType = UrlPatterns<unknown, LocalRoutes>;

// Type-level assertion: scopedHref should extract local routes from UrlPatterns
type ExtractedHref = LocalPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedHrefFunction<TRoutes>
  : never;

// Verify the extracted type is ScopedHrefFunction with our local routes
type _AssertExtractsLocalRoutes = ExtractedHref extends ScopedHrefFunction<LocalRoutes>
  ? true
  : never;
const _checkExtractsLocalRoutes: _AssertExtractsLocalRoutes = true;

// Test 7: Local route name validation in ScopedHrefFunction
declare const localHref: ScopedHrefFunction<LocalRoutes>;

// Valid local route without params
const _localIndex: string = localHref("index");
const _localSettings: string = localHref("settings");

// Valid local route with params
const _localDetail: string = localHref("detail", { slug: "hello-world" });

// Absolute routes (dot notation) - allowed as escape hatch for cross-module
const _absoluteRoute: string = localHref("shop.cart");

// Path-based URLs - allowed as escape hatch
const _pathBased: string = localHref("/api/data");

// Test 8: ExtractParams extracts correct params from patterns
type IndexParams = ExtractParams<LocalRoutes["index"]>;
type DetailParams = ExtractParams<LocalRoutes["detail"]>;
type SettingsParams = ExtractParams<LocalRoutes["settings"]>;

type _AssertIndexHasNoParams = keyof IndexParams extends never ? true : never;
const _checkIndexHasNoParams: _AssertIndexHasNoParams = true;

type _AssertDetailHasSlug = DetailParams extends { slug: string } ? true : never;
const _checkDetailHasSlug: _AssertDetailHasSlug = true;

type _AssertSettingsHasNoParams = keyof SettingsParams extends never ? true : never;
const _checkSettingsHasNoParams: _AssertSettingsHasNoParams = true;

// Test 9: Composability - multiple independent url modules
// Each module can use scopedHref<typeof itsPatterns>(ctx.href) with local routes
type BlogRoutes = { index: "/"; post: "/:postId" };
type ShopRoutes = { index: "/"; cart: "/cart"; product: "/product/:sku" };

type BlogHref = ScopedHrefFunction<BlogRoutes>;
type ShopHref = ScopedHrefFunction<ShopRoutes>;

declare const blogHref: BlogHref;
declare const shopHref: ShopHref;

// Blog module components use blog routes
const _blogIndex: string = blogHref("index");
const _blogPost: string = blogHref("post", { postId: "123" });

// Shop module components use shop routes
const _shopIndex: string = shopHref("index");
const _shopCart: string = shopHref("cart");
const _shopProduct: string = shopHref("product", { sku: "SKU-001" });

// Cross-module navigation uses absolute names
const _toBlog: string = shopHref("blog.post", { postId: "abc" });
const _toShop: string = blogHref("shop.cart");

export {};
