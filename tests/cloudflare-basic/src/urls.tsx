import { urls, updateTag, revalidateTag } from "@rangojs/router";
import { NavLayout } from "./components/NavLayout.js";
import { RootLayout } from "./components/SlowRootLayout.js";
import { FeatureLoading } from "./components/FeatureLoading.js";
import { BlogSidebarLoader } from "./loaders/blog.js";
import { CookieOverlayLoader } from "./loaders/cookie-overlay.js";
import { setOverlayCookie } from "./middleware/cookie-overlay.js";
import { apiPatterns } from "./api/urls.js";

// Page handlers
import { HomePage } from "./pages/home.js";
import { AboutPage } from "./pages/about.js";
import { ScriptsDemoPage } from "./pages/scripts-demo.js";
import { CounterPage } from "./pages/counter.js";
import { RenderStabilityRoute } from "./pages/render-stability.js";
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
import { DocumentCacheNoCachePage } from "./pages/document-cache-no-cache.js";
import { TaggedDocumentPage } from "./pages/tagged-document.js";
import { StreamedDocumentPage } from "./pages/streamed-document.js";
import { DslTaggedDocumentPage } from "./pages/dsl-tagged-document.js";
import { CachedHandlesPage } from "./pages/cached-handles.js";
import { SlowCachePage } from "./pages/slow-cache.js";
import { ThemePage } from "./pages/theme.js";
import { SlowPage1, SlowPage2, FastPage } from "./pages/slow.js";
import {
  InlineIndexPage,
  InlineDocsPage,
  InlinePricingPage,
} from "./pages/inline.js";
import { articlesPatterns } from "./pages/articles.js";
import { clientReversePatterns } from "./pages/client-reverse.js";
import { guidesPatterns } from "./pages/guides.js";
import { releasesPatterns } from "./pages/releases.js";
import { staticContentPatterns } from "./pages/static-content-urls.js";
import { ApiDemoPage } from "./pages/api-demo.js";
import { SearchPage } from "./pages/search.js";
import { transformCasesPatterns } from "./pages/transform-cases.js";
import { compositionPatterns } from "./pages/composition.js";
import { buildSkipPatterns } from "./pages/build-skip.js";
import { prerenderCtxPatterns } from "./pages/prerender-ctx.js";
import { handlerFirstPatterns } from "./pages/handler-first.js";
import { createDocsPatterns } from "@shared/docs";
import { docsArticles } from "./docs-content.js";
import {
  LocaleInfoPage,
  ItemDetailPage,
  ProductReviewsPage,
  CatchAllPage,
  FilesWildcardPage,
} from "./pages/trie-routing-test.js";
import {
  ShopProductPage,
  ShopCategoryPage,
  ShopArchivePage,
} from "./pages/suffix-params-test.js";
import { CookieOverlayPage } from "./pages/cookie-overlay.js";
import { buildEnvPatterns } from "./pages/build-env-handler.js";
import { buildEnvDirectPatterns } from "./pages/build-env-direct-handler.js";
import { ActionLocationStatePage } from "./pages/action-location-state.js";
import { renderedBarrierPatterns } from "./pages/rendered-barrier.js";
import { prefetchTransitionPatterns } from "./pages/prefetch-transition.js";
import { onErrorLog, clearOnErrorLog } from "./error-log.js";

const docsPatterns = createDocsPatterns({ articles: docsArticles });

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(
  ({
    path,
    layout,
    parallel,
    loader,
    loading,
    cache,
    include,
    middleware,
    transition,
  }) => [
    // API routes (response routes - skip RSC pipeline)
    include("/api", apiPatterns, { name: "api" }),

    // Test utils: read the onError log (non-destructive). Imports from
    // error-log.js (not router.js) so the read uses a static import and avoids
    // the dynamic-import / module-graph race that can return an empty log.
    path.json(
      "/__test/last-error",
      () => (onErrorLog.length > 0 ? [...onErrorLog] : null),
      { name: "testLastError" },
    ),
    // Test utils: clear the onError log.
    path.json(
      "/__test/clear-error-log",
      () => {
        clearOnErrorLog();
        return { cleared: true };
      },
      { name: "testClearErrorLog" },
    ),

    // robots.txt (response route)
    path.text(
      "/robots.txt",
      (ctx) => {
        return new Response("User-agent: *\nAllow: /\nDisallow: /api/\n", {
          headers: { "Content-Type": "text/plain" },
        });
      },
      { name: "robots" },
    ),

    // Tag-based invalidation against the real CFCacheStore (KV-backed markers).
    // The tagged route caches a ts; the invalidate route awaits updateTag so the
    // next read is fresh (read-your-own-writes).
    cache({ ttl: 600, tags: ["cf-items"] }, () => [
      path.json("/test/tagged-json", () => ({ ts: Date.now() }), {
        name: "testTaggedJson",
      }),
    ]),
    // Second tagged route under a DIFFERENT tag, to prove cross-tag isolation:
    // invalidating "cf-items" must leave "cf-items-b" entries intact.
    cache({ ttl: 600, tags: ["cf-items-b"] }, () => [
      path.json("/test/tagged-json-b", () => ({ ts: Date.now() }), {
        name: "testTaggedJsonB",
      }),
    ]),
    // Test fixture only: the tag comes from the URL param so the e2e can
    // exercise arbitrary tags. Never do this in production code - deriving
    // invalidation tags from untrusted input lets an attacker grow the
    // tag-marker namespace without bound (see
    // CFCacheStoreOptions.tagInvalidationTtl).
    path.json(
      "/test/invalidate-tag/:tag",
      async (ctx) => {
        await updateTag(ctx.params.tag);
        return { ok: true, tag: ctx.params.tag };
      },
      { name: "testInvalidateTag" },
    ),
    // revalidateTag: fire-and-forget (background via waitUntil), NOT awaited.
    // Test fixture only: the tag comes from the URL param so the e2e can
    // exercise arbitrary tags. Never do this in production code - deriving
    // invalidation tags from untrusted input lets an attacker grow the
    // tag-marker namespace without bound (see
    // CFCacheStoreOptions.tagInvalidationTtl).
    path.json(
      "/test/revalidate-tag/:tag",
      (ctx) => {
        revalidateTag(ctx.params.tag);
        return { ok: true, tag: ctx.params.tag };
      },
      { name: "testRevalidateTag" },
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

    // KV L2 test: read KV directly to verify cache writes land in L2
    path.json(
      "/test/kv-l2-check",
      async (ctx) => {
        const kv = ctx.env.KV;
        // List all keys with cache version prefix to check KV was populated
        const list = await kv.list({ limit: 50 });
        return {
          kvKeyCount: list.keys.length,
          kvKeys: list.keys.map((k: { name: string }) => k.name),
        };
      },
      { name: "testKvL2Check" },
    ),

    // KV L2 test: cached route with unique path for isolated testing
    cache({ ttl: 600 }, () => [
      path.json(
        "/test/kv-cached-json",
        () => ({ source: "kv-cached", ts: Date.now() }),
        { name: "testKvCachedJson" },
      ),
    ]),

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
    // Suffix param test routes (e.g. /shop/:productId.html)
    path("/shop/:productId.html", ShopProductPage, { name: "shopProduct" }),
    // Longer overlapping suffix declared AFTER `.html` to exercise the
    // longest-suffix-wins fix: /shop/x.archive.html must match here, not above.
    path("/shop/:slug.archive.html", ShopArchivePage, { name: "shopArchive" }),
    path("/shop/:categoryId", ShopCategoryPage, { name: "shopCategory" }),

    // Trie routing bug test routes (constraint fallback + param name collision)
    path("/:locale(en|fr)/info", LocaleInfoPage, { name: "localeInfo" }),
    path("/item/:itemId/detail", ItemDetailPage, { name: "itemDetail" }),
    path("/item/:productId/reviews", ProductReviewsPage, {
      name: "productReviews",
    }),
    include("/build-env", buildEnvPatterns, { name: "buildEnv" }),
    include("/build-env-direct", buildEnvDirectPatterns, {
      name: "buildEnvDirect",
    }),
    // Prefixed wildcard before the root catch-all: hitting bare "/files" must
    // resolve "/files/*" with an empty splat (C1), not fall to "/*".
    path("/files/*", FilesWildcardPage, { name: "filesWildcard" }),
    path("/*", CatchAllPage, { name: "catchAll" }),

    layout(<RootLayout />, () => [
      // Global navigation layout
      layout(<NavLayout />, () => [
        // Core routes
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
        path("/counter", CounterPage, { name: "counter" }),
        path("/render-stability/p/:id", RenderStabilityRoute, {
          name: "renderStability",
        }),
        path("/scripts-demo", ScriptsDemoPage, { name: "scriptsDemo" }),
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
          // transition() opts this route into same-route stale-while-revalidate:
          // navigating between /features/:slug values holds the current content
          // instead of flashing FeatureLoading. Cross-route navs (home ->
          // feature) still remount and may show the skeleton.
          () => [loading(<FeatureLoading />), transition()],
        ),

        // Blog routes with sidebar
        layout(BlogLayout, () => [
          parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),

          cache({ ttl: 60, swr: 300 }, () => [
            middleware((ctx, next) => {
              ctx.header(
                "Cache-Control",
                "s-maxage=60, stale-while-revalidate=300",
              );
              return next();
            }),
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

        // C3: document cache route whose response sets an unqualified
        // `Cache-Control: no-cache`. The document cache must refuse to store it
        // (never a frozen HIT), so the rendered timestamp re-executes every
        // request despite the accompanying s-maxage.
        path("/document-cache-no-cache", DocumentCacheNoCachePage, {
          name: "documentCacheNoCache",
        }),

        // Tagged document cache route: the full-page response is document-cached
        // AND tagged (via a "use cache" + cacheTag), so updateTag("doc-page")
        // invalidates the whole-page entry (exercises document-level tag flow).
        path("/tagged-document", TaggedDocumentPage, {
          name: "taggedDocument",
        }),

        // Like /tagged-document, but the cacheTag fires inside a Suspense
        // boundary (resolves during the stream, after handler settlement), so it
        // pins the document tag snapshot to the render-complete (stream-drain)
        // barrier rather than the handler-settlement barrier.
        path("/streamed-document", StreamedDocumentPage, {
          name: "streamedDocument",
        }),

        // Document-cached full page whose tag comes from a route-level
        // cache({ tags }) (the segment-DSL tag path), NOT a runtime cacheTag.
        // The segment write is scheduled via waitUntil, so this pins that the
        // route-level tag reaches the document tag union on the FIRST write and
        // updateTag("dsl-doc-page") invalidates the whole-page entry. Cache-Control
        // is set via middleware in-scope (the blog-route pattern) — a cache()-
        // wrapped component's own ctx.headers.set() does not reach the document
        // response. Unnamed: the e2e navigates by URL, no gen-file entry.
        cache({ ttl: 600, tags: ["dsl-doc-page"] }, () => [
          middleware((ctx, next) => {
            ctx.header(
              "Cache-Control",
              "s-maxage=60, stale-while-revalidate=300",
            );
            return next();
          }),
          path("/dsl-tagged-document", DslTaggedDocumentPage),
        ]),

        // Slow cache route
        cache({ ttl: 60, swr: 300 }, () => [
          path("/slow-cache", SlowCachePage, { name: "slowCache" }),
        ]),

        // Cached-handles regression route: a cache()-wrapped route whose handler
        // pushes a Promise<ReactNode> breadcrumb content that must survive the
        // cache round-trip (see pages/cached-handles.tsx).
        cache({ ttl: 60, swr: 300 }, () => [
          path("/cached-handles", CachedHandlesPage, { name: "cachedHandles" }),
        ]),

        // Theme route
        path("/theme", ThemePage, { name: "theme" }),

        // Cookie overlay test route
        path(
          "/cookie-overlay",
          CookieOverlayPage,
          { name: "cookieOverlay" },
          () => [middleware(setOverlayCookie), loader(CookieOverlayLoader)],
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

        // Client useReverse() coverage on the Cloudflare preset
        include("/cr/:tenantId", clientReversePatterns, { name: "cr" }),

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

        // Handler-first execution order test
        include("/handler-first", handlerFirstPatterns, {
          name: "handlerFirst",
        }),

        // Rendered barrier: loader reads handle data after ctx.rendered()
        include("/rendered-barrier", renderedBarrierPatterns, {
          name: "renderedBarrier",
        }),

        // #622 follow-up: fully-prefetched no-flash + client-mount-suspense
        // layout-hold regression (mirrors the router e2e app).
        include("/", prefetchTransitionPatterns, { name: "" }),

        // Prerender manifest introspection for e2e tests
        path.json(
          "/__test/prerender-manifest-entries",
          async (ctx) => {
            const routeName = ctx.searchParams.get("route");
            if (!routeName) return { error: "missing route param" };
            if (!globalThis.__loadPrerenderManifestModule)
              return { available: false, count: 0 };
            const mod = await globalThis.__loadPrerenderManifestModule();
            const keys = Object.keys(mod.default).filter((k) =>
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
