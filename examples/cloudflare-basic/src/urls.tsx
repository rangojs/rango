import { urls, type ResponseHandlerContext } from "@rangojs/router/server";
import { NavLayout } from "./components/NavLayout.js";
import { RootLayout } from "./components/SlowRootLayout.js";
import { FeatureLoading } from "./components/FeatureLoading.js";
import { BlogSidebarLoader } from "./loaders/blog.js";
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
import { ApiDemoPage } from "./pages/api-demo.js";
import { SearchPage } from "./pages/search.js";

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(
  ({ path, layout, parallel, loader, loading, cache, include }) => [
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
    layout(<RootLayout />, () => [
      // Global navigation layout
      layout(<NavLayout />, () => [
        // Core routes
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
        path("/counter", CounterPage, { name: "counter" }),
        path("/api-demo", ApiDemoPage, { name: "apiDemo" }),

        // Search route with typed search params
        path("/search", SearchPage, { name: "search", search: { q: "string", page: "number?", sort: "string?" } }),
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
      ]),
    ]),
  ],
);
