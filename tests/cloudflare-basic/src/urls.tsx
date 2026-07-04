import { urls, updateTag, revalidateTag, Meta, nonce } from "@rangojs/router";
import { Suspense } from "react";
import { Link, Outlet } from "@rangojs/router/client";
import { StreamTest } from "./components/StreamTest.js";
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
import {
  PprShellLayout,
  PprShellPricePage,
  PprShellStreamPage,
  PprTrapChromeLayout,
  PprBareHomePage,
  PprSlotChromeLayout,
  PprSlotHomePage,
} from "./pages/ppr-shell.js";
import { PprShellBadge } from "./components/PprShellBadge.js";
import {
  PprShellPriceLoader,
  PprShellStreamLoader,
  PprChromeLoader,
  PprBadgeLoader,
} from "./loaders/ppr-shell.js";
import { PprDriftLayout, PprDriftPricePage } from "./pages/ppr-drift.js";
import { OrphanFetchTest } from "./components/OrphanFetchTest.js";
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
import { SwrCtxPage, SwrActionPage } from "./pages/swr-ctx.js";
import { ThemePage } from "./pages/theme.js";
import { SlowPage1, SlowPage2, FastPage } from "./pages/slow.js";
import {
  InlineIndexPage,
  InlineDocsPage,
  InlinePricingPage,
} from "./pages/inline.js";
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
import { txWhenPatterns } from "./pages/tx-when.js";
import { deferredHandleNavPatterns } from "./pages/deferred-handle-nav.js";
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
        // PPR shell caching (docs/design/ppr-shell-resume.md). Opt-in per PAGE
        // ROUTE via the `ppr` path option — serving is integral to the router
        // (no middleware); the shell store is the app CFCacheStore (KV-backed
        // getShell/putShell) from createRouter({ cache }).
        // Shell = PprShellLayout (static text + counter + handle reads + the
        // physics fallback); STRUCTURAL hole = the price route behind loading()
        // (LoaderBoundary is the Suspense boundary capture postpones at);
        // PHYSICS hole = the pending handler promise under PprShellPhysicsValue's
        // own Suspense. A loader route without loading() awaits its loader at
        // tree-build and can never produce a shell — the /ppr-shell/no-hole
        // negative below. See pages/ppr-shell.tsx.
        layout(PprShellLayout, () => [
          path(
            "/ppr-shell",
            PprShellPricePage,
            { name: "pprShell", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-price-fallback">Loading price...</div>,
              ),
            ],
          ),
          // Loader-carried promise WITH loading(): the loading() boundary is the
          // hole. On a HIT the resume streams three layers in one body — cached
          // shell, then the outer loader value + the inner Suspense fallback,
          // then the nested-promise inner value + $RC.
          path(
            "/ppr-shell/stream",
            PprShellStreamPage,
            { name: "pprShellStream", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellStreamLoader),
              loading(
                <div data-testid="ppr-stream-fallback">Loading stream...</div>,
              ),
            ],
          ),
          // Same loader/component, ppr DECLARED, but NO loading(): the
          // loading-less branch awaits loader data at tree-build, so capture's
          // masked loader pins the tree and the sanity gate refuses —
          // x-rango-shell stays MISS forever. The nested inner promise still
          // streams under axis 1 (no loading() degrades only the caching, never
          // the route).
          path(
            "/ppr-shell/no-hole",
            PprShellStreamPage,
            { name: "pprShellNoHole", ppr: true },
            () => [loader(PprShellStreamLoader)],
          ),
        ]),
        // LAYOUT-LOADER shapes (the storefront): the layout registers a
        // loader with NO loading() on the LAYOUT — the BAKE lane
        // (docs/design/loader-container-bake.md). PprChromeLoader executes at
        // capture, its container bakes (snapshot-pinned on HITs), and both
        // children HIT; the loader child keeps its price hole on the LIVE
        // lane behind loading(). See pages/ppr-shell.tsx.
        layout(PprTrapChromeLayout, () => [
          loader(PprChromeLoader),
          path(
            "/ppr-shell/layout-loader",
            PprShellPricePage,
            { name: "pprShellLayoutLoader", ppr: true },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-trap-price-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
          // The literal storefront-homepage shape: a BARE ppr route (no
          // loader, no loading(), no use list at all) under the
          // loader-registering layout.
          path("/ppr-shell/layout-loader-bare", PprBareHomePage, {
            name: "pprShellLayoutLoaderBare",
            ppr: true,
          }),
        ]),
        // LIVE-lane alternative (skills/ppr "layout-with-loaders playbook"):
        // the same chrome data owned by a @badge parallel slot with its OWN
        // loading() — a badge-sized GUARANTEED-fresh hole (the bake lane
        // would pin the value for the shell's lifetime). Chrome + static page
        // bake; the route needs no loader or loading() of its own.
        layout(PprSlotChromeLayout, () => [
          parallel({
            "@badge": {
              handler: () => <PprShellBadge loader={PprBadgeLoader} />,
              use: () => [
                loader(PprBadgeLoader),
                loading(
                  <span data-testid="ppr-badge-fallback">
                    badge pending...
                  </span>,
                ),
              ],
            },
          }),
          path("/ppr-shell/slot-hole", PprSlotHomePage, {
            name: "pprShellSlotHole",
            ppr: true,
          }),
        ]),
        // Capture-data-snapshot DRIFT route: the shell bakes a value from a
        // short-ttl cache() (getPprDriftStamp, "drift" profile, ttl 2s); the
        // shell's own ttl is 300. After the inner ttl expires, a HIT must still
        // show the CAPTURE-time stamp (seeded from the snapshot) — byte parity
        // with the frozen prelude — while the price loader hole stays live. See
        // docs/design/ppr-shell-resume.md ("the capture data snapshot").
        layout(PprDriftLayout, () => [
          path(
            "/ppr-drift",
            PprDriftPricePage,
            { name: "pprDrift", ppr: { ttl: 300, swr: 120 } },
            () => [
              loader(PprShellPriceLoader),
              loading(
                <div data-testid="ppr-drift-price-fallback">
                  Loading price...
                </div>,
              ),
            ],
          ),
        ]),
        // Per-request nonce via the `nonce` ContextVar TOKEN in route middleware
        // (issue #656). A shell is shared per host+URL, so baking one request's
        // nonce into it would break CSP for every other visitor. A ppr route with
        // an active per-request nonce — provider OR token — must stay on axis 1
        // (no PPR participation, no x-rango-shell header) with a once-per-key
        // worker warning. The commit-point gate reads the token AFTER the route
        // middleware runs; before the fix it saw only the provider-threaded nonce
        // and this route wrongly entered capture, freezing one nonce for all. The
        // layout reads ctx.get(nonce) into the SHELL region (above the loading()
        // hole) so each MISS carries a DISTINCT nonce. Middleware is scoped to THIS
        // subtree, not global, so it gates only this route and leaves the other
        // ppr fixtures capturable.
        middleware(
          async (ctx, next) => {
            ctx.set(nonce, crypto.randomUUID());
            return next();
          },
          () => [
            layout(
              (ctx) => {
                const requestNonce = ctx.get(nonce);
                return (
                  <main data-testid="ppr-nonce-page">
                    <h1 data-testid="ppr-nonce-header">PPR Nonce Demo</h1>
                    <span
                      data-testid="ppr-nonce-value"
                      data-nonce={requestNonce ?? "(none)"}
                    />
                    <Outlet />
                  </main>
                );
              },
              () => [
                path(
                  "/ppr-nonce",
                  PprShellPricePage,
                  { name: "pprNonce", ppr: { ttl: 300, swr: 120 } },
                  () => [
                    loader(PprShellPriceLoader),
                    loading(
                      <div data-testid="ppr-nonce-price-fallback">
                        Loading price...
                      </div>,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        // Orphan fetchable loader: loader reachable only via a client import,
        // never registered with loader(), never imported by the worker entry.
        path("/orphan-fetch", () => <OrphanFetchTest />, {
          name: "orphanFetch",
        }),
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

        // #642 regression guard: a NAME-LESS 3-arg children-fn route
        // (path(pattern, component, () => [...]) with no { name } options).
        // Before the ExtractRoutes widened-name fix, this form let TName infer
        // to the bare `string` constraint, emitting an index signature that
        // collapsed the ENTIRE app route map: this app registers
        // `RegisteredRoutes extends typeof router.routeMap`, so Rango.Path
        // became `never` and every href()/Link.to in the app failed to
        // typecheck. Kept unnamed on purpose; its presence keeps this app's
        // `pnpm typecheck` an end-to-end guard. Reachable by URL only.
        path(
          "/unnamed-children-fn",
          () => (
            <div data-testid="unnamed-children-fn-route">
              unnamed children-fn route works
            </div>
          ),
          () => [loading(<FeatureLoading />)],
        ),

        // Blog routes with sidebar. Deliberately NOT ppr'd: keeping /blog on
        // axis 1 keeps the classic blog-cache suite (sidebar-preserve, index
        // render, document-cache interplay) isolated from any PPR capture
        // interference. The PPR'd twin of this exact shape is /ppr-blog below.
        layout(BlogLayout, () => [
          parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),

          cache({ ttl: 60, swr: 300 }, () => [
            middleware((ctx, next) => {
              // ctx.header(
              //   "Cache-Control",
              //   "s-maxage=60, stale-while-revalidate=300",
              // );
              return next();
            }),
            path("/blog", BlogIndexPage, {
              name: "blog",
            }),
            path("/blog/:slug", BlogPostPage, {
              name: "blogPost",
            }),
          ]),
        ]),

        // PPR'd DUPLICATE of the blog: the realistic PPR shape (sidebar
        // parallel, ring-3 cache() segment with a rendered timestamp) under the
        // SAME components/loaders as /blog, but with the `ppr` path option. The
        // capture data snapshot pins the ring-3 content so a HIT hydrates
        // cleanly even after the ttl-60 refresh; /blog itself stays non-ppr so
        // the classic blog-cache suite is isolated from capture interference.
        // See docs/design/ppr-shell-resume.md ("the capture data snapshot").
        layout(BlogLayout, () => [
          parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),

          cache({ ttl: 60, swr: 300 }, () => [
            path("/ppr-blog", BlogIndexPage, {
              name: "pprBlog",
              ppr: { ttl: 300, swr: 120 },
            }),
            path("/ppr-blog/:slug", BlogPostPage, {
              name: "pprBlogPost",
              ppr: { ttl: 300, swr: 120 },
            }),
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

        // SWR + getRequestContext() regression: a "use cache: swr-ctx" function
        // (ttl=2s) that reads getRequestContext().env inside its body. On the
        // stale background revalidation the request-context ALS must be
        // re-established or getRequestContext() throws on workerd and the cached
        // value freezes. See pages/swr-ctx.tsx.
        path("/swr-ctx", SwrCtxPage, { name: "swrCtx" }),

        // foregroundOnAction opt-in: a "use cache: swr-action" function whose
        // profile sets foregroundOnAction:true. A plain navigation keeps SWR, but
        // a server action's revalidation render re-executes a stale entry in the
        // foreground so the action response shows a fresh value.
        path("/swr-action", SwrActionPage, { name: "swrAction" }),

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

        // Streaming repro: INLINE handlers (matching the user's repro form)
        // that return immediately and stream a component-placed <Suspense> via
        // a server promise (no router loading()). The fallback must show on a
        // cold client nav.
        path(
          "/stream-test",
          () => (
            <div data-testid="stream-test-index">
              <p>Stream test index</p>
              <ul>
                <li>
                  <Link to="/stream-test/1">Go to stream-test/1</Link>
                </li>
                <li>
                  <Link to="/stream-test/2">Go to stream-test/2</Link>
                </li>
              </ul>
            </div>
          ),
          { name: "streamTestIndex" },
        ),
        path(
          "/stream-test/:id",
          async (ctx) => {
            const data = new Promise<string>((resolve) =>
              setTimeout(() => resolve("resolved " + ctx.params.id), 3000),
            );

            ctx.use(Meta)(
              data.then((d) => ({
                title: `Test with ID ${ctx.params.id}: ${d}`,
              })),
            );

            return (
              <div data-testid="stream-test-page">
                <p data-testid="stream-test-id">Test with ID {ctx.params.id}</p>
                <ul>
                  <li>
                    <Link to="/stream-test">Back to index</Link>
                  </li>
                  <li>
                    <Link to="/stream-test/1">Go to stream-test/1</Link>
                  </li>
                  <li>
                    <Link to="/stream-test/2">Go to stream-test/2</Link>
                  </li>
                </ul>
                <Suspense
                  fallback={
                    <div data-testid="stream-test-fallback">Loading...</div>
                  }
                >
                  <StreamTest data={data} />
                </Suspense>
              </div>
            );
          },
          { name: "streamTestDetail" },
        ),

        // Inline routes demo
        path("/inline", InlineIndexPage, { name: "inlineIndex" }),
        path("/inline/docs", InlineDocsPage, { name: "inlineDocs" }),
        path("/inline/pricing", InlinePricingPage, { name: "inlinePricing" }),
        // Pre-rendered articles (static content, build-time rendering)
        include("/articles", () => import("./pages/articles.js"), {
          name: "articles",
        }),

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
        // transition({ when }) conditional-gate coverage (mirrors the router
        // e2e app's /tx-when/:hold/:n).
        include("/", txWhenPatterns, { name: "" }),

        // Deferred-handle navigation contract + history-cache fixes
        // (#622 follow-ups), exercised through client (soft) navigation under
        // the workerd runtime.
        include("/", deferredHandleNavPatterns, { name: "" }),

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
