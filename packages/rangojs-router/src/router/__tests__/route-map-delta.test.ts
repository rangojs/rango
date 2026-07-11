import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import type { RouteEntry } from "../../types.js";
import type { EntryData } from "../../server/context.js";
import { evaluateLazyEntry } from "../lazy-includes.js";
import {
  registerRouteMap,
  getGlobalRouteMap,
  clearCachedManifest,
} from "../../route-map-builder.js";

// Wrap every route-map-builder export in a call-recording spy (real
// implementations still run) so the assertions below can see WHAT
// lazy-includes passes to registerRouteMap, not just the end state.
vi.mock("../../route-map-builder.js", { spy: true });

// Pins the registration cost model of lazy-include expansion (issue #666).
//
// The router seeds `mergedRouteMap` with the FULL generated manifest at
// createRouter() time (router.ts — flattenNamedRoutes(staticRouteNames)), and
// registerRouteMap() at startup copies it into the module-global map. When a
// lazy include later expands on the request path, the global map therefore
// already contains every previously known name — the expansion only needs to
// register its OWN routes (the delta). Passing the whole mergedRouteMap made
// every first hit to an include O(total routes): measured 8.9ms per call on a
// 26k-route app (M4, node), paid once per level of a nested async-include
// chain (3x on a 3-level chain — the 464ms edge cold-hit in issue #666).
//
// Two contracts pinned here:
// 1. Completeness (must survive any refactor): after expansion the global map
//    contains BOTH all pre-existing names AND the newly expanded ones.
// 2. Delta registration (the perf shape): the expansion paths call
//    registerRouteMap with exactly their own new routes, never the full
//    merged map.

const Page = createElement("div");

function makeSyntheticRoot(mountIndex = 0): EntryData {
  return {
    type: "layout",
    id: `#synthetic-maproot-M${mountIndex}`,
    shortCode: `M${mountIndex}L0`,
    parent: null,
    handler: Page,
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

function lazyEntry(
  staticPrefix: string,
  name: string,
  lazyPatterns: unknown,
): RouteEntry & { _lazyPrefix?: string } {
  return {
    prefix: "",
    staticPrefix,
    routes: {},
    handler: Page,
    mountIndex: 0,
    lazy: true,
    lazyEvaluated: false,
    lazyPatterns,
    _lazyPrefix: staticPrefix,
    lazyContext: {
      urlPrefix: "",
      namePrefix: name,
      parent: makeSyntheticRoot(),
      counters: {},
    },
  } as unknown as RouteEntry & { _lazyPrefix?: string };
}

// Simulates the startup state: the router's mergedRouteMap is pre-seeded from
// the generated manifest and already registered into the global map
// (router.ts registerRouteMap(mergedRouteMap) at creation).
const SEEDED: Record<string, string> = {
  "seed.home": "/",
  "seed.about": "/about",
  "seed.deep": "/deep/:id",
};

beforeEach(() => {
  // getGlobalRouteMap() prefers the cached manifest when one is set; these
  // tests assert on the registration-built map, so clear any cache another
  // test file left behind.
  clearCachedManifest();
  registerRouteMap({ ...SEEDED });
  vi.mocked(registerRouteMap).mockClear();
});

describe("lazy-include expansion registers route-map deltas", () => {
  it("async provider expansion: global map keeps pre-existing names and gains the new ones", async () => {
    const groupPatterns = urls<any>(({ path }) => [
      path("/widget", Page, { name: "widget" }),
      path("/gadget/:id", Page, { name: "gadget" }),
    ]);
    const provider = async () => ({ default: groupPatterns });
    const entry = lazyEntry("/group", "group", provider);
    const deps = {
      routesEntries: [entry],
      mergedRouteMap: { ...SEEDED },
      nextMountIndex: () => 100,
      getPrecomputedByPrefix: () => null,
    };

    await evaluateLazyEntry(entry, deps);

    // Completeness: nothing previously registered is lost, new names present.
    const global = getGlobalRouteMap();
    for (const [name, pattern] of Object.entries(SEEDED)) {
      expect(global[name]).toBe(pattern);
    }
    expect(global["group.widget"]).toBe("/group/widget");
    expect(global["group.gadget"]).toBe("/group/gadget/:id");

    // Delta shape: the expansion registered exactly its own routes — not the
    // full mergedRouteMap (which would re-copy every seeded name per level).
    expect(registerRouteMap).toHaveBeenCalledTimes(1);
    const registered = vi.mocked(registerRouteMap).mock.calls[0]![0];
    expect(Object.keys(registered).sort()).toEqual([
      "group.gadget",
      "group.widget",
    ]);
  });

  it("precomputed shortcut: registers only the entry's precomputed routes", () => {
    const precomputedRoutes: Record<string, string> = {
      "leaf.a": "/leaf/a",
      "leaf.b": "/leaf/b/:id",
    };
    const provider = async () => {
      throw new Error("precomputed path must not import the module");
    };
    const entry = lazyEntry("/leaf", "leaf", provider);
    const deps = {
      routesEntries: [entry],
      mergedRouteMap: { ...SEEDED },
      nextMountIndex: () => 100,
      getPrecomputedByPrefix: () =>
        new Map([["/leaf", precomputedRoutes]]) as Map<
          string,
          Record<string, string>
        >,
    };

    const result = evaluateLazyEntry(entry, deps);
    expect(result).toBeUndefined(); // synchronous shortcut, no import

    const global = getGlobalRouteMap();
    for (const [name, pattern] of Object.entries(SEEDED)) {
      expect(global[name]).toBe(pattern);
    }
    expect(global["leaf.a"]).toBe("/leaf/a");
    expect(global["leaf.b"]).toBe("/leaf/b/:id");

    expect(registerRouteMap).toHaveBeenCalledTimes(1);
    const registered = vi.mocked(registerRouteMap).mock.calls[0]![0];
    expect(Object.keys(registered).sort()).toEqual(["leaf.a", "leaf.b"]);
    // deps.mergedRouteMap still receives the merge (reverse() on the router
    // instance reads it), independent of what gets globally registered.
    expect(deps.mergedRouteMap["leaf.a"]).toBe("/leaf/a");
  });

  it("registerRouteMap itself merges (accumulates), never replaces", () => {
    registerRouteMap({ "extra.one": "/one" });
    registerRouteMap({ "extra.two": "/two" });
    const global = getGlobalRouteMap();
    expect(global["extra.one"]).toBe("/one");
    expect(global["extra.two"]).toBe("/two");
    expect(global["seed.home"]).toBe("/");
  });
});
