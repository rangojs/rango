import { urls, cookies, type ResponseHandlerContext } from "@rangojs/router";
import { NavLayout } from "./components/NavLayout.js";
import { RootLayout } from "./components/SlowRootLayout.js";
import { FeatureLoading } from "./components/FeatureLoading.js";
import { BlogSidebarLoader } from "./loaders/blog.js";
import { CookieOverlayLoader } from "./loaders/cookie-overlay.js";
import { apiPatterns } from "./api/urls.js";

// Page handlers
import { HomePage } from "./pages/home.js";
import { AboutPage } from "./pages/about.js";
import { CounterPage } from "./pages/counter.js";
import { FeatureDetailPage } from "./pages/features.js";
import {
  BlogLayout,
  BlogSidebarHandler,
  SidebarSkeleton,
  BlogIndexPage,
  BlogPostPage,
} from "./pages/blog.js";
import {
  ProactiveCacheLayout,
  ProactiveCacheIndexPage,
  ProactiveCacheItemAPage,
  ProactiveCacheItemBPage,
} from "./pages/proactive-cache.js";
import { DocumentCachePage } from "./pages/document-cache.js";
import { SlowCachePage } from "./pages/slow-cache.js";
import { ThemePage } from "./pages/theme.js";
import { SlowPage1, SlowPage2, FastPage } from "./pages/slow.js";
import {
  InlineIndexPage,
  InlineDocsPage,
  InlinePricingPage,
} from "./pages/inline.js";
import { articlesPatterns } from "./pages/articles.js";
import { guidesPatterns } from "./pages/guides.js";
import { releasesPatterns } from "./pages/releases.js";
import { staticContentPatterns } from "./pages/static-content-urls.js";
import { ApiDemoPage } from "./pages/api-demo.js";
import { SearchPage } from "./pages/search.js";
import { transformCasesPatterns } from "./pages/transform-cases.js";
import { compositionPatterns } from "./pages/composition.js";
import { buildSkipPatterns } from "./pages/build-skip.js";
import { prerenderCtxPatterns } from "./pages/prerender-ctx.js";
import { createDocsPatterns } from "@shared/docs";
import { docsArticles } from "./docs-content.js";
import {
  LocaleInfoPage,
  ItemDetailPage,
  ProductReviewsPage,
  CatchAllPage,
} from "./pages/trie-routing-test.js";
import { CookieOverlayPage } from "./pages/cookie-overlay.js";
import { ActionLocationStatePage } from "./pages/action-location-state.js";

const docsPatterns = createDocsPatterns({ articles: docsArticles });

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(
  ({ path, layout, parallel, loader, loading, cache, include, middleware }) => [
    // API routes (response routes - skip RSC pipeline)
    include("/api", apiPatterns, { name: "api" }),

    // robots.txt (response route)
    path.text(
      "/robots.txt",
      (ctx: ResponseHandlerContext) => {
        return new Response("User-agent: *\nAllow: /\nDisallow: /api/\n", {
          headers: { "Content-Type": "text/plain" },
        });
      },
      { name: "robots" },
    ),

    // Cached response routes: test cache() with CFCacheStore across MIME types
    cache({ ttl: 600 }, () => [
      path.json(
        "/test/cached-json",
        () => ({ source: "cached-json", ts: Date.now() }),
        { name: "testCachedJson" },
      ),
      path.text("/test/cached-text", () => `text:${Date.now()}`, {
        name: "testCachedText",
      }),
      path.xml(
        "/test/cached-xml",
        () => `<root><ts>${Date.now()}</ts></root>`,
        { name: "testCachedXml" },
      ),
      path.html(
        "/test/cached-html",
        () => `<h1 data-ts="${Date.now()}">cached</h1>`,
        { name: "testCachedHtml" },
      ),
    ]),

    // Uncached control route for comparison
    path.json(
      "/test/uncached-json",
      () => ({ source: "uncached-json", ts: Date.now() }),
      { name: "testUncachedJson" },
    ),

    // Content negotiation test routes (same URL, different response types)
    path.json(
      "/test/negotiate",
      (ctx) => ({
        format: "json",
        negotiated: true,
      }),
      { name: "testNegotiateJson" },
    ),
    path("/test/negotiate", () => <div>HTML version</div>, {
      name: "testNegotiate",
    }),

    // Content negotiation: text
    path("/test/negotiate-text", () => <div>Text HTML version</div>, {
      name: "testNegotiateText",
    }),
    path.text("/test/negotiate-text", () => "plain text response", {
      name: "testNegotiateTextApi",
    }),

    // Content negotiation: xml
    path("/test/negotiate-xml", () => <div>XML HTML version</div>, {
      name: "testNegotiateXml",
    }),
    path.xml("/test/negotiate-xml", () => "<item><status>ok</status></item>", {
      name: "testNegotiateXmlApi",
    }),

    // Content negotiation: multiple response types on same path
    path.json("/test/negotiate-multi", () => ({ format: "json" }), {
      name: "testNegotiateMultiJson",
    }),
    path.text("/test/negotiate-multi", () => "plain text", {
      name: "testNegotiateMultiText",
    }),
    path.xml(
      "/test/negotiate-multi",
      () => "<root><format>xml</format></root>",
      { name: "testNegotiateMultiXml" },
    ),
    path("/test/negotiate-multi", () => <div>Multi HTML version</div>, {
      name: "testNegotiateMulti",
    }),

    // Content negotiation: wildcard route
    path.json(
      "/test/negotiate-wild/*",
      (ctx) => ({
        format: "json",
        wildcard: (ctx.params as Record<string, string>)["*"],
      }),
      { name: "testNegotiateWildJson" },
    ),
    path("/test/negotiate-wild/*", () => <div>Wildcard HTML</div>, {
      name: "testNegotiateWild",
    }),

    // MIME type test routes (one per tag, used by e2e tests)
    path.json("/test/mime/json", () => ({ type: "json" }), {
      name: "testMimeJson",
    }),
    path.text("/test/mime/text", () => "hello text", { name: "testMimeText" }),
    path.html("/test/mime/html", () => "<h1>hello html</h1>", {
      name: "testMimeHtml",
    }),
    path.xml("/test/mime/xml", () => "<root><type>xml</type></root>", {
      name: "testMimeXml",
    }),
    path.image(
      "/test/mime/image",
      () => {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { "Content-Type": "image/png" },
        });
      },
      { name: "testMimeImage" },
    ),
    path.stream(
      "/test/mime/stream",
      () => {
        return new Response("stream data", {
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
      { name: "testMimeStream" },
    ),
    path.any(
      "/test/mime/any",
      () => {
        return new Response("custom", {
          headers: { "Content-Type": "application/x-custom" },
        });
      },
      { name: "testMimeAny" },
    ),
    // Trie routing bug test routes (constraint fallback + param name collision)
    path("/:locale(en|fr)/info", LocaleInfoPage, { name: "localeInfo" }),
    path("/item/:itemId/detail", ItemDetailPage, { name: "itemDetail" }),
    path("/item/:productId/reviews", ProductReviewsPage, {
      name: "productReviews",
    }),
    path("/*", CatchAllPage, { name: "catchAll" }),

    layout(<RootLayout />, () => [
      // Global navigation layout
      layout(<NavLayout />, () => [
        // Core routes
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
        path("/counter", CounterPage, { name: "counter" }),
        path("/api-demo", ApiDemoPage, { name: "apiDemo" }),

        // Search route with typed search params
        path("/search", SearchPage, {
          name: "search",
          search: { q: "string", page: "number?", sort: "string?" },
        }),
        path(
          "/features/:slug",
          FeatureDetailPage,
          { name: "featuresDetail" },
          () => [loading(<FeatureLoading />)],
        ),

        // Blog routes with sidebar
        layout(BlogLayout, () => [
          parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),

          cache({ ttl: 60, swr: 300 }, () => [
            path("/blog", BlogIndexPage, { name: "blog" }),
            path("/blog/:slug", BlogPostPage, { name: "blogPost" }),
          ]),
        ]),

        // Proactive cache routes
        cache({ ttl: 600 }, () => [
          layout(<ProactiveCacheLayout />, () => [
            path("/proactive-cache", ProactiveCacheIndexPage, {
              name: "proactiveCache",
            }),
            path("/proactive-cache/item-a", ProactiveCacheItemAPage, {
              name: "proactiveCacheItemA",
            }),
            path("/proactive-cache/item-b", ProactiveCacheItemBPage, {
              name: "proactiveCacheItemB",
            }),
          ]),
        ]),
        // Document cache route
        path("/document-cache", DocumentCachePage, { name: "documentCache" }),

        // Slow cache route
        cache({ ttl: 60, swr: 300 }, () => [
          path("/slow-cache", SlowCachePage, { name: "slowCache" }),
        ]),

        // Theme route
        path("/theme", ThemePage, { name: "theme" }),

        // Cookie overlay test route
        path(
          "/cookie-overlay",
          CookieOverlayPage,
          { name: "cookieOverlay" },
          () => [
            middleware(async (ctx, next) => {
              cookies().set("mw-overlay", "from-middleware", { path: "/" });
              return next();
            }),
            loader(CookieOverlayLoader),
          ],
        ),

        // Action location state test route (non-redirect flow)
        path("/action-location-state", ActionLocationStatePage, {
          name: "actionLocationState",
        }),

        // Slow routes for navigation progress demo
        // /slow/1 uses handler pattern (blocks) - for testing
        // /slow/2 uses component pattern (streams)
        path("/slow/1", SlowPage1, { name: "slow1" }),
        path("/slow/2", () => <SlowPage2 />, { name: "slow2" }),
        path("/slow/fast", FastPage, { name: "fast" }),

        // Inline routes demo
        path("/inline", InlineIndexPage, { name: "inlineIndex" }),
        path("/inline/docs", InlineDocsPage, { name: "inlineDocs" }),
        path("/inline/pricing", InlinePricingPage, { name: "inlinePricing" }),
        // Pre-rendered articles (static content, build-time rendering)
        include("/articles", articlesPatterns, { name: "articles" }),

        // Pre-rendered guides with passthrough (known slugs pre-rendered, unknown slugs live)
        include("/guides", guidesPatterns, { name: "guides" }),

        // Pre-rendered releases page (uses node:fs at build time, evicted at deploy)
        include("/releases", releasesPatterns, { name: "releases" }),

        // Static content (Static: layout + index rendered once at build time)
        include("/static-content", staticContentPatterns, {
          name: "staticContent",
        }),

        // Composable docs package (demonstrates include + factory pattern)
        include("/docs", docsPatterns, { name: "docs" }),

        // Transform coverage routes (alias imports + export specifiers)
        include("/transform-cases", transformCasesPatterns, {
          name: "transformCases",
        }),

        // Composition test routes (globally imported helpers)
        include("/composition", compositionPatterns, {
          name: "composition",
        }),

        // Skip test routes (prerender + static skip/error handling)
        include("/build-skip", buildSkipPatterns, { name: "buildSkip" }),
        include("/prerender-ctx", prerenderCtxPatterns, {
          name: "prerenderCtx",
        }),

        // Prerender manifest introspection for e2e tests
        path.json(
          "/__test/prerender-manifest-entries",
          async (ctx) => {
            const routeName = ctx.searchParams.get("route");
            if (!routeName) return { error: "missing route param" };
            const manifest = globalThis.__PRERENDER_MANIFEST;
            if (!manifest) return { available: false, count: 0 };
            const keys = Object.keys(manifest).filter((k) =>
              k.startsWith(routeName + "/"),
            );
            return { available: true, count: keys.length };
          },
          { name: "testPrerenderManifestEntries" },
        ),
      ]),
    ]),
  ],
);
