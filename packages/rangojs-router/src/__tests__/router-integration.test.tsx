import { describe, it, expect } from "vitest";
import React from "react";
import { urls } from "../urls.js";
import { createLoader } from "../loader.js";
import { buildRouteTree } from "./helpers/route-tree.js";
import type { MiddlewareFn } from "../router/middleware.js";

// Dummy components
const RootLayout = (<div>root</div>) as React.ReactNode;
const AuthLayout = (<div>auth</div>) as React.ReactNode;
const BlogLayout = (<div>blog-layout</div>) as React.ReactNode;
const ShopLayout = (<div>shop-layout</div>) as React.ReactNode;
const HomePage = (<div>home</div>) as React.ReactNode;
const AboutPage = (<div>about</div>) as React.ReactNode;
const BlogIndex = (<div>blog-index</div>) as React.ReactNode;
const BlogPost = (<div>blog-post</div>) as React.ReactNode;
const UserProfile = (<div>user-profile</div>) as React.ReactNode;
const Dashboard = (<div>dashboard</div>) as React.ReactNode;
const ProductList = (<div>product-list</div>) as React.ReactNode;
const ProductDetail = (<div>product-detail</div>) as React.ReactNode;
const ProductModal = (<div>product-modal</div>) as React.ReactNode;
const Sidebar = (<div>sidebar</div>) as React.ReactNode;
const MainContent = (<div>main</div>) as React.ReactNode;
const LoadingSpinner = (<div>loading...</div>) as React.ReactNode;
const ErrorFallback = (<div>error</div>) as React.ReactNode;
const NotFoundFallback = (<div>not found</div>) as React.ReactNode;

// Dummy middleware
const authMiddleware: MiddlewareFn = async (_ctx, next) => next();
const logMiddleware: MiddlewareFn = async (_ctx, next) => next();
const rateLimitMiddleware: MiddlewareFn = async (_ctx, next) => next();

// Dummy loaders
const PostLoader = createLoader(async () => ({ title: "Post" }));
const UserLoader = createLoader(async () => ({ name: "User" }));

describe("route tree inspection", () => {
  // -------------------------------------------------------------------------
  // Pattern extraction & matching
  // -------------------------------------------------------------------------

  it("extracts route patterns", () => {
    const tree = buildRouteTree(
      urls(({ path }) => [
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
      ]),
    );

    expect(tree.routes()).toEqual({
      home: "/",
      about: "/about",
    });
  });

  it("matches URLs and extracts params", () => {
    const tree = buildRouteTree(
      urls(({ path, layout }) => [
        path("/", HomePage, { name: "home" }),
        layout(BlogLayout, () => [
          path("/blog", BlogIndex, { name: "blog.index" }),
          path("/blog/:slug", BlogPost, { name: "blog.post" }),
        ]),
        path("/users/:id", UserProfile, { name: "users.profile" }),
      ]),
    );

    expect(tree.match("/")!.routeKey).toBe("home");
    expect(tree.match("/blog")!.routeKey).toBe("blog.index");
    expect(tree.match("/blog/hello")!.routeKey).toBe("blog.post");
    expect(tree.match("/blog/hello")!.params).toEqual({ slug: "hello" });
    expect(tree.match("/users/42")!.params).toEqual({ id: "42" });
    expect(tree.match("/nonexistent")).toBeNull();
  });

  it("handles optional and constrained params", () => {
    const tree = buildRouteTree(
      urls(({ path }) => [
        path("/:locale(en|fr)?/about", AboutPage, { name: "about" }),
      ]),
    );

    expect(tree.match("/about")!.routeKey).toBe("about");
    expect(tree.match("/fr/about")!.params).toEqual({ locale: "fr" });
    expect(tree.match("/de/about")).toBeNull();
  });

  it("handles include() with prefix and name prefix", () => {
    const blogPatterns = urls(({ path }) => [
      path("/", BlogIndex, { name: "index" }),
      path("/:slug", BlogPost, { name: "post" }),
    ]);

    const tree = buildRouteTree(
      urls(({ path, include }) => [
        path("/", HomePage, { name: "home" }),
        include("/blog", blogPatterns, { name: "blog" }),
      ]),
    );

    expect(tree.routes()).toEqual({
      home: "/",
      "blog.index": "/blog",
      "blog.post": "/blog/:slug",
    });

    expect(tree.match("/blog")!.routeKey).toBe("blog.index");
    expect(tree.match("/blog/my-article")!.params).toEqual({
      slug: "my-article",
    });
  });

  // -------------------------------------------------------------------------
  // Segment IDs
  // -------------------------------------------------------------------------

  it("assigns segment IDs to flat routes", () => {
    const tree = buildRouteTree(
      urls(({ path }) => [
        path("/", HomePage, { name: "home" }),
        path("/about", AboutPage, { name: "about" }),
      ]),
    );

    expect(tree.segmentId("home")).toBe("M0L0R0");
    expect(tree.segmentId("about")).toBe("M0L0R1");
  });

  it("assigns segment IDs to layouts and nested routes", () => {
    const tree = buildRouteTree(
      urls(({ path, layout }) => [
        layout(BlogLayout, () => [
          path("/blog", BlogIndex, { name: "blog.index" }),
          path("/blog/:slug", BlogPost, { name: "blog.post" }),
        ]),
      ]),
    );

    expect(tree.segmentId("blog.index")).toBe("M0L0L0R0");
    expect(tree.segmentId("blog.post")).toBe("M0L0L0R1");

    const entry = tree.entry("blog.index")!;
    expect(entry.parent!.type).toBe("layout");
    expect(entry.parent!.shortCode).toBe("M0L0L0");
  });

  it("traces full segment path", () => {
    const tree = buildRouteTree(
      urls(({ path, layout }) => [
        layout(RootLayout, () => [
          path("/", HomePage, { name: "home" }),
          layout(BlogLayout, () => [
            path("/blog", BlogIndex, { name: "blog.index" }),
            path("/blog/:slug", BlogPost, { name: "blog.post" }),
          ]),
        ]),
      ]),
    );

    const segPath = tree.segmentPath("blog.post");
    expect(segPath.map((s) => s.id)).toEqual([
      "M0L0",       // synthetic root
      "M0L0L0",     // root layout
      "M0L0L0L0",   // blog layout
      "M0L0L0L0R1", // blog post (R1 because blog.index is R0)
    ]);
    expect(segPath.map((s) => s.type)).toEqual([
      "layout", "layout", "layout", "route",
    ]);
  });

  it("lists all segment IDs", () => {
    const tree = buildRouteTree(
      urls(({ path, layout }) => [
        layout(RootLayout, () => [
          path("/", HomePage, { name: "home" }),
          path("/about", AboutPage, { name: "about" }),
        ]),
      ]),
    );

    expect(tree.segmentIds()).toEqual({
      home: "M0L0L0R0",
      about: "M0L0L0R1",
    });
  });

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------

  it("detects middleware on a layout", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, middleware }) => [
        layout(RootLayout, () => [
          middleware(authMiddleware),
          path("/", HomePage, { name: "home" }),
        ]),
      ]),
    );

    // Middleware is attached to the layout entry, not the route
    const homeEntry = tree.entry("home")!;
    const layoutEntry = homeEntry.parent!;
    expect(layoutEntry.middleware).toHaveLength(1);
    expect(layoutEntry.middleware[0]).toBe(authMiddleware);
  });

  it("builds middleware chain through nested layouts", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, middleware }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware),
          layout(AuthLayout, () => [
            middleware(authMiddleware),
            path("/dashboard", Dashboard, { name: "dashboard" }),
          ]),
        ]),
      ]),
    );

    const chain = tree.middlewareChain("dashboard");
    expect(chain).toEqual([
      { segmentId: "M0L0L0", count: 1 },
      { segmentId: "M0L0L0L0", count: 1 },
    ]);
  });

  it("handles multiple middleware on same layout", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, middleware }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware, authMiddleware, rateLimitMiddleware),
          path("/", HomePage, { name: "home" }),
        ]),
      ]),
    );

    const homeEntry = tree.entry("home")!;
    expect(homeEntry.parent!.middleware).toHaveLength(3);

    const chain = tree.middlewareChain("home");
    expect(chain).toEqual([
      { segmentId: "M0L0L0", count: 3 },
    ]);
  });

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------

  it("detects loaders on a route", () => {
    const tree = buildRouteTree(
      urls(({ path, loader }) => [
        path("/blog/:slug", BlogPost, { name: "blog.post" }, () => [
          loader(PostLoader),
        ]),
      ]),
    );

    expect(tree.hasLoaders("blog.post")).toBe(true);
    expect(tree.loaders("blog.post")).toHaveLength(1);
    expect(tree.loaders("blog.post")[0].loader).toBe(PostLoader);
  });

  it("detects multiple loaders", () => {
    const tree = buildRouteTree(
      urls(({ path, loader }) => [
        path("/users/:id", UserProfile, { name: "users.profile" }, () => [
          loader(UserLoader),
          loader(PostLoader),
        ]),
      ]),
    );

    expect(tree.loaders("users.profile")).toHaveLength(2);
  });

  it("route without loaders returns empty", () => {
    const tree = buildRouteTree(
      urls(({ path }) => [
        path("/", HomePage, { name: "home" }),
      ]),
    );

    expect(tree.hasLoaders("home")).toBe(false);
    expect(tree.loaders("home")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Intercepts
  // -------------------------------------------------------------------------

  it("detects intercept on a layout", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, intercept }) => [
        layout(ShopLayout, () => [
          path("/products", ProductList, { name: "products" }),
          path("/products/:id", ProductDetail, { name: "product.detail" }),
          intercept("@modal", ".product.detail", ProductModal),
        ]),
      ]),
    );

    // Intercepts are stored on the layout entry (parent of products)
    const productsEntry = tree.entry("products")!;
    const layoutEntry = productsEntry.parent!;
    expect(layoutEntry.intercept).toHaveLength(1);
    expect(layoutEntry.intercept[0].slotName).toBe("@modal");
    expect(layoutEntry.intercept[0].routeName).toBe("product.detail");
  });

  it("detects intercept with when() condition", () => {
    const whenFn = (ctx: any) => ctx.from.pathname.startsWith("/products");

    const tree = buildRouteTree(
      urls(({ path, layout, intercept, when }) => [
        layout(ShopLayout, () => [
          path("/products", ProductList, { name: "products" }),
          path("/products/:id", ProductDetail, { name: "product.detail" }),
          intercept("@modal", ".product.detail", ProductModal, () => [
            when(whenFn),
          ]),
        ]),
      ]),
    );

    const productsEntry = tree.entry("products")!;
    const layoutEntry = productsEntry.parent!;
    const interceptEntry = layoutEntry.intercept[0];

    expect(interceptEntry.when).toHaveLength(1);
    expect(interceptEntry.when[0]).toBe(whenFn);
  });

  it("intercepts() returns structured info", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, intercept, when, loader }) => [
        layout(ShopLayout, () => [
          path("/products", ProductList, { name: "products" }),
          path("/products/:id", ProductDetail, { name: "product.detail" }),
          intercept("@modal", ".product.detail", ProductModal, () => [
            when(() => true),
            loader(PostLoader),
          ]),
        ]),
      ]),
    );

    const productsEntry = tree.entry("products")!;
    const layoutEntry = productsEntry.parent!;

    // Intercepts live on the parent layout entry
    expect(layoutEntry.intercept).toHaveLength(1);
    expect(layoutEntry.intercept[0].slotName).toBe("@modal");
    expect(layoutEntry.intercept[0].when).toHaveLength(1);
    expect(layoutEntry.intercept[0].loader).toHaveLength(1);

    // Also test via helper methods using the layout's manifest key
    const intercepts = tree.intercepts("products");
    // intercepts() looks up the named route, not the layout
    // The layout holding intercepts is accessed via entry().parent
    const layoutIntercepts = layoutEntry.intercept.map((i) => ({
      slotName: i.slotName,
      routeName: i.routeName,
      hasWhen: i.when.length > 0,
      whenCount: i.when.length,
      hasLoader: i.loader.length > 0,
      hasMiddleware: i.middleware.length > 0,
    }));
    expect(layoutIntercepts).toHaveLength(1);
    expect(layoutIntercepts[0].slotName).toBe("@modal");
    expect(layoutIntercepts[0].hasWhen).toBe(true);
    expect(layoutIntercepts[0].hasLoader).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Parallel slots
  // -------------------------------------------------------------------------

  it("detects parallel slots", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, parallel }) => [
        layout(RootLayout, () => [
          path("/", HomePage, { name: "home" }),
          parallel({ "@sidebar": Sidebar, "@main": MainContent }),
        ]),
      ]),
    );

    const homeEntry = tree.entry("home")!;
    const layoutEntry = homeEntry.parent!;
    expect(layoutEntry.parallel).toHaveLength(1);
    expect(layoutEntry.parallel[0].type).toBe("parallel");

    // Parallel slot names are on the layout entry's parallel array
    const parallelHandler = layoutEntry.parallel[0].handler as Record<string, unknown>;
    const slotNames = Object.keys(parallelHandler);
    expect(slotNames).toContain("@sidebar");
    expect(slotNames).toContain("@main");
  });

  // -------------------------------------------------------------------------
  // Error & NotFound boundaries
  // -------------------------------------------------------------------------

  it("detects error boundary on a route", () => {
    const tree = buildRouteTree(
      urls(({ path, errorBoundary }) => [
        path("/", HomePage, { name: "home" }, () => [
          errorBoundary(ErrorFallback),
        ]),
      ]),
    );

    expect(tree.hasErrorBoundary("home")).toBe(true);
  });

  it("detects not-found boundary on a layout", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, notFoundBoundary }) => [
        layout(RootLayout, () => [
          notFoundBoundary(NotFoundFallback),
          path("/", HomePage, { name: "home" }),
        ]),
      ]),
    );

    const homeEntry = tree.entry("home")!;
    const layoutEntry = homeEntry.parent!;
    expect(layoutEntry.notFoundBoundary).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  it("detects loading component on a route", () => {
    const tree = buildRouteTree(
      urls(({ path, loading }) => [
        path("/", HomePage, { name: "home" }, () => [
          loading(LoadingSpinner),
        ]),
      ]),
    );

    expect(tree.hasLoading("home")).toBe(true);
  });

  it("route without loading returns false", () => {
    const tree = buildRouteTree(
      urls(({ path }) => [
        path("/", HomePage, { name: "home" }),
      ]),
    );

    expect(tree.hasLoading("home")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Deeply nested layouts — segment hierarchy
  // -------------------------------------------------------------------------

  it("deeply nested layouts produce correct segment hierarchy", () => {
    const NavLayout = (<div>nav</div>) as React.ReactNode;
    const ContentLayout = (<div>content</div>) as React.ReactNode;
    const SettingsLayout = (<div>settings</div>) as React.ReactNode;
    const SettingsGeneral = (<div>settings-general</div>) as React.ReactNode;
    const SettingsSecurity = (<div>settings-security</div>) as React.ReactNode;

    const tree = buildRouteTree(
      urls(({ path, layout, middleware }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware),
          layout(NavLayout, () => [
            layout(ContentLayout, () => [
              path("/", HomePage, { name: "home" }),
              layout(SettingsLayout, () => [
                middleware(authMiddleware),
                path("/settings", SettingsGeneral, { name: "settings.general" }),
                path("/settings/security", SettingsSecurity, { name: "settings.security" }),
              ]),
            ]),
          ]),
        ]),
      ]),
    );

    // 4 layouts deep: synthetic root > RootLayout > NavLayout > ContentLayout > SettingsLayout
    const segPath = tree.segmentPath("settings.general");
    expect(segPath.map((s) => s.type)).toEqual([
      "layout", "layout", "layout", "layout", "layout", "route",
    ]);
    expect(segPath.map((s) => s.id)).toEqual([
      "M0L0",           // synthetic root
      "M0L0L0",         // RootLayout
      "M0L0L0L0",       // NavLayout
      "M0L0L0L0L0",     // ContentLayout
      "M0L0L0L0L0L0",   // SettingsLayout
      "M0L0L0L0L0L0R0", // settings.general
    ]);

    // Security is R1 under SettingsLayout
    expect(tree.segmentId("settings.security")).toBe("M0L0L0L0L0L0R1");

    // Home is under ContentLayout directly (not SettingsLayout)
    const homePath = tree.segmentPath("home");
    expect(homePath).toHaveLength(5); // synthetic + Root + Nav + Content + route
    expect(homePath[3].id).toBe("M0L0L0L0L0"); // ContentLayout
    expect(homePath[4].id).toBe("M0L0L0L0L0R0"); // home (R0 before SettingsLayout takes L0)

    // Middleware chain: settings gets both logMw (root) and authMw (settings layout)
    const settingsChain = tree.middlewareChain("settings.general");
    expect(settingsChain).toEqual([
      { segmentId: "M0L0L0", count: 1 },         // logMw on RootLayout
      { segmentId: "M0L0L0L0L0L0", count: 1 },   // authMw on SettingsLayout
    ]);

    // Home only gets logMw
    expect(tree.middlewareChain("home")).toEqual([
      { segmentId: "M0L0L0", count: 1 },
    ]);
  });

  // -------------------------------------------------------------------------
  // Cache segments
  // -------------------------------------------------------------------------

  it("cache() wrapping children creates a C segment in the hierarchy", () => {
    const CachedPage = (<div>cached</div>) as React.ReactNode;
    const UncachedPage = (<div>uncached</div>) as React.ReactNode;

    const tree = buildRouteTree(
      urls(({ path, layout, cache }) => [
        layout(RootLayout, () => [
          path("/uncached", UncachedPage, { name: "uncached" }),
          cache({ ttl: 60 }, () => [
            path("/cached", CachedPage, { name: "cached" }),
          ]),
        ]),
      ]),
    );

    // Both routes exist
    expect(tree.routes()).toEqual({
      uncached: "/uncached",
      cached: "/cached",
    });

    // Uncached route sits directly under RootLayout
    const uncachedPath = tree.segmentPath("uncached");
    expect(uncachedPath.map((s) => s.type)).toEqual(["layout", "layout", "route"]);

    // Cached route goes through a cache segment
    const cachedEntry = tree.entry("cached")!;
    expect(cachedEntry.parent!.type).toBe("cache");
    expect(cachedEntry.parent!.cache).toBeDefined();
    expect(cachedEntry.parent!.cache!.options).toEqual({ ttl: 60 });

    const cachedPath = tree.segmentPath("cached");
    expect(cachedPath.map((s) => s.type)).toEqual([
      "layout", "layout", "cache", "route",
    ]);
    // C segment gets a C prefix in the shortCode
    expect(cachedEntry.parent!.shortCode).toMatch(/^M0L0L0C/);
  });

  it("nested cache segments with different TTLs", () => {
    const ListPage = (<div>list</div>) as React.ReactNode;
    const DetailPage = (<div>detail</div>) as React.ReactNode;
    const AdminPage = (<div>admin</div>) as React.ReactNode;

    const tree = buildRouteTree(
      urls(({ path, layout, cache }) => [
        layout(RootLayout, () => [
          cache({ ttl: 60 }, () => [
            path("/products", ListPage, { name: "products" }),
            cache({ ttl: 3600 }, () => [
              path("/products/:id", DetailPage, { name: "product.detail" }),
            ]),
          ]),
          cache(false, () => [
            path("/admin", AdminPage, { name: "admin" }),
          ]),
        ]),
      ]),
    );

    // Products has outer cache (ttl: 60)
    const productsEntry = tree.entry("products")!;
    expect(productsEntry.parent!.type).toBe("cache");
    expect(productsEntry.parent!.cache!.options).toEqual({ ttl: 60 });

    // Product detail has inner cache (ttl: 3600), parent is the outer cache
    const detailEntry = tree.entry("product.detail")!;
    expect(detailEntry.parent!.type).toBe("cache");
    expect(detailEntry.parent!.cache!.options).toEqual({ ttl: 3600 });
    expect(detailEntry.parent!.parent!.type).toBe("cache");
    expect(detailEntry.parent!.parent!.cache!.options).toEqual({ ttl: 60 });

    // Segment path has two cache levels
    const detailPath = tree.segmentPath("product.detail");
    const types = detailPath.map((s) => s.type);
    expect(types).toEqual(["layout", "layout", "cache", "cache", "route"]);

    // Admin has cache disabled (false)
    const adminEntry = tree.entry("admin")!;
    expect(adminEntry.parent!.type).toBe("cache");
    expect(adminEntry.parent!.cache!.options).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Parallel slots with loaders and loading
  // -------------------------------------------------------------------------

  it("parallel slots with loaders and loading", () => {
    const FeedContent = (<div>feed</div>) as React.ReactNode;
    const TrendingSidebar = (<div>trending</div>) as React.ReactNode;
    const FeedLoader = createLoader(async () => ({ items: [] }));

    const tree = buildRouteTree(
      urls(({ path, layout, parallel, loader, loading }) => [
        layout(RootLayout, () => [
          path("/feed", HomePage, { name: "feed" }),
          parallel(
            { "@sidebar": TrendingSidebar, "@content": FeedContent },
            () => [
              loader(FeedLoader),
              loading(LoadingSpinner),
            ],
          ),
        ]),
      ]),
    );

    const feedEntry = tree.entry("feed")!;
    const layoutEntry = feedEntry.parent!;

    // Parallel slot is on the layout
    expect(layoutEntry.parallel).toHaveLength(1);
    const parallelEntry = layoutEntry.parallel[0];
    expect(parallelEntry.type).toBe("parallel");

    // Parallel has its own loader and loading
    expect(parallelEntry.loader).toHaveLength(1);
    expect(parallelEntry.loader[0].loader).toBe(FeedLoader);
    expect(parallelEntry.loading).toBe(LoadingSpinner);

    // Slot names
    const handler = parallelEntry.handler as Record<string, unknown>;
    expect(Object.keys(handler)).toEqual(
      expect.arrayContaining(["@sidebar", "@content"]),
    );

    // Parallel gets a P prefix shortCode
    expect(parallelEntry.shortCode).toMatch(/^M0L0L0P/);
  });

  // -------------------------------------------------------------------------
  // Include inside layout — segments inherit correctly
  // -------------------------------------------------------------------------

  it("include() inside a layout inherits the layout parent", () => {
    const apiPatterns = urls(({ path, loader }) => [
      path("/", (<div>api-index</div>) as React.ReactNode, { name: "index" }),
      path("/:id", (<div>api-detail</div>) as React.ReactNode, { name: "detail" }, () => [
        loader(PostLoader),
      ]),
    ]);

    const tree = buildRouteTree(
      urls(({ path, layout, include, middleware }) => [
        layout(RootLayout, () => [
          middleware(authMiddleware),
          path("/", HomePage, { name: "home" }),
          layout(AuthLayout, () => [
            include("/api/v1", apiPatterns, { name: "api" }),
          ]),
        ]),
      ]),
    );

    // Included routes get prefixed names and patterns
    expect(tree.routes()).toEqual({
      home: "/",
      "api.index": "/api/v1",
      "api.detail": "/api/v1/:id",
    });

    // Matching works with full prefixed paths
    expect(tree.match("/api/v1")!.routeKey).toBe("api.index");
    expect(tree.match("/api/v1/42")!.params).toEqual({ id: "42" });

    // Lazy includes capture the parent at include() call time (AuthLayout).
    // The segment path for included routes starts from that captured parent.
    const detailEntry = tree.entry("api.detail")!;
    expect(detailEntry.parent!.type).toBe("layout"); // AuthLayout
    expect(detailEntry.parent!.shortCode).toBe("M0L0L0L0");

    // API detail has a loader
    expect(tree.hasLoaders("api.detail")).toBe(true);
    expect(tree.hasLoaders("api.index")).toBe(false);

    // Middleware: authMw is on RootLayout (M0L0L0), which is an ancestor
    // of AuthLayout. Since lazy includes capture AuthLayout as parent,
    // the middleware chain traverses from AuthLayout upward.
    const chain = tree.middlewareChain("api.detail");
    // authMw on RootLayout must be reachable through the parent chain
    expect(chain).toEqual([
      { segmentId: "M0L0L0", count: 1 },
    ]);

    // AuthLayout's parent must NOT be null — it must point to RootLayout
    // so the middleware chain is intact
    const authLayout = detailEntry.parent!;
    expect(authLayout.parent).not.toBeNull();
    expect(authLayout.parent!.shortCode).toBe("M0L0L0");
  });

  it("layout with middleware and only include children preserves middleware chain", () => {
    const blogPatterns = urls(({ path }) => [
      path("/", BlogIndex, { name: "index" }),
      path("/:slug", BlogPost, { name: "post" }),
    ]);

    const tree = buildRouteTree(
      urls(({ path, layout, include, middleware }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware),
          path("/", HomePage, { name: "home" }),
          layout(AuthLayout, () => [
            middleware(authMiddleware),
            include("/blog", blogPatterns, { name: "blog" }),
          ]),
        ]),
      ]),
    );

    // Routes include both direct and included routes
    expect(tree.routeNames()).toEqual(
      expect.arrayContaining(["home", "blog.index", "blog.post"]),
    );

    // AuthLayout must NOT be orphaned — it has include children with routes
    const postEntry = tree.entry("blog.post")!;
    expect(postEntry.parent!.type).toBe("layout"); // AuthLayout
    expect(postEntry.parent!.parent).not.toBeNull(); // parent chain intact
    expect(postEntry.parent!.middleware).toHaveLength(1);
    expect(postEntry.parent!.middleware[0]).toBe(authMiddleware);

    // Full middleware chain: logMw (RootLayout) + authMw (AuthLayout)
    const chain = tree.middlewareChain("blog.post");
    expect(chain).toEqual([
      { segmentId: "M0L0L0", count: 1 },   // logMw on RootLayout
      { segmentId: "M0L0L0L0", count: 1 },  // authMw on AuthLayout
    ]);

    // Home route only gets logMw (not under AuthLayout)
    const homeChain = tree.middlewareChain("home");
    expect(homeChain).toEqual([
      { segmentId: "M0L0L0", count: 1 },
    ]);
  });

  // -------------------------------------------------------------------------
  // Orphan layouts — layouts without routes that wrap siblings
  // -------------------------------------------------------------------------

  it("orphan layout attaches to parent's layout array", () => {
    const WrapperLayout = (<div>wrapper</div>) as React.ReactNode;

    const tree = buildRouteTree(
      urls(({ path, layout, middleware }) => [
        layout(RootLayout, () => [
          layout(WrapperLayout, () => [
            middleware(authMiddleware),
          ]),
          path("/", HomePage, { name: "home" }),
          path("/about", AboutPage, { name: "about" }),
        ]),
      ]),
    );

    // Routes still register correctly
    expect(tree.routes()).toEqual({ home: "/", about: "/about" });

    // The orphan layout (WrapperLayout) is stored in RootLayout's layout array
    const homeEntry = tree.entry("home")!;
    const rootLayout = homeEntry.parent!;
    expect(rootLayout.type).toBe("layout");
    expect(rootLayout.layout).toHaveLength(1);

    const orphan = rootLayout.layout[0];
    expect(orphan.type).toBe("layout");
    // Orphan layouts have their parent cleared to prevent duplicate processing
    expect(orphan.parent).toBeNull();
    // But they carry their middleware
    expect(orphan.middleware).toHaveLength(1);
    expect(orphan.middleware[0]).toBe(authMiddleware);
  });

  it("orphan layout with loading attaches loading to the layout entry", () => {
    const WrapperLayout = (<div>wrapper</div>) as React.ReactNode;

    const tree = buildRouteTree(
      urls(({ path, layout, loading }) => [
        layout(RootLayout, () => [
          layout(WrapperLayout, () => [
            loading(LoadingSpinner),
          ]),
          path("/", HomePage, { name: "home" }),
        ]),
      ]),
    );

    const homeEntry = tree.entry("home")!;
    const rootLayout = homeEntry.parent!;
    const orphan = rootLayout.layout[0];
    expect(orphan.loading).toBe(LoadingSpinner);
  });

  it("orphan layout containing another orphan layout throws", () => {
    const Wrapper1 = (<div>w1</div>) as React.ReactNode;
    const Wrapper2 = (<div>w2</div>) as React.ReactNode;

    expect(() =>
      buildRouteTree(
        urls(({ path, layout, middleware, loading }) => [
          layout(RootLayout, () => [
            layout(Wrapper1, () => [
              middleware(logMiddleware),
              layout(Wrapper2, () => [
                middleware(authMiddleware),
                loading(LoadingSpinner),
              ]),
            ]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      ),
    ).toThrow("orphan layout cannot contain other layouts as children");
  });

  it("sibling orphan layouts stack as composable wrappers", () => {
    const Wrapper1 = (<div>w1</div>) as React.ReactNode;
    const Wrapper2 = (<div>w2</div>) as React.ReactNode;

    const tree = buildRouteTree(
      urls(({ path, layout, middleware, loading }) => [
        layout(RootLayout, () => [
          layout(Wrapper1, () => [
            middleware(logMiddleware),
          ]),
          layout(Wrapper2, () => [
            middleware(authMiddleware),
            loading(LoadingSpinner),
          ]),
          path("/", HomePage, { name: "home" }),
        ]),
      ]),
    );

    expect(tree.routes()).toEqual({ home: "/" });

    const homeEntry = tree.entry("home")!;
    const rootLayout = homeEntry.parent!;

    // Both wrappers are sibling orphan layouts on RootLayout
    expect(rootLayout.layout).toHaveLength(2);
    const wrapper1 = rootLayout.layout[0];
    const wrapper2 = rootLayout.layout[1];
    expect(wrapper1.type).toBe("layout");
    expect(wrapper2.type).toBe("layout");
    expect(wrapper1.parent).toBeNull();
    expect(wrapper2.parent).toBeNull();

    expect(wrapper1.middleware).toHaveLength(1);
    expect(wrapper1.middleware[0]).toBe(logMiddleware);
    expect(wrapper1.shortCode).toBe("M0L0L0L0");

    expect(wrapper2.middleware).toHaveLength(1);
    expect(wrapper2.middleware[0]).toBe(authMiddleware);
    expect(wrapper2.loading).toBe(LoadingSpinner);
    expect(wrapper2.shortCode).toBe("M0L0L0L1");

    expect(homeEntry.shortCode).toBe("M0L0L0R0");
  });

  it("orphan cache attaches to parent and wraps subsequent siblings", () => {
    const tree = buildRouteTree(
      urls(({ path, layout, cache }) => [
        layout(RootLayout, () => [
          cache({ ttl: 300 }),
          path("/", HomePage, { name: "home" }),
          path("/about", AboutPage, { name: "about" }),
        ]),
      ]),
    );

    // Routes register correctly
    expect(tree.routes()).toEqual({ home: "/", about: "/about" });

    // With orphan cache(), the cache becomes the new parent for siblings
    // so routes attach under the cache segment
    const homeEntry = tree.entry("home")!;
    expect(homeEntry.parent!.type).toBe("cache");
    expect(homeEntry.parent!.cache!.options).toEqual({ ttl: 300 });

    // Cache is a child of RootLayout
    const cacheParent = homeEntry.parent!.parent;
    // Orphan cache has parent cleared (like orphan layout)
    // but the segment path still shows the hierarchy
    const homePath = tree.segmentPath("home");
    expect(homePath.map((s) => s.type)).toContain("cache");
  });

  // -------------------------------------------------------------------------
  // Invalid configurations — must error at definition time
  // -------------------------------------------------------------------------

  it("layout inside parallel throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, parallel }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }),
            // @ts-expect-error layout is not a valid parallel use item
            parallel({ "@sidebar": Sidebar }, () => [
              layout(AuthLayout, () => [
                // layout inside parallel is not allowed
              ]),
            ]),
          ]),
        ]),
      );
    }).toThrow(/layout\(\) cannot be used inside parallel/);
  });

  it("orphan layout inside parallel throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, parallel }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }),
            // @ts-expect-error layout is not a valid parallel use item
            parallel({ "@sidebar": Sidebar }, () => [
              layout(AuthLayout),
            ]),
          ]),
        ]),
      );
    }).toThrow(/layout\(\) cannot be used inside parallel/);
  });

  it("when() outside intercept throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, when }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }),
            // @ts-expect-error when is not a valid layout use item
            when(() => true),
          ]),
        ]),
      );
    }).toThrow(/when\(\) can only be used inside intercept/);
  });

  it("duplicate route names throw", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path }) => [
          path("/", HomePage, { name: "home" }),
          path("/other", AboutPage, { name: "home" }),
        ]),
      );
    }).toThrow(/Duplicate route name: home/);
  });

  it("parallel inside parallel throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, parallel }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }),
            // @ts-expect-error parallel is not a valid parallel use item
            parallel({ "@sidebar": Sidebar }, () => [
              parallel({ "@inner": MainContent }),
            ]),
          ]),
        ]),
      );
    }).toThrow(/parallel\(\) cannot be nested inside another parallel/);
  });

  it("intercept inside parallel throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, parallel, intercept }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }),
            path("/detail", AboutPage, { name: "detail" }),
            // @ts-expect-error intercept is not a valid parallel use item
            parallel({ "@sidebar": Sidebar }, () => [
              intercept("@modal", ".detail", ProductModal),
            ]),
          ]),
        ]),
      );
    }).toThrow(/intercept\(\) cannot be used inside parallel/);
  });

  it("path inside parallel throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, parallel }) => [
          layout(RootLayout, () => [
            // @ts-expect-error path is not a valid parallel use item
            parallel({ "@sidebar": Sidebar }, () => [
              path("/nested", HomePage, { name: "nested" }),
            ]),
          ]),
        ]),
      );
    }).toThrow(/path\(\) cannot be used inside parallel/);
  });

  it("path inside path throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout }) => [
          layout(RootLayout, () => [
            // @ts-expect-error path is not a valid route use item
            path("/parent", HomePage, { name: "parent" }, () => [
              path("/child", AboutPage, { name: "child" }),
            ]),
          ]),
        ]),
      );
    }).toThrow(/path\(\) cannot be nested inside another path/);
  });

  it("path inside layout inside path throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout }) => [
          layout(RootLayout, () => [
            path("/parent", HomePage, { name: "parent" }, () => [
              layout(AuthLayout, () => [
                path("/child", AboutPage, { name: "child" }),
              ]),
            ]),
          ]),
        ]),
      );
    }).toThrow(/path\(\) cannot be nested inside another path/);
  });

  it("path inside cache inside layout inside path throws", () => {
    expect(() => {
      buildRouteTree(
        urls(({ path, layout, cache }) => [
          layout(RootLayout, () => [
            path("/parent", HomePage, { name: "parent" }, () => [
              layout(AuthLayout, () => [
                cache({ ttl: 60 }, () => [
                  path("/child", AboutPage, { name: "child" }),
                ]),
              ]),
            ]),
          ]),
        ]),
      );
    }).toThrow(/path\(\) cannot be nested inside another path/);
  });

  // -------------------------------------------------------------------------
  // Combined: complex app with cache, parallel, nested layouts, include
  // -------------------------------------------------------------------------

  it("inspects a full app route tree", () => {
    const blogPatterns = urls(({ path, loader }) => [
      path("/", BlogIndex, { name: "index" }),
      path("/:slug", BlogPost, { name: "post" }, () => [
        loader(PostLoader),
      ]),
    ]);

    const tree = buildRouteTree(
      urls(({ path, layout, include, middleware, errorBoundary, loading }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware),
          errorBoundary(ErrorFallback),
          path("/", HomePage, { name: "home" }),
          layout(AuthLayout, () => [
            middleware(authMiddleware),
            path("/dashboard", Dashboard, { name: "dashboard" }, () => [
              loading(LoadingSpinner),
            ]),
          ]),
          include("/blog", blogPatterns, { name: "blog" }),
        ]),
      ]),
    );

    // Route patterns
    expect(tree.routeNames()).toContain("home");
    expect(tree.routeNames()).toContain("dashboard");
    expect(tree.routeNames()).toContain("blog.index");
    expect(tree.routeNames()).toContain("blog.post");

    // Matching
    expect(tree.match("/")!.routeKey).toBe("home");
    expect(tree.match("/dashboard")!.routeKey).toBe("dashboard");
    expect(tree.match("/blog")!.routeKey).toBe("blog.index");
    expect(tree.match("/blog/hello")!.params).toEqual({ slug: "hello" });

    // Middleware chain: dashboard goes through root + auth layouts
    const dashChain = tree.middlewareChain("dashboard");
    expect(dashChain).toHaveLength(2);

    // Home only goes through root layout
    const homeChain = tree.middlewareChain("home");
    expect(homeChain).toHaveLength(1);

    // Blog post has a loader
    expect(tree.hasLoaders("blog.post")).toBe(true);
    expect(tree.hasLoaders("blog.index")).toBe(false);

    // Dashboard has loading
    expect(tree.hasLoading("dashboard")).toBe(true);

    // Root layout has error boundary
    const homeEntry = tree.entry("home")!;
    expect(homeEntry.parent!.errorBoundary).toHaveLength(1);

    // Debug output
    const debug = tree.debug();
    expect(debug).toContain("home:");
    expect(debug).toContain("dashboard:");
  });

  it("path with nested layouts carrying loading, loaders, and parallel", () => {
    const InnerLayout = (<div>inner</div>) as React.ReactNode;
    const DeepLayout = (<div>deep</div>) as React.ReactNode;
    const ComplexPage = (<div>complex</div>) as React.ReactNode;
    const PanelA = (<div>panel-a</div>) as React.ReactNode;
    const PanelB = (<div>panel-b</div>) as React.ReactNode;
    const InnerLoading = (<div>inner-loading</div>) as React.ReactNode;
    const ComplexLoader = createLoader(async () => ({ data: "complex" }));
    const DeepLoader = createLoader(async () => ({ nested: true }));

    const tree = buildRouteTree(
      urls(({ path, layout, loader, loading, parallel, middleware }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware),
          path("/complex-extra", ComplexPage, { name: "complex.very" }, () => [
            loader(ComplexLoader),
            loading(LoadingSpinner),
            layout(InnerLayout, () => [
              loading(InnerLoading),
              loader(DeepLoader),
              parallel({ "@panelA": PanelA, "@panelB": PanelB }),
            ]),
            layout(DeepLayout, () => [
              middleware(authMiddleware),
            ]),
          ]),
        ]),
      ]),
    );

    // Route registers correctly
    expect(tree.routes()).toEqual({ "complex.very": "/complex-extra" });
    expect(tree.match("/complex-extra")!.routeKey).toBe("complex.very");

    // Route entry itself
    const entry = tree.entry("complex.very")!;
    expect(entry.type).toBe("route");
    expect(entry.parent!.type).toBe("layout"); // RootLayout

    // Route has its own loader and loading
    expect(entry.loader).toHaveLength(1);
    expect(entry.loader[0].loader).toBe(ComplexLoader);
    expect(entry.loading).toBe(LoadingSpinner);

    // Both orphan layouts are siblings on the route's layout array
    expect(entry.layout).toHaveLength(2);
    const innerLayout = entry.layout[0];
    const deepLayout = entry.layout[1];
    expect(innerLayout.type).toBe("layout");
    expect(deepLayout.type).toBe("layout");

    // InnerLayout carries its own loading and loader
    expect(innerLayout.loading).toBe(InnerLoading);
    expect(innerLayout.loader).toHaveLength(1);
    expect(innerLayout.loader[0].loader).toBe(DeepLoader);

    // InnerLayout has parallel slots
    expect(innerLayout.parallel).toHaveLength(1);
    const parallelEntry = innerLayout.parallel[0];
    expect(parallelEntry.type).toBe("parallel");
    const slots = parallelEntry.handler as Record<string, unknown>;
    expect(Object.keys(slots)).toEqual(
      expect.arrayContaining(["@panelA", "@panelB"]),
    );

    // DeepLayout carries middleware (no nested orphan layouts)
    expect(innerLayout.layout).toHaveLength(0);
    expect(deepLayout.middleware).toHaveLength(1);
    expect(deepLayout.middleware[0]).toBe(authMiddleware);

    // Segment IDs: route is under RootLayout
    expect(tree.segmentId("complex.very")).toBe("M0L0L0R0");

    // Both layouts get L shortCodes directly under the route
    expect(innerLayout.shortCode).toBe("M0L0L0R0L0");
    expect(deepLayout.shortCode).toBe("M0L0L0R0L1");
    expect(parallelEntry.shortCode).toBe("M0L0L0R0L0P0");

    // Middleware chain for the route: only logMw from RootLayout
    // (authMw is on DeepLayout which wraps inside the route, not in parent chain)
    const chain = tree.middlewareChain("complex.very");
    expect(chain).toEqual([
      { segmentId: "M0L0L0", count: 1 },
    ]);
  });

  it("complex app: cache + parallel + nested layouts + intercept", () => {
    const NavLayout = (<div>nav</div>) as React.ReactNode;
    const ListPage = (<div>list</div>) as React.ReactNode;
    const DetailPage = (<div>detail</div>) as React.ReactNode;
    const ModalView = (<div>modal</div>) as React.ReactNode;
    const SidebarNav = (<div>sidebar-nav</div>) as React.ReactNode;
    const DetailLoader = createLoader(async () => ({ item: {} }));
    const ListLoader = createLoader(async () => ({ items: [] }));

    const tree = buildRouteTree(
      urls(({ path, layout, cache, parallel, intercept, when, middleware, loader, loading, errorBoundary }) => [
        layout(RootLayout, () => [
          middleware(logMiddleware),
          errorBoundary(ErrorFallback),
          layout(NavLayout, () => [
            parallel({ "@sidebar": SidebarNav }),
            cache({ ttl: 120 }, () => [
              path("/items", ListPage, { name: "items" }, () => [
                loader(ListLoader),
                loading(LoadingSpinner),
              ]),
              path("/items/:id", DetailPage, { name: "item.detail" }, () => [
                loader(DetailLoader),
                loading(LoadingSpinner),
              ]),
              intercept("@drawer", ".item.detail", ModalView, () => [
                when((ctx: any) => ctx.from.pathname.startsWith("/items")),
                loader(DetailLoader),
              ]),
            ]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      ]),
    );

    // All routes registered
    expect(tree.routeNames()).toEqual(
      expect.arrayContaining(["home", "items", "item.detail"]),
    );

    // Matching
    expect(tree.match("/")!.routeKey).toBe("home");
    expect(tree.match("/items")!.routeKey).toBe("items");
    expect(tree.match("/items/abc")!.params).toEqual({ id: "abc" });

    // Segment hierarchy for items: synthetic > Root > Nav > Cache > route
    const itemsPath = tree.segmentPath("items");
    const itemsTypes = itemsPath.map((s) => s.type);
    expect(itemsTypes).toEqual(["layout", "layout", "layout", "cache", "route"]);

    // Home is NOT inside the cache segment
    const homePath = tree.segmentPath("home");
    const homeTypes = homePath.map((s) => s.type);
    expect(homeTypes).toEqual(["layout", "layout", "layout", "route"]);

    // Cache segment properties
    const itemsEntry = tree.entry("items")!;
    expect(itemsEntry.parent!.type).toBe("cache");
    expect(itemsEntry.parent!.cache!.options).toEqual({ ttl: 120 });

    // Loaders on items and item.detail
    expect(tree.hasLoaders("items")).toBe(true);
    expect(tree.loaders("items")[0].loader).toBe(ListLoader);
    expect(tree.hasLoaders("item.detail")).toBe(true);
    expect(tree.loaders("item.detail")[0].loader).toBe(DetailLoader);

    // Loading on both
    expect(tree.hasLoading("items")).toBe(true);
    expect(tree.hasLoading("item.detail")).toBe(true);

    // Home has no loader or loading
    expect(tree.hasLoaders("home")).toBe(false);
    expect(tree.hasLoading("home")).toBe(false);

    // Middleware: all routes get logMw from RootLayout
    expect(tree.middlewareChain("items")).toEqual([
      { segmentId: "M0L0L0", count: 1 },
    ]);
    expect(tree.middlewareChain("home")).toEqual([
      { segmentId: "M0L0L0", count: 1 },
    ]);

    // Error boundary on RootLayout propagates
    expect(itemsEntry.parent!.parent!.parent!.errorBoundary).toHaveLength(1);

    // Parallel sidebar on NavLayout
    const homeEntry = tree.entry("home")!;
    const navLayout = homeEntry.parent!;
    expect(navLayout.type).toBe("layout"); // NavLayout
    expect(navLayout.parallel).toHaveLength(1);
    const sidebarSlot = navLayout.parallel[0];
    expect(sidebarSlot.type).toBe("parallel");
    const sidebarHandler = sidebarSlot.handler as Record<string, unknown>;
    expect(Object.keys(sidebarHandler)).toContain("@sidebar");

    // Intercept on cache segment's parent (NavLayout holds the cache which holds the intercept)
    // Intercepts are on the entry where intercept() is called — inside cache() children
    const cacheEntry = itemsEntry.parent!;
    expect(cacheEntry.intercept).toHaveLength(1);
    expect(cacheEntry.intercept[0].slotName).toBe("@drawer");
    expect(cacheEntry.intercept[0].routeName).toBe("item.detail");
    expect(cacheEntry.intercept[0].when).toHaveLength(1);
    expect(cacheEntry.intercept[0].loader).toHaveLength(1);
    expect(cacheEntry.intercept[0].loader[0].loader).toBe(DetailLoader);
  });
});
