import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { getContext, RangoContext } from "../../server/context.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import type { RouteEntry } from "../../types.js";
import { urls } from "../../urls.js";
import {
  isRouteRootScoped,
  clearAllRouterData,
} from "../../route-map-builder.js";

/**
 * Tests for the module-level manifest cache in loadManifest().
 *
 * The manifest cache stores the handler output per (VERSION, mountIndex, routeKey, isSSR)
 * for the lifetime of the isolate. After the first request, subsequent calls should
 * return cached data without re-executing the handler.
 */

// Build a minimal RouteEntry with a spy handler that registers an entry
// in the Store manifest (mimicking what the real DSL helpers do).
function createTestEntry(routeKey: string, handlerSpy: () => void): RouteEntry {
  return {
    prefix: "/",
    staticPrefix: "/",
    routes: { [routeKey]: "/" },
    handler: () => {
      handlerSpy();
      // Simulate what the DSL helpers do: register an entry in the manifest.
      const ctx = getContext();
      const store = ctx.getStore();
      const layoutEntry = {
        id: "root",
        shortCode: "L0",
        type: "layout" as const,
        handler: createElement("div"),
        parent: null,
        middleware: [],
        revalidate: [],
        errorBoundary: [],
        notFoundBoundary: [],
        loader: [],
        layout: [],
        parallel: {},
        intercept: [],
      };
      store.manifest.set("root", layoutEntry);

      const routeEntry = {
        id: routeKey,
        shortCode: "R0",
        type: "route" as const,
        handler: () => createElement("div"),
        parent: layoutEntry,
        middleware: [],
        revalidate: [],
        errorBoundary: [],
        notFoundBoundary: [],
        loader: [],
        layout: [],
        parallel: {},
        intercept: [],
      };
      store.manifest.set(routeKey, routeEntry);

      return [
        { type: "layout", id: "root" },
        { type: "route", id: routeKey },
      ];
    },
    mountIndex: 0,
  } as unknown as RouteEntry;
}

describe("manifest module-level cache", () => {
  beforeEach(() => {
    clearManifestCache();
  });

  it("executes handler only once for the same route key", async () => {
    const handlerSpy = vi.fn();
    const routeKey = "testRoute";
    const entry = createTestEntry(routeKey, handlerSpy);

    // Must run inside the ALS context since loadManifest uses getContext()
    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        // First call: should execute the handler
        const result1 = await loadManifest(
          entry,
          routeKey,
          "/",
          undefined,
          false,
        );
        expect(handlerSpy).toHaveBeenCalledTimes(1);
        expect(result1).toBeDefined();
        expect(result1.type).toBe("route");

        // Second call: should return from cache without executing handler
        const result2 = await loadManifest(
          entry,
          routeKey,
          "/",
          undefined,
          false,
        );
        expect(handlerSpy).toHaveBeenCalledTimes(1);
        expect(result2).toBeDefined();
        expect(result2.type).toBe("route");
      },
    );
  });

  it("caches SSR and non-SSR entries separately", async () => {
    const handlerSpy = vi.fn();
    const routeKey = "ssrTest";
    const entry = createTestEntry(routeKey, handlerSpy);

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        // First call with isSSR=false
        await loadManifest(entry, routeKey, "/", undefined, false);
        expect(handlerSpy).toHaveBeenCalledTimes(1);

        // Second call with isSSR=true — different cache key, handler runs again
        await loadManifest(entry, routeKey, "/", undefined, true);
        expect(handlerSpy).toHaveBeenCalledTimes(2);

        // Third call with isSSR=false — cached from first call
        await loadManifest(entry, routeKey, "/", undefined, false);
        expect(handlerSpy).toHaveBeenCalledTimes(2);

        // Fourth call with isSSR=true — cached from second call
        await loadManifest(entry, routeKey, "/", undefined, true);
        expect(handlerSpy).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("restores cached manifest into the request-scoped Store", async () => {
    const handlerSpy = vi.fn();
    const routeKey = "restoreTest";
    const entry = createTestEntry(routeKey, handlerSpy);

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        // First call populates cache
        await loadManifest(entry, routeKey, "/", undefined, false);

        // Clear the current Store's manifest to simulate a fresh request
        const store = getContext().getOrCreateStore(routeKey);
        store.manifest.clear();
        expect(store.manifest.size).toBe(0);

        // Second call should restore entries from module cache into Store
        await loadManifest(entry, routeKey, "/", undefined, false);
        expect(store.manifest.size).toBeGreaterThan(0);
        expect(store.manifest.has(routeKey)).toBe(true);
      },
    );
  });

  it("cache-hit alias survives a subsequent fresh load (no cache poisoning)", async () => {
    // Regression: on a cache-hit loadManifest aliases the request-scoped
    // Store.manifest to the shared module-cache Map. A later fresh load of a
    // DIFFERENT route on the same ambient Store must not mutate that aliased
    // Map (the fresh path reassigns Store.manifest instead of clearing it).
    const spyA = vi.fn();
    const spyB = vi.fn();
    const entryA = createTestEntry("routeA", spyA);
    const entryB = createTestEntry("routeB", spyB);

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        // Fresh load caches routeA's pruned manifest.
        await loadManifest(entryA, "routeA", "/a", undefined, false);
        // Cache-hit aliases Store.manifest to routeA's cached Map.
        await loadManifest(entryA, "routeA", "/a", undefined, false);
        expect(spyA).toHaveBeenCalledTimes(1);

        // Fresh load of a different route on the SAME ambient Store.
        await loadManifest(entryB, "routeB", "/b", undefined, false);
        expect(spyB).toHaveBeenCalledTimes(1);

        // routeA is still cached and uncorrupted: no handler re-run, and its
        // cached Map never picked up routeB's entry.
        const again = await loadManifest(
          entryA,
          "routeA",
          "/a",
          undefined,
          false,
        );
        expect(spyA).toHaveBeenCalledTimes(1);
        expect(again.id).toBe("routeA");
        const store = getContext().getStore();
        expect(store.manifest.has("routeA")).toBe(true);
        expect(store.manifest.has("routeB")).toBe(false);
      },
    );
  });

  it("invalidates cache when clearManifestCache is called", async () => {
    const handlerSpy = vi.fn();
    const routeKey = "clearTest";
    const entry = createTestEntry(routeKey, handlerSpy);

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        await loadManifest(entry, routeKey, "/", undefined, false);
        expect(handlerSpy).toHaveBeenCalledTimes(1);

        // Clear the cache (simulates HMR)
        clearManifestCache();

        // Handler should execute again
        await loadManifest(entry, routeKey, "/", undefined, false);
        expect(handlerSpy).toHaveBeenCalledTimes(2);
      },
    );
  });
});

describe("loadManifest rootScoped propagation for lazy entries", () => {
  beforeEach(() => {
    clearManifestCache();
    clearAllRouterData();
  });

  it("propagates rootScoped=true from lazyContext through runWithStore", async () => {
    // Simulate { name: "" } + nested { name: "sub" }: lazyContext carries rootScoped=true
    const lazyPatterns = urls(({ path }) => [
      path("/", () => createElement("div"), { name: "index" }),
      path("/:id", () => createElement("div"), { name: "detail" }),
    ]);

    const entry: RouteEntry = {
      prefix: "/flat/sub",
      staticPrefix: "/flat/sub",
      routes: {} as any,
      handler: lazyPatterns.handler,
      mountIndex: 0,
      lazy: true,
      lazyPatterns,
      lazyContext: {
        urlPrefix: "",
        namePrefix: "sub",
        parent: null,
        counters: {},
        rootScoped: true,
      },
      lazyEvaluated: false,
    } as unknown as RouteEntry;

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        await loadManifest(entry, "sub.index", "/flat/sub", undefined, false);
      },
    );

    // Routes registered via path() inside the lazy handler should inherit rootScoped=true
    expect(isRouteRootScoped("sub.index")).toBe(true);
    expect(isRouteRootScoped("sub.detail")).toBe(true);
  });

  it("propagates rootScoped=false from lazyContext (named mount boundary)", async () => {
    // Simulate direct { name: "ns" }: lazyContext carries rootScoped=false
    const lazyPatterns = urls(({ path }) => [
      path("/", () => createElement("div"), { name: "child" }),
    ]);

    const entry: RouteEntry = {
      prefix: "/x",
      staticPrefix: "/x",
      routes: {} as any,
      handler: lazyPatterns.handler,
      mountIndex: 0,
      lazy: true,
      lazyPatterns,
      lazyContext: {
        urlPrefix: "",
        namePrefix: "ns",
        parent: null,
        counters: {},
        rootScoped: false,
      },
      lazyEvaluated: false,
    } as unknown as RouteEntry;

    await RangoContext.run(
      {
        manifest: new Map(),
        namespace: "",
        parent: null,
        counters: {},
        patterns: new Map(),
        patternsByPrefix: new Map(),
        trailingSlash: new Map(),
        searchSchemas: new Map(),
      },
      async () => {
        await loadManifest(entry, "ns.child", "/x", undefined, false);
      },
    );

    expect(isRouteRootScoped("ns.child")).toBe(false);
  });
});
