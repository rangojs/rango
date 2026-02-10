/**
 * Type-level tests for reverse system
 * These tests verify that the reverse types work correctly at compile time.
 *
 * This file is type-checked by tsc to ensure the reverse system is properly typed.
 */

import type { Handler, HandlerContext } from "@rangojs/router";

// Test 1: ctx.reverse in handlers accepts route names
const testHandlerReverse: Handler<"/"> = (ctx) => {
  // Should work - ctx.reverse accepts any string for named route resolution
  const _homeUrl = ctx.reverse("home");
  const _aboutUrl = ctx.reverse("about");
  const _blogUrl = ctx.reverse("blog");

  // Should work - route with params
  const _blogPostUrl = ctx.reverse("blogPost", { slug: "hello-world" });
  const _featureUrl = ctx.reverse("featuresDetail", { slug: "routing" });

  // Should work - absolute route with dot notation (global lookup)
  const _absoluteUrl = ctx.reverse("some.nested.route");

  // Should work - path-based URL
  const _pathUrl = ctx.reverse("/api/data");

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

// Test 4: HandlerContext has typed reverse
type CheckCtxReverse = HandlerContext<{ id: string }>["reverse"];
// Verify reverse is a function type that returns string
type _AssertReverseCallable = CheckCtxReverse extends (
  name: string,
  params?: any,
) => string
  ? true
  : never;
const _checkReverseCallable: _AssertReverseCallable = true;

// Test 5: Verify ctx.reverse accepts various route name formats
// ctx.reverse is (name: string, params?) => string, accepts any route name
declare function testGlobalRoutes(): void;
if (false as boolean) {
  testGlobalRoutes();
  // ctx.reverse accepts any string - named routes resolve at runtime via server routeMap
  const ctx = {} as HandlerContext;
  ctx.reverse("/blog");
  ctx.reverse("about");
  ctx.reverse("blog");
  ctx.reverse("blogPost", { slug: "test" });
}

// =============================================================================
// Test 6: ScopedReverseFunction composability pattern
// =============================================================================
// This tests that included url modules can use scopedReverse with their own patterns
// to get type-safe reverse for just their local routes.
// UrlPatterns is only available from server (it requires server context)
import type { UrlPatterns } from "@rangojs/router";
// ScopedReverseFunction and ExtractParams are safe client types
import type { ScopedReverseFunction, ExtractParams } from "@rangojs/router";


// Simulate a local module's patterns type
// When you define: const myPatterns = urls(({ path }) => [...])
// The resulting type is: UrlPatterns<TEnv, { routeName: pattern }>
type LocalRoutes = {
  index: "/";
  detail: "/:slug";
  settings: "/settings";
};
type LocalPatternsType = UrlPatterns<unknown, LocalRoutes>;

// Type-level assertion: scopedReverse should extract local routes from UrlPatterns
type ExtractedReverse = LocalPatternsType extends UrlPatterns<any, infer TRoutes>
  ? ScopedReverseFunction<TRoutes>
  : never;

// Verify the extracted type is ScopedReverseFunction with our local routes
type _AssertExtractsLocalRoutes = ExtractedReverse extends ScopedReverseFunction<LocalRoutes>
  ? true
  : never;
const _checkExtractsLocalRoutes: _AssertExtractsLocalRoutes = true;

// Test 7: Local route name validation in ScopedReverseFunction
declare const localReverse: ScopedReverseFunction<LocalRoutes>;

// Valid local route without params
const _localIndex: string = localReverse("index");
const _localSettings: string = localReverse("settings");

// Valid local route with params
const _localDetail: string = localReverse("detail", { slug: "hello-world" });

// Absolute routes (dot notation) - allowed as escape hatch for cross-module
const _absoluteRoute: string = localReverse("shop.cart");

// Path-based URLs - allowed as escape hatch
const _pathBased: string = localReverse("/api/data");

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
// Each module can use scopedReverse<typeof itsPatterns>(ctx.reverse) with local routes
type BlogRoutes = { index: "/"; post: "/:postId" };
type ShopRoutes = { index: "/"; cart: "/cart"; product: "/product/:sku" };

type BlogReverse = ScopedReverseFunction<BlogRoutes>;
type ShopReverse = ScopedReverseFunction<ShopRoutes>;

declare const blogReverse: BlogReverse;
declare const shopReverse: ShopReverse;

// Blog module components use blog routes
const _blogIndex: string = blogReverse("index");
const _blogPost: string = blogReverse("post", { postId: "123" });

// Shop module components use shop routes
const _shopIndex: string = shopReverse("index");
const _shopCart: string = shopReverse("cart");
const _shopProduct: string = shopReverse("product", { sku: "SKU-001" });

// Cross-module navigation uses absolute names
const _toBlog: string = shopReverse("blog.post", { postId: "abc" });
const _toShop: string = blogReverse("shop.cart");

export {};
