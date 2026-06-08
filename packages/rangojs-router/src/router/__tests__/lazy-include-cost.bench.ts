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
// Quantifies the three deferred lazy-include redundancies so each deferral
// decision is backed by numbers, not estimates. All three are cold-start handler
// runs that amortize to ~0 (the warm `loadManifest` cache). See
// docs/internal/matching-stability-review.md (LP1/LP3/LP4).
//
//   LP3 (this file's per-size benches): a NON-LEAF include's handler runs once at
//     match (evaluateLazyEntry) AND once at render (loadManifest). Read `match`
//     (subtract `baseline: construct`) for the redundant run vs `render cold` for
//     the unavoidable one. Measured ~0.75us/route.
//   LP1: an include with M routes runs its handler once PER ROUTE (loadManifest
//     prunes to forRoute=routeKey, cache keyed by routeKey). Compare "warm all M
//     routes from cold" (M runs) vs "re-hit all M routes" (M cache hits).
//     Measured ~18us/route, paid once per route per isolate.
//   LP4: a cold document request resolves twice (isSSR=false classify, isSSR=true
//     render) — both miss the isSSR-keyed cache. Compare the double vs single
//     resolve. Measured ~20us per cold document request.

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

// A leaf include with `size` sibling routes (no nesting) — the LP1 shape. Each
// distinct routeKey is a separate loadManifest cache entry, so the handler runs
// once per route hit.
function makeMultiRouteInclude(size: number) {
  const mountIndex = mountSeq++;
  const patterns = urls<any>(({ path }) => {
    const items: any[] = [];
    for (let i = 0; i < size; i++) {
      items.push(path(`/r${i}`, Page, { name: `r${i}` }));
    }
    return items;
  });
  const routes: Record<string, string> = {};
  for (let i = 0; i < size; i++) routes[`sub.r${i}`] = `/sub/r${i}`;
  const entry = {
    prefix: "/sub",
    staticPrefix: "/sub",
    routes,
    handler: patterns.handler,
    mountIndex,
    routerId: "lp3-bench",
    lazy: true,
    lazyEvaluated: true,
    lazyPatterns: patterns,
    _lazyPrefix: "/sub",
    lazyContext: {
      urlPrefix: "",
      namePrefix: "sub",
      parent: makeRoot(mountIndex),
      counters: {},
    },
  } as unknown as RouteEntry;
  const keys = Array.from({ length: size }, (_, i) => `sub.r${i}`);
  return { entry, keys };
}

async function render(entry: RouteEntry, routeKey: string, isSSR?: boolean) {
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
      await loadManifest(entry, routeKey, `/sub/${routeKey}`, undefined, isSSR);
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

// LP1 — an include with M routes runs its handler once PER ROUTE on cold start.
// "warm all M from cold" pays M handler runs; "re-hit all M" pays M cache hits.
// The ideal (unpruned cache) would be 1 run + (M-1) hits; the gap is the waste.
const LP1_SIZE = 30;
describe(`LP1: include with ${LP1_SIZE} sibling routes`, () => {
  bench("warm all routes from cold (current: M handler runs)", async () => {
    clearManifestCache();
    const { entry, keys } = makeMultiRouteInclude(LP1_SIZE);
    for (const k of keys) await render(entry, k);
  });

  let warm: ReturnType<typeof makeMultiRouteInclude>;
  bench(
    "re-hit all routes (cache hits only — the amortized steady state)",
    async () => {
      for (const k of warm.keys) await render(warm.entry, k);
    },
    {
      setup: async () => {
        clearManifestCache();
        warm = makeMultiRouteInclude(LP1_SIZE);
        for (const k of warm.keys) await render(warm.entry, k); // populate cache
      },
    },
  );
});

// LP4 — a cold document request resolves twice (isSSR=false classify, isSSR=true
// render); both miss the isSSR-keyed cache, so the handler runs twice. The gap
// between the double and single resolve is the waste.
describe("LP4: cold document request (isSSR double resolve)", () => {
  bench("double resolve: isSSR=false then isSSR=true (current)", async () => {
    clearManifestCache();
    const { entry, keys } = makeMultiRouteInclude(LP1_SIZE);
    await render(entry, keys[0]!, false);
    await render(entry, keys[0]!, true);
  });

  bench("single resolve: isSSR=true only (ideal)", async () => {
    clearManifestCache();
    const { entry, keys } = makeMultiRouteInclude(LP1_SIZE);
    await render(entry, keys[0]!, true);
  });
});
