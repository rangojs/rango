import { urls } from "@rangojs/router/server";
import { NavLayout } from "./components/NavLayout.js";
import { RootLayout } from "./components/SlowRootLayout.js";
import { FeatureLoading } from "./components/FeatureLoading.js";
import { BlogSidebarLoader } from "./loaders/blog.js";

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
import { InlineIndexPage, InlineDocsPage, InlinePricingPage } from "./pages/inline.js";

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(({ path, layout, parallel, loader, loading, cache }) => [
  // Global navigation layout
  layout(<NavLayout />, () => [
    // Core routes
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
    path("/counter", CounterPage, { name: "counter" }),
    path("/features/:slug", FeatureDetailPage, { name: "featuresDetail" }, () => [
      loading(<FeatureLoading />),
    ]),

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
        path("/proactive-cache", ProactiveCacheIndexPage, { name: "proactiveCache" }),
        path("/proactive-cache/item-a", ProactiveCacheItemAPage, { name: "proactiveCacheItemA" }),
        path("/proactive-cache/item-b", ProactiveCacheItemBPage, { name: "proactiveCacheItemB" }),
      ]),
    ]),

    // Document cache route
    path("/document-cache", DocumentCachePage, { name: "documentCache" }),

    // Slow cache route
    cache({ ttl: 60, swr: 300 }, () => [
      layout(<RootLayout />),
      path("/slow-cache", SlowCachePage, { name: "slowCache" }),
    ]),

    // Theme route
    layout(<RootLayout />, () => [
      path("/theme", ThemePage, { name: "theme" }),
    ]),

    // Slow routes for navigation progress demo
    // /slow/1 uses handler pattern (blocks) - for testing
    // /slow/2 uses component pattern (streams)
    layout(<RootLayout />, () => [
      path("/slow/1", SlowPage1, { name: "slow1" }),
      path("/slow/2", () => <SlowPage2 />, { name: "slow2" }),
      path("/slow/fast", FastPage, { name: "fast" }),
    ]),

    // Inline routes demo
    layout(<RootLayout />, () => [
      path("/inline", InlineIndexPage, { name: "inlineIndex" }),
      path("/inline/docs", InlineDocsPage, { name: "inlineDocs" }),
      path("/inline/pricing", InlinePricingPage, { name: "inlinePricing" }),
    ]),
  ]),
]);
