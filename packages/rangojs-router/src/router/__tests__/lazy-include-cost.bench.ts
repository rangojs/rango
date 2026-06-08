import { bench, describe } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import { RangoContext } from "../../server/context.js";
import { evaluateLazyEntry } from "../lazy-includes.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import type { RouteEntry } from "../../types.js";
import type { EntryData } from "../../server/context.js";

// Lazy-include handler-execution cost benchmark (run: `vitest bench lazy-include-cost`).
//
// Quantifies the LP3 "double run": a non-leaf include's handler runs once at
// match time (evaluateLazyEntry, to populate entry.routes + discover nested
// includes) and again at render time (loadManifest, to build the EntryData tree
// under the per-request store). This bench measures each phase so the LP3
// deferral decision is backed by numbers, not estimates.
//
// Reading it:
//   match     - the LP3 redundant run (subtract the `baseline: construct` row).
//   render    - the unavoidable cold render build (first request).
//   warm      - every request after the first (loadManifest cache hit).
// Measured ~0.75us/route for the redundant run; ~50% of manifest-build but a
// fraction of a percent of a real RSC request, amortized to ~0 by the warm
// cache. See docs/internal/matching-stability-review.md (LP3).

const Page = createElement("div");
let mountSeq = 0;

function makeRoot(mi: number): EntryData {
  return {
    type: "layout",
    id: `#r${mi}`,
    shortCode: `M${mi}L0`,
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

// Non-leaf include: `size` direct routes + a nested include() — so it is never
// precomputed and always takes the handler path (the LP3 double-run shape).
function makeNonLeafEntry(size: number) {
  const mountIndex = mountSeq++;
  const nested = urls<any>(({ path }) => [
    path("/deep", Page, { name: "deep" }),
  ]);
  const patterns = urls<any>(({ path, include }) => {
    const items: any[] = [];
    for (let i = 0; i < size; i++) {
      items.push(path(`/r${i}`, Page, { name: `r${i}` }));
    }
    items.push(include("/inner", nested, { name: "inner" }));
    return items;
  });
  const entry: RouteEntry & { _lazyPrefix?: string } = {
    prefix: "",
    staticPrefix: "/group",
    routes: {},
    handler: patterns.handler,
    mountIndex,
    routerId: "lp3-bench",
    lazy: true,
    lazyEvaluated: false,
    lazyPatterns: patterns,
    _lazyPrefix: "/group",
    lazyContext: {
      urlPrefix: "",
      namePrefix: "group",
      parent: makeRoot(mountIndex),
      counters: {},
    },
  } as unknown as RouteEntry;
  return { entry, routeKey: "group.r0" };
}

function depsFor(routesEntries: RouteEntry[]) {
  return {
    routesEntries,
    mergedRouteMap: {} as Record<string, string>,
    nextMountIndex: () => 100,
    getPrecomputedByPrefix: () => null, // non-leaf: never precomputed
    routerId: "lp3-bench",
  };
}

async function render(entry: RouteEntry, routeKey: string) {
  await RangoContext.run(
    {
      manifest: new Map(),
      patterns: new Map(),
      patternsByPrefix: new Map(),
      trailingSlash: new Map(),
      namespace: "root",
      parent: makeRoot(mountSeq++),
      counters: {},
      mountIndex: 0,
    } as any,
    async () => {
      await loadManifest(entry, routeKey, "/group/r0");
    },
  );
}

for (const size of [5, 50]) {
  describe(`lazy non-leaf include (${size} direct routes)`, () => {
    bench("baseline: construct entry", () => {
      makeNonLeafEntry(size);
    });

    // The LP3 redundant run: handler exec + route population + nested discovery.
    bench("match: evaluateLazyEntry (LP3 redundant run)", () => {
      const { entry } = makeNonLeafEntry(size);
      evaluateLazyEntry(entry, depsFor([entry]));
    });

    // The unavoidable cold render build (first request).
    bench("render cold: loadManifest first call", async () => {
      clearManifestCache();
      const { entry, routeKey } = makeNonLeafEntry(size);
      evaluateLazyEntry(entry, depsFor([entry]));
      await render(entry, routeKey);
    });

    // Every request after the first: loadManifest cache hit.
    let warmEntry: RouteEntry;
    let warmKey: string;
    bench(
      "warm: loadManifest cache hit",
      async () => {
        await render(warmEntry, warmKey);
      },
      {
        setup: async () => {
          clearManifestCache();
          const made = makeNonLeafEntry(size);
          warmEntry = made.entry;
          warmKey = made.routeKey;
          evaluateLazyEntry(warmEntry, depsFor([warmEntry]));
          await render(warmEntry, warmKey); // populate the cache
        },
      },
    );
  });
}
