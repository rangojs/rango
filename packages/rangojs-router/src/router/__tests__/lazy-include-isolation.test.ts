import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import { createLoader } from "../../loader.js";
import type { RouteEntry } from "../../types.js";
import type { EntryData } from "../../server/context.js";
import { getContext, RSCRouterContext } from "../../server/context.js";
import { evaluateLazyEntry } from "../lazy-includes.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import type { MiddlewareFn } from "../middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Div = createElement("div");
const ShopLayout = Div;
const DashboardPage = Div;
const ProductList = Div;

const ShopLoader = (createLoader as Function)(
  async () => ({ items: [] }),
  undefined,
  "test#ShopLoader",
);

const shopMiddleware: MiddlewareFn = async (_ctx, next) => next();

function makeSyntheticRoot(mountIndex = 0): EntryData {
  return {
    type: "layout",
    id: `#synthetic-maproot-M${mountIndex}`,
    shortCode: `M${mountIndex}L0`,
    parent: null,
    handler: Div,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  };
}

function makeLazyEvalDeps(routesEntries: RouteEntry[] = []) {
  let nextMount = 100;
  return {
    routesEntries,
    mergedRouteMap: {} as Record<string, string>,
    nextMountIndex: () => nextMount++,
    getPrecomputedByPrefix: () => null,
  };
}

// ---------------------------------------------------------------------------
// evaluateLazyEntry — real runtime path (lazy-includes.ts)
// ---------------------------------------------------------------------------

describe("lazy include parent isolation", () => {
  describe("evaluateLazyEntry", () => {
    it("does not mutate shared parent when includes have top-level loaders", () => {
      const sharedParent = makeSyntheticRoot();

      // --- Shop include (has top-level loader + middleware) ---
      const shopPatterns = urls<any>(({ path, layout, loader, middleware }) => [
        middleware(shopMiddleware),
        loader(ShopLoader),
        layout(ShopLayout, () => [path("/", ProductList, { name: "index" })]),
      ]);

      // --- Dashboard include (no top-level loaders) ---
      const dashPatterns = urls<any>(({ path }) => [
        path("/", DashboardPage, { name: "index" }),
      ]);

      // Build lazy RouteEntries sharing the same parent
      const counters = {};
      const shopEntry: RouteEntry = {
        prefix: "/shop",
        staticPrefix: "/shop",
        routes: {},
        handler: shopPatterns.handler,
        mountIndex: 1,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: shopPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "shop",
          parent: sharedParent,
          counters: { ...counters },
        },
      } as unknown as RouteEntry;

      const dashEntry: RouteEntry = {
        prefix: "/dashboard",
        staticPrefix: "/dashboard",
        routes: {},
        handler: dashPatterns.handler,
        mountIndex: 2,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: dashPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "dashboard",
          parent: sharedParent,
          counters: { ...counters },
        },
      } as unknown as RouteEntry;

      const deps = makeLazyEvalDeps([shopEntry, dashEntry]);

      // Evaluate shop first — this was the mutation source
      evaluateLazyEntry(shopEntry, deps);

      // Shared parent must remain untouched
      expect(sharedParent.loader).toHaveLength(0);
      expect(sharedParent.middleware).toHaveLength(0);

      // Evaluate dashboard second
      evaluateLazyEntry(dashEntry, deps);

      // Still clean
      expect(sharedParent.loader).toHaveLength(0);
      expect(sharedParent.middleware).toHaveLength(0);

      // Shop routes were registered correctly
      expect(shopEntry.routes).toHaveProperty("shop.index");
      expect(dashEntry.routes).toHaveProperty("dashboard.index");
    });

    it("isolates root-scoped includes with empty prefix and { name: '' }", () => {
      const sharedParent = makeSyntheticRoot();

      // include("", errorPatterns, { name: "" }) — root-scoped, no prefix
      const errorPatterns = urls<any>(({ path, middleware }) => [
        middleware(shopMiddleware),
        path("/error-test", DashboardPage, { name: "errorTest" }),
      ]);

      const dashPatterns = urls<any>(({ path }) => [
        path("/", DashboardPage, { name: "index" }),
      ]);

      // Root-scoped include: prefix="", namePrefix=undefined (name="" doesn't
      // produce a prefix segment). This hits the else branch in
      // evaluateLazyEntry (line 157) where runWithPrefixes is skipped.
      const errorEntry: RouteEntry = {
        prefix: "",
        staticPrefix: "",
        routes: {},
        handler: errorPatterns.handler,
        mountIndex: 5,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: errorPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: undefined,
          parent: sharedParent,
          counters: {},
          rootScoped: true,
        },
      } as unknown as RouteEntry;

      const dashEntry: RouteEntry = {
        prefix: "/dashboard",
        staticPrefix: "/dashboard",
        routes: {},
        handler: dashPatterns.handler,
        mountIndex: 6,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: dashPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "dashboard",
          parent: sharedParent,
          counters: {},
        },
      } as unknown as RouteEntry;

      const deps = makeLazyEvalDeps([errorEntry, dashEntry]);

      evaluateLazyEntry(errorEntry, deps);
      evaluateLazyEntry(dashEntry, deps);

      // Shared parent untouched despite root-scoped include
      expect(sharedParent.middleware).toHaveLength(0);

      // Routes registered correctly (root-scoped = no name prefix)
      expect(errorEntry.routes).toHaveProperty("errorTest");
      expect(dashEntry.routes).toHaveProperty("dashboard.index");
    });
  });

  // -------------------------------------------------------------------------
  // loadManifest — real runtime path (manifest.ts)
  // -------------------------------------------------------------------------

  describe("loadManifest", () => {
    beforeEach(() => {
      clearManifestCache();
    });

    it("does not leak loaders from one lazy include into another", async () => {
      const sharedParent = makeSyntheticRoot();

      // Shop patterns with a top-level loader
      const shopPatterns = urls<any>(({ path, loader }) => [
        loader(ShopLoader),
        path("/", ProductList, { name: "index" }),
      ]);

      // Dashboard patterns without loaders
      const dashPatterns = urls<any>(({ path }) => [
        path("/", DashboardPage, { name: "index" }),
      ]);

      const shopRouteEntry: RouteEntry = {
        prefix: "/shop",
        staticPrefix: "/shop",
        routes: { "shop.index": "/shop/" } as any,
        handler: shopPatterns.handler,
        mountIndex: 1,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: shopPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "shop",
          parent: sharedParent,
          counters: {},
        },
      } as unknown as RouteEntry;

      const dashRouteEntry: RouteEntry = {
        prefix: "/dashboard",
        staticPrefix: "/dashboard",
        routes: { "dashboard.index": "/dashboard/" } as any,
        handler: dashPatterns.handler,
        mountIndex: 2,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: dashPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "dashboard",
          parent: sharedParent,
          counters: {},
        },
      } as unknown as RouteEntry;

      // loadManifest requires being inside RSCRouterContext
      await RSCRouterContext.run(
        {
          manifest: new Map(),
          patterns: new Map(),
          patternsByPrefix: new Map(),
          trailingSlash: new Map(),
          namespace: "root",
          parent: sharedParent,
          counters: {},
          mountIndex: 0,
        },
        async () => {
          // Load shop manifest first (adds ShopLoader to its isolated parent)
          const shopManifest = await loadManifest(
            shopRouteEntry,
            "shop.index",
            "/shop/",
          );

          // Load dashboard manifest second
          const dashManifest = await loadManifest(
            dashRouteEntry,
            "dashboard.index",
            "/dashboard/",
          );

          // Shared parent must remain untouched
          expect(sharedParent.loader).toHaveLength(0);
          expect(sharedParent.middleware).toHaveLength(0);

          // Shop's parent chain should have the shop loader
          expect(shopManifest.parent!.loader).toHaveLength(1);
          expect(shopManifest.parent!.loader[0].loader).toBe(ShopLoader);

          // Dashboard's parent chain must NOT have the shop loader
          let dashCurrent: EntryData | null = dashManifest.parent;
          while (dashCurrent) {
            expect(dashCurrent.loader).toHaveLength(0);
            dashCurrent = dashCurrent.parent;
          }
        },
      );
    });

    it("does not leak intercepts, layouts, or revalidation into sibling include ancestry (prerender path)", async () => {
      const sharedParent = makeSyntheticRoot();

      const shopRevalidation = () => false;

      // Shop patterns: intercept + orphan layout + revalidation at top level
      const shopPatterns = urls<any>(
        ({ path, layout, intercept, revalidate }) => [
          revalidate(shopRevalidation),
          layout(ShopLayout, () => [
            intercept("@modal", ".detail", Div, () => []),
            path("/", ProductList, { name: "index" }),
            path("/:slug", Div, { name: "detail" }),
          ]),
        ],
      );

      // Blog patterns: nothing at top level
      const blogPatterns = urls<any>(({ path }) => [
        path("/", Div, { name: "index" }),
      ]);

      const shopRouteEntry: RouteEntry = {
        prefix: "/shop",
        staticPrefix: "/shop",
        routes: { "shop.index": "/shop/" } as any,
        handler: shopPatterns.handler,
        mountIndex: 3,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: shopPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "shop",
          parent: sharedParent,
          counters: {},
        },
      } as unknown as RouteEntry;

      const blogRouteEntry: RouteEntry = {
        prefix: "/blog",
        staticPrefix: "/blog",
        routes: { "blog.index": "/blog/" } as any,
        handler: blogPatterns.handler,
        mountIndex: 4,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: blogPatterns,
        lazyContext: {
          urlPrefix: "",
          namePrefix: "blog",
          parent: sharedParent,
          counters: {},
        },
      } as unknown as RouteEntry;

      await RSCRouterContext.run(
        {
          manifest: new Map(),
          patterns: new Map(),
          patternsByPrefix: new Map(),
          trailingSlash: new Map(),
          namespace: "root",
          parent: sharedParent,
          counters: {},
          mountIndex: 0,
        },
        async () => {
          // Load shop first — pushes revalidation to its isolated parent
          await loadManifest(shopRouteEntry, "shop.index", "/shop/");

          // Then blog
          const blogManifest = await loadManifest(
            blogRouteEntry,
            "blog.index",
            "/blog/",
          );

          // Walk blog's ancestry exactly as matchForPrerender does (lines 214-229)
          // and verify nothing leaked from shop
          let current: EntryData | null = blogManifest;
          while (current) {
            expect(current.intercept).toHaveLength(0);
            expect(current.revalidate).toHaveLength(0);
            // layout array = orphan layouts attached to this entry
            if (current.parent === null) {
              // root entry — should have no orphan layouts from shop
              expect(current.layout).toHaveLength(0);
            }
            current = current.parent;
          }

          // Shared parent still untouched
          expect(sharedParent.intercept).toHaveLength(0);
          expect(sharedParent.revalidate).toHaveLength(0);
          expect(sharedParent.layout).toHaveLength(0);
        },
      );
    });
  });
});
