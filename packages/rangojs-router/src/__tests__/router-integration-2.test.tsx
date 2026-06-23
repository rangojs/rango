import { describe, it, expect } from "vitest";
import React from "react";
import { urls } from "../urls.js";
import { createLoader } from "../loader.js";
import { buildRouteTree } from "./helpers/route-tree.js";
import type { MiddlewareFn } from "../router/middleware.js";

// Dummy components
const RootLayout = (<div>root</div>) as React.ReactNode;
const AuthLayout = (<div>auth</div>) as React.ReactNode;
const WrapperA = (<div>a</div>) as React.ReactNode;
const WrapperB = (<div>b</div>) as React.ReactNode;
const WrapperC = (<div>c</div>) as React.ReactNode;
const HomePage = (<div>home</div>) as React.ReactNode;
const AboutPage = (<div>about</div>) as React.ReactNode;
const BlogIndex = (<div>blog-index</div>) as React.ReactNode;
const BlogPost = (<div>blog-post</div>) as React.ReactNode;
const ProductList = (<div>product-list</div>) as React.ReactNode;
const ProductDetail = (<div>product-detail</div>) as React.ReactNode;
const ProductModal = (<div>product-modal</div>) as React.ReactNode;
const Sidebar = (<div>sidebar</div>) as React.ReactNode;
const MainContent = (<div>main</div>) as React.ReactNode;
const LoadingSpinner = (<div>loading...</div>) as React.ReactNode;
const ErrorFallback = (<div>error</div>) as React.ReactNode;
const NotFoundFallback = (<div>not found</div>) as React.ReactNode;

// Dummy middleware
const mw1: MiddlewareFn = async (_ctx, next) => next();
const mw2: MiddlewareFn = async (_ctx, next) => next();
const mw3: MiddlewareFn = async (_ctx, next) => next();

// Dummy loaders (3rd arg = injected $$id, normally set by Vite plugin)
const PostLoader = (createLoader as Function)(
  async () => ({ title: "Post" }),
  undefined,
  "test#PostLoader",
);

describe("route definition edge cases", () => {
  // ---------------------------------------------------------------------------
  // Valid patterns - must succeed
  // ---------------------------------------------------------------------------

  describe("valid patterns", () => {
    it("layout with routes and sibling orphan layouts", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            layout(WrapperA, () => [middleware(mw1)]),
            layout(WrapperB, () => [middleware(mw2)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      expect(tree.routes()).toEqual({ home: "/" });
      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(2);
    });

    it("orphan layout with middleware only", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [middleware(mw1)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      expect(tree.routes()).toEqual({ home: "/" });
      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
      expect(root.layout[0].middleware).toHaveLength(1);
    });

    it("orphan layout with loading only", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, loading }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [loading(LoadingSpinner)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
      expect(root.layout[0].loading).toBe(LoadingSpinner);
    });

    it("orphan layout with error boundary only", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, errorBoundary }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [errorBoundary(ErrorFallback)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
      expect(root.layout[0].errorBoundary).toHaveLength(1);
    });

    it("orphan layout with notFound boundary only", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, notFoundBoundary }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [notFoundBoundary(NotFoundFallback)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
      expect(root.layout[0].notFoundBoundary).toHaveLength(1);
    });

    it("orphan layout with loader only", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, loader }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [loader(PostLoader)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
      expect(root.layout[0].loader).toHaveLength(1);
    });

    it("orphan layout with multiple config items (no inner layouts)", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware, loading, loader }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [
              middleware(mw1),
              middleware(mw2),
              loading(LoadingSpinner),
              loader(PostLoader),
            ]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
      const orphan = root.layout[0];
      expect(orphan.middleware).toHaveLength(2);
      expect(orphan.loading).toBe(LoadingSpinner);
      expect(orphan.loader).toHaveLength(1);
    });

    it("orphan layout without children callback (bare wrapper)", () => {
      const tree = buildRouteTree(
        urls(({ path, layout }) => [
          layout(RootLayout, () => [
            layout(AuthLayout),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(1);
    });

    it("orphan cache without children wraps subsequent siblings", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, cache }) => [
          layout(RootLayout, () => [
            cache({ ttl: 300 }),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      // Orphan cache replaces ctx.parent, so the route's parent is the cache
      const home = tree.entry("home")!;
      expect(home.parent!.type).toBe("cache");
      expect(home.parent!.cache!.options).toEqual({ ttl: 300 });
    });

    it("cache with routes inside layout", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, cache }) => [
          layout(RootLayout, () => [
            cache({ ttl: 300 }, () => [path("/", HomePage, { name: "home" })]),
          ]),
        ]),
      );

      expect(tree.routes()).toEqual({ home: "/" });
    });

    it("path with orphan layout on a route (children of path)", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }, () => [
              layout(AuthLayout, () => [middleware(mw1)]),
            ]),
          ]),
        ]),
      );

      const home = tree.entry("home")!;
      expect(home.layout).toHaveLength(1);
      expect(home.layout[0].middleware).toHaveLength(1);
    });

    it("three sibling orphan layouts", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            layout(WrapperA, () => [middleware(mw1)]),
            layout(WrapperB, () => [middleware(mw2)]),
            layout(WrapperC, () => [middleware(mw3)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout).toHaveLength(3);
      expect(root.layout[0].middleware[0]).toBe(mw1);
      expect(root.layout[1].middleware[0]).toBe(mw2);
      expect(root.layout[2].middleware[0]).toBe(mw3);
    });

    it("layout with cache child that has routes (not orphan)", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, cache }) => [
          layout(RootLayout, () => [
            cache({ ttl: 300 }, () => [
              path("/", HomePage, { name: "home" }),
              path("/about", AboutPage, { name: "about" }),
            ]),
          ]),
        ]),
      );

      expect(tree.routes()).toEqual({ home: "/", about: "/about" });
    });

    it("intercept inside layout (valid position)", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, intercept }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }),
            path("/detail", ProductDetail, { name: "detail" }),
            intercept("@modal", ".detail", ProductModal),
          ]),
        ]),
      );

      expect(tree.routes()).toEqual({ home: "/", detail: "/detail" });
    });

    it("middleware on route (direct child of path)", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }, () => [middleware(mw1)]),
          ]),
        ]),
      );

      // Route-level middleware is on the route entry
      const home = tree.entry("home")!;
      expect(home.middleware).toHaveLength(1);
    });

    it("include inside layout with routes preserves parent chain", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, include }) => [
          layout(RootLayout, () => [
            include(
              "/blog",
              urls(({ path: p }) => [
                p("/", BlogIndex, { name: "index" }),
                p("/:postId", BlogPost, { name: "post" }),
              ]),
              { name: "blog" },
            ),
          ]),
        ]),
      );

      expect(tree.routes()).toEqual({
        "blog.index": "/blog",
        "blog.post": "/blog/:postId",
      });
      // Routes inside include should have RootLayout as ancestor
      const blogIndex = tree.entry("blog.index")!;
      expect(blogIndex.parent!.type).toBe("layout");
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid patterns - must throw
  // ---------------------------------------------------------------------------

  describe("invalid patterns", () => {
    it("orphan layout containing another layout throws", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout }) => [
            path("/", HomePage, { name: "home" }, () => [
              layout(AuthLayout, () => [layout(RootLayout)]),
            ]),
          ]),
        ),
      ).toThrow("orphan layout cannot contain other layouts as children");
    });

    it("orphan layout containing layout with middleware throws", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout, middleware }) => [
            layout(RootLayout, () => [
              layout(WrapperA, () => [
                middleware(mw1),
                layout(WrapperB, () => [middleware(mw2)]),
              ]),
              path("/", HomePage, { name: "home" }),
            ]),
          ]),
        ),
      ).toThrow("orphan layout cannot contain other layouts as children");
    });

    it("deeply nested orphan layout chain throws at first nesting", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout }) => [
            layout(RootLayout, () => [
              layout(WrapperA, () => [
                layout(WrapperB, () => [layout(WrapperC)]),
              ]),
              path("/", HomePage, { name: "home" }),
            ]),
          ]),
        ),
      ).toThrow("orphan layout cannot contain other layouts as children");
    });

    it("layout inside parallel throws", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout }) => [
            layout(RootLayout, () => [
              path("/", HomePage, { name: "home" }, () => [
                layout(AuthLayout, () => [layout(RootLayout)]),
              ]),
            ]),
          ]),
        ),
      ).toThrow("orphan layout cannot contain other layouts as children");
    });

    it("path inside path throws (direct nesting)", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout }) => [
            layout(RootLayout, () => [
              // @ts-expect-error - RouteItem is not in RouteUseItem
              path("/parent", HomePage, { name: "parent" }, () => [
                path("/child", AboutPage, { name: "child" }),
              ]),
            ]),
          ]),
        ),
      ).toThrow("path() cannot be nested inside another path()");
    });

    it("path inside layout inside path throws", () => {
      expect(() =>
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
        ),
      ).toThrow("path() cannot be nested inside another path()");
    });

    it("path inside cache inside path throws", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout, cache }) => [
            layout(RootLayout, () => [
              path("/parent", HomePage, { name: "parent" }, () => [
                cache({ ttl: 300 }, () => [
                  path("/child", AboutPage, { name: "child" }),
                ]),
              ]),
            ]),
          ]),
        ),
      ).toThrow("path() cannot be nested inside another path()");
    });

    it("duplicate route names throw", () => {
      expect(() =>
        buildRouteTree(
          urls(({ path, layout }) => [
            layout(RootLayout, () => [
              path("/", HomePage, { name: "home" }),
              path("/about", AboutPage, { name: "home" }),
            ]),
          ]),
        ),
      ).toThrow("Duplicate route name");
    });
  });

  // ---------------------------------------------------------------------------
  // Structural validation - segment hierarchy
  // ---------------------------------------------------------------------------

  describe("segment hierarchy", () => {
    it("orphan layout on route gets correct shortCode under route", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            path("/", HomePage, { name: "home" }, () => [
              layout(AuthLayout, () => [middleware(mw1)]),
            ]),
          ]),
        ]),
      );

      const home = tree.entry("home")!;
      expect(home.shortCode).toBe("M0L0L0R0");
      expect(home.layout[0].shortCode).toBe("M0L0L0R0L0");
    });

    it("orphan layout on layout gets correct shortCode under layout", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [middleware(mw1)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.shortCode).toBe("M0L0L0");
      expect(root.layout[0].shortCode).toBe("M0L0L0L0");
    });

    it("orphan cache wraps subsequent siblings including orphan layouts", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, cache, middleware }) => [
          layout(RootLayout, () => [
            cache({ ttl: 300 }),
            layout(AuthLayout, () => [middleware(mw1)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      // Route's parent is the cache (orphan cache replaces ctx.parent)
      const home = tree.entry("home")!;
      expect(home.parent!.type).toBe("cache");
      // The orphan layout attaches to the cache's layout array
      expect(home.parent!.layout).toHaveLength(1);
      expect(home.parent!.layout[0].type).toBe("layout");
    });

    it("orphan layout parent pointer is null", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            layout(AuthLayout, () => [middleware(mw1)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      const root = tree.entry("home")!.parent!;
      expect(root.layout[0].parent).toBeNull();
    });

    it("middleware chain only includes parent chain, not orphan layout middleware", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware }) => [
          layout(RootLayout, () => [
            middleware(mw1),
            layout(AuthLayout, () => [middleware(mw2)]),
            path("/", HomePage, { name: "home" }),
          ]),
        ]),
      );

      // Only mw1 from RootLayout is in the parent chain.
      // mw2 from the orphan AuthLayout is NOT in the middleware chain
      // (it's applied at render time via segment resolution instead).
      const chain = tree.middlewareChain("home");
      expect(chain).toEqual([{ segmentId: "M0L0L0", count: 1 }]);
    });

    it("include inside layout preserves parent chain for middleware", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware, include }) => [
          layout(RootLayout, () => [
            middleware(mw1),
            include(
              "/blog",
              urls(({ path: p }) => [p("/", BlogIndex, { name: "index" })]),
              { name: "blog" },
            ),
          ]),
        ]),
      );

      const chain = tree.middlewareChain("blog.index");
      expect(chain).toEqual([{ segmentId: "M0L0L0", count: 1 }]);
    });

    it("layout wrapping include preserves layout parent for middleware", () => {
      const tree = buildRouteTree(
        urls(({ path, layout, middleware, include }) => [
          layout(RootLayout, () => [
            middleware(mw1),
            layout(AuthLayout, () => [
              middleware(mw2),
              include(
                "/blog",
                urls(({ path: p }) => [p("/", BlogIndex, { name: "index" })]),
                { name: "blog" },
              ),
            ]),
          ]),
        ]),
      );

      const chain = tree.middlewareChain("blog.index");
      expect(chain).toEqual([
        { segmentId: "M0L0L0", count: 1 },
        { segmentId: "M0L0L0L0", count: 1 },
      ]);
    });
  });
});
