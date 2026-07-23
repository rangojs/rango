import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import { buildRouteTrie } from "../../build/route-trie.js";
import { setRouterTrie } from "../../route-map-builder.js";
import {
  flattenLeafEntries,
  buildPrecomputedByPrefix,
} from "../../build/prefix-tree-utils.js";
import { evaluateLazyEntry } from "../lazy-includes.js";
import { createFindMatch } from "../find-match.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import { RangoContext } from "../../server/context.js";
import type { RouteEntry } from "../../types.js";
import type { EntryData } from "../../server/context.js";

// ---------------------------------------------------------------------------
// Regression: two distinct leaf includes that extract the SAME staticPrefix
// (a dynamic param collapses their literal prefixes onto the same value, e.g.
// include("/shop/:cat", ...) and include("/shop/:brand", ...) both -> "/shop")
// must not have their precomputed routes collapsed last-wins into one map
// entry. The old getPrecomputedByPrefix did
// `new Map(entries.map(e => [e.staticPrefix, e.routes]))`, silently dropping one
// include's routes and mis-assigning the survivor's routes to whichever lazy
// entry evaluated first. Combined with the timing-blind prefixIsShared guard
// (which counts only already-spliced routesEntries and cannot see a nested
// sibling not yet discovered), this assigned include A's entry the routes of
// include B, then 500'd the valid B route at render (findMatch selects A's
// entry because its corrupted routes contain B's key, but A's handler never
// registers B's route -> Store.manifest.has(routeKey) invariant fails). The fix
// omits any shared staticPrefix from the precomputed shortcut so those includes
// resolve via the handler path (ground truth). dev/prod identical.
// ---------------------------------------------------------------------------

const Div = createElement("div");

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
  } as unknown as EntryData;
}

type Precomputed = Array<{
  staticPrefix: string;
  routes: Record<string, string>;
}>;

async function flattenFor(
  patterns: ReturnType<typeof urls>,
): Promise<Precomputed> {
  const manifest = await generateManifestFull(patterns, 0);
  const result: Precomputed = [];
  flattenLeafEntries(manifest.prefixTree, manifest.routeManifest, result);
  return result;
}

describe("precomputed prefix collision (shared staticPrefix across leaf includes)", () => {
  // Precondition: a real urls() config with two sibling param-prefixed includes
  // genuinely produces two leaf entries that share a staticPrefix. If this stops
  // being true the collision can no longer arise — but the guard below is cheap.
  it("a real two-sibling-include config flattens to duplicate-staticPrefix leaf entries", async () => {
    const catLeaf = urls(({ path }) => [
      path("/page", () => null, { name: "page" }),
    ]);
    const brandLeaf = urls(({ path }) => [
      path("/list", () => null, { name: "list" }),
    ]);
    const root = urls(({ include }) => [
      include("/shop/:cat", catLeaf, { name: "cat" }),
      include("/shop/:brand", brandLeaf, { name: "brand" }),
    ]);

    const entries = await flattenFor(root);
    const shop = entries.filter((e) => e.staticPrefix === "/shop");
    expect(shop).toHaveLength(2);
    expect(shop[0]!.routes).toHaveProperty("cat.page");
    expect(shop[1]!.routes).toHaveProperty("brand.list");
  });

  it("naive last-wins collapse loses routes; buildPrecomputedByPrefix omits the shared prefix", async () => {
    const entries: Precomputed = [
      { staticPrefix: "/shop", routes: { "cat.page": "/shop/:cat/page" } },
      { staticPrefix: "/shop", routes: { "brand.list": "/shop/:brand/list" } },
      { staticPrefix: "/blog", routes: { "blog.index": "/blog/" } },
    ];

    // The old behavior (documented so a future revert is caught): last-wins.
    const naive = new Map(entries.map((e) => [e.staticPrefix, e.routes]));
    expect(naive.get("/shop")).not.toHaveProperty("cat.page");
    expect(naive.get("/shop")).toHaveProperty("brand.list");

    // The fix: shared "/shop" is omitted entirely; unshared "/blog" is kept.
    const fixed = buildPrecomputedByPrefix(entries);
    expect(fixed.has("/shop")).toBe(false);
    expect(fixed.get("/blog")).toEqual({ "blog.index": "/blog/" });
  });

  // The consequence at the runtime path: evaluateLazyEntry must NOT take the
  // shortcut for a shared-prefix entry, even when only one owner is currently
  // live in routesEntries (the timing-blind window). Under the old collapse it
  // assigned the sibling's routes; under the fix it falls through to the handler
  // and registers its OWN routes.
  describe("evaluateLazyEntry on a shared-prefix entry with only one owner live", () => {
    function makeCatEntry(): RouteEntry & { _lazyPrefix?: string } {
      const catLeaf = urls(({ path }) => [
        path("/page", () => null, { name: "page" }),
      ]);
      return {
        prefix: "",
        staticPrefix: "/shop",
        routes: {},
        handler: catLeaf.handler,
        mountIndex: 1,
        routerId: "collision-test",
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: catLeaf,
        _lazyPrefix: "/shop/:cat",
        lazyContext: {
          urlPrefix: "",
          namePrefix: "cat",
          parent: makeSyntheticRoot(),
          counters: {},
        },
      } as unknown as RouteEntry & { _lazyPrefix?: string };
    }

    const precomputedSource: Precomputed = [
      { staticPrefix: "/shop", routes: { "cat.page": "/shop/:cat/page" } },
      { staticPrefix: "/shop", routes: { "brand.list": "/shop/:brand/list" } },
    ];

    function makeDeps(
      routesEntries: RouteEntry[],
      getPrecomputedByPrefix: () => Map<string, Record<string, string>> | null,
    ) {
      let nextMount = 100;
      return {
        routesEntries,
        mergedRouteMap: {} as Record<string, string>,
        nextMountIndex: () => nextMount++,
        getPrecomputedByPrefix,
        routerId: "collision-test",
      };
    }

    it("OLD last-wins collapse mis-assigns the sibling include's routes (documents the bug)", async () => {
      const catEntry = makeCatEntry();
      // Only catEntry is live (brand's nested entry not yet spliced) ->
      // prefixIsShared sees count 1 and does NOT skip. The naive collapsed map
      // returns brand's routes for "/shop".
      const naiveMap = new Map(
        precomputedSource.map((e) => [e.staticPrefix, e.routes]),
      );
      const deps = makeDeps([catEntry], () => naiveMap);

      evaluateLazyEntry(catEntry, deps);

      // Bug: cat's entry now owns BRAND's routes, and its own route is missing.
      expect(catEntry.routes).toHaveProperty("brand.list");
      expect(catEntry.routes).not.toHaveProperty("cat.page");
    });

    it("FIX: buildPrecomputedByPrefix omits the shared prefix, so the handler runs and registers cat's own routes", async () => {
      const catEntry = makeCatEntry();
      const deps = makeDeps([catEntry], () =>
        buildPrecomputedByPrefix(precomputedSource),
      );

      evaluateLazyEntry(catEntry, deps);

      // Fixed: the handler path runs and registers cat's OWN route; brand's
      // routes never leak in.
      expect(catEntry.routes).toHaveProperty("cat.page");
      expect(catEntry.routes).not.toHaveProperty("brand.list");
    });
  });

  // ---------------------------------------------------------------------------
  // Request-path consequence — the deterministic, controlled-isolate proof of
  // the 500. A live HTTP e2e cannot reliably reproduce this: the corruption
  // requires the top-level entry to be evaluated BEFORE its nested sibling is
  // spliced (prefixIsShared sees count 1), which only happens if a "/shop"
  // request is the very first handler-triggering request to a cold isolate —
  // an ordering that a shared Playwright worker/dev-server isolate (plus
  // build-time route discovery, which also evaluates handlers) cannot
  // guarantee. So we drive the real findMatch -> evaluateLazyEntry ->
  // loadManifest chain in the exact temporal sequence here instead.
  //
  // Sequence: (A) the live top-level "cat" entry is evaluated while alone, then
  // (B) the nested "brand" sibling is spliced in, then (C) a request for the
  // brand route arrives. Under the old collapse, (A) corrupts the cat entry with
  // brand's routes, so in (C) findMatch selects the cat entry (its corrupted
  // routes contain brand's key and it sorts first) and loadManifest then runs
  // cat's handler for brand's routeKey -> RouteNotFoundError (500) on a valid
  // route. The fix prevents (A)'s corruption, so (C) selects the real brand
  // entry and renders.
  describe("request-path consequence (findMatch + loadManifest)", () => {
    beforeEach(() => {
      clearManifestCache();
    });

    const PRECOMPUTED: Precomputed = [
      { staticPrefix: "/shop", routes: { "cat.page": "/shop/:cat/page" } },
      { staticPrefix: "/shop", routes: { "brand.list": "/shop/:brand/list" } },
    ];

    function makeEntry(
      namePrefix: string,
      lazyPrefix: string,
      leafPath: string,
      leafName: string,
      mountIndex: number,
      routerId: string,
    ): RouteEntry & { _lazyPrefix?: string } {
      const leaf = urls(({ path }) => [
        path(leafPath, () => null, { name: leafName }),
      ]);
      return {
        prefix: "",
        staticPrefix: "/shop",
        routes: {},
        handler: leaf.handler,
        mountIndex,
        routerId,
        lazy: true,
        lazyEvaluated: false,
        lazyPatterns: leaf,
        _lazyPrefix: lazyPrefix,
        lazyContext: {
          urlPrefix: "",
          namePrefix,
          parent: makeSyntheticRoot(mountIndex),
          counters: {},
        },
      } as unknown as RouteEntry & { _lazyPrefix?: string };
    }

    // Run the A -> B -> C sequence and return the selected entry's identity plus
    // the result of loading the manifest for the matched route. `fixed` chooses
    // the collapsed (old) vs buildPrecomputedByPrefix (fixed) shortcut map.
    async function runRequestPath(fixed: boolean, routerId: string) {
      setRouterTrie(
        routerId,
        buildRouteTrie(
          { "cat.page": "/shop/:cat/page", "brand.list": "/shop/:brand/list" },
          { "cat.page": "/shop", "brand.list": "/shop" },
        ),
      );
      const getMap = () =>
        fixed
          ? buildPrecomputedByPrefix(PRECOMPUTED)
          : new Map(PRECOMPUTED.map((e) => [e.staticPrefix, e.routes]));

      const cat = makeEntry("cat", "/shop/:cat", "/page", "page", 1, routerId);
      const routesEntries: RouteEntry[] = [cat];
      const depsFor = (entries: RouteEntry[]) => ({
        routesEntries: entries,
        mergedRouteMap: {} as Record<string, string>,
        nextMountIndex: () => 100,
        getPrecomputedByPrefix: getMap,
        routerId,
      });

      // (A) cat evaluated while alone.
      evaluateLazyEntry(cat, depsFor(routesEntries));
      // (B) brand sibling spliced in.
      const brand = makeEntry(
        "brand",
        "/shop/:brand",
        "/list",
        "list",
        2,
        routerId,
      );
      routesEntries.push(brand);
      // (C) request the brand route.
      const fm = createFindMatch({
        routesEntries,
        evaluateLazyEntry: (e) => evaluateLazyEntry(e, depsFor(routesEntries)),
        routerId,
      });
      const match = await fm("/shop/nike/list");
      const selected =
        match?.entry === cat
          ? "cat"
          : match?.entry === brand
            ? "brand"
            : "none";

      let loadError: unknown;
      let loaded = false;
      await RangoContext.run(
        {
          manifest: new Map(),
          patterns: new Map(),
          patternsByPrefix: new Map(),
          trailingSlash: new Map(),
          namespace: "root",
          parent: makeSyntheticRoot(),
          counters: {},
          mountIndex: 0,
        },
        async () => {
          try {
            await loadManifest(
              match!.entry,
              match!.routeKey,
              "/shop/nike/list",
            );
            loaded = true;
          } catch (e) {
            loadError = e;
          }
        },
      );

      return { selected, routeKey: match?.routeKey, loaded, loadError };
    }

    it("OLD collapse: brand request is routed to the wrong include and loadManifest 500s", async () => {
      const r = await runRequestPath(false, "c19-reqpath-old");
      expect(r.routeKey).toBe("brand.list");
      // findMatch selected cat's entry for brand's route...
      expect(r.selected).toBe("cat");
      // ...and rendering it fails: cat's handler never registers brand.list.
      expect(r.loaded).toBe(false);
      expect(r.loadError).toBeInstanceOf(Error);
    });

    it("FIX: brand request is routed to the brand include and renders", async () => {
      const r = await runRequestPath(true, "c19-reqpath-fix");
      expect(r.routeKey).toBe("brand.list");
      expect(r.selected).toBe("brand");
      expect(r.loaded).toBe(true);
      expect(r.loadError).toBeUndefined();
    });
  });
});
