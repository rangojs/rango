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
    parallel: [],
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
  });
});
