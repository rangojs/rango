import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import type { RouteEntry } from "../../types.js";
import type { EntryData } from "../../server/context.js";
import { RangoContext } from "../../server/context.js";
import { evaluateLazyEntry } from "../lazy-includes.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { getRouterPrecomputedEntries } from "../../route-map-builder.js";

// Empirical confirmation that include() is REALLY lazy, plus a measurement of
// how many times an included module's handler actually runs across the request
// lifecycle (the efficiency question: is there redundant double execution?).
//
// These tests drive the real evaluateLazyEntry (match-time) and loadManifest
// (render-time) code paths directly — the same functions the router calls — so
// the counts reflect production behavior. (createRouter() itself can't be
// imported here because router.ts pulls in a `virtual:` module; the lazy
// behavior lives entirely in the functions exercised below.)

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

// A lazy placeholder entry whose included urls() handler increments a counter
// every time it runs, so we can observe exactly when evaluation happens.
function makeCountingLazyEntry(
  mountIndex: number,
  name = "sub",
  prefix = "/sub",
) {
  let runs = 0;
  const patterns = urls<any>(({ path }) => {
    runs++;
    return [path("/", Page, { name: "index" })];
  });
  const entry: RouteEntry & { _lazyPrefix?: string } = {
    prefix,
    staticPrefix: prefix,
    routes: { [`${name}.index`]: `${prefix}/` } as any,
    handler: patterns.handler,
    mountIndex,
    lazy: true,
    lazyEvaluated: false,
    lazyPatterns: patterns,
    _lazyPrefix: prefix,
    lazyContext: {
      urlPrefix: "",
      namePrefix: name,
      parent: makeSyntheticRoot(mountIndex),
      counters: {},
    },
  } as unknown as RouteEntry;
  return { entry, runs: () => runs, routeKey: `${name}.index` };
}

async function runLoadManifest(entry: RouteEntry, routeKey: string) {
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
    } as any,
    async () => {
      await loadManifest(entry, routeKey, "/sub/");
    },
  );
}

// ---------------------------------------------------------------------------
// Part A — include() defers evaluation (does it really lazy things?)
// ---------------------------------------------------------------------------

describe("include() is lazy", () => {
  it("defining urls() does not run the handler", () => {
    let runs = 0;
    urls<any>(({ path }) => {
      runs++;
      return [path("/x", Page, { name: "x" })];
    });
    expect(runs).toBe(0);
  });

  it("a placeholder lazy entry runs its handler only when matched; an unmatched sibling never runs", () => {
    const sub = makeCountingLazyEntry(50, "sub", "/sub");
    const other = makeCountingLazyEntry(51, "other", "/other");

    // Construction state: the placeholder entries exist (routes seeded from the
    // gen-file/build manifest) but neither included handler has run yet.
    expect(sub.runs()).toBe(0);
    expect(other.runs()).toBe(0);

    const deps = {
      routesEntries: [sub.entry, other.entry],
      mergedRouteMap: {} as Record<string, string>,
      nextMountIndex: () => 100,
      getPrecomputedByPrefix: () => null,
    };

    // A request matching /sub evaluates ONLY the /sub include.
    evaluateLazyEntry(sub.entry, deps);
    expect(sub.runs()).toBe(1);
    expect(other.runs()).toBe(0);

    // The unmatched /other include is never evaluated — this is the core
    // laziness benefit: an isolate only pays for the includes it actually serves.
  });

  it("re-matching an already-evaluated include does not re-run its handler (match path)", () => {
    const sub = makeCountingLazyEntry(52, "sub", "/sub");
    const deps = {
      routesEntries: [sub.entry],
      mergedRouteMap: {} as Record<string, string>,
      nextMountIndex: () => 100,
      getPrecomputedByPrefix: () => null,
    };
    evaluateLazyEntry(sub.entry, deps);
    expect(sub.runs()).toBe(1);
    // lazyEvaluated is now true -> a second match-time evaluation is a no-op.
    evaluateLazyEntry(sub.entry, deps);
    expect(sub.runs()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Part B — handler-execution count across match-time + render-time + repeat
// (measures the double execution and the precomputed shortcut's actual value)
// ---------------------------------------------------------------------------

describe("included handler execution count across the request lifecycle", () => {
  beforeEach(() => clearManifestCache());

  it("WITHOUT the precomputed shortcut: runs at match (evaluateLazyEntry) AND render (loadManifest)", async () => {
    const { entry, runs, routeKey } = makeCountingLazyEntry(40);
    const deps = {
      routesEntries: [entry],
      mergedRouteMap: {} as Record<string, string>,
      nextMountIndex: () => 100,
      getPrecomputedByPrefix: () => null, // no shortcut
    };

    // Match-time evaluation runs the handler once.
    evaluateLazyEntry(entry, deps);
    expect(runs()).toBe(1);

    // Render-time loadManifest runs the handler AGAIN on the same first request.
    // This `2` is the LP3 double-run sentinel. NOTE: this test DISABLES the
    // precomputed shortcut (getPrecomputedByPrefix: () => null) to exercise the
    // handler path directly. In real production, leaf includes ARE precomputed
    // (C8/LP2), so they run ONCE — see the WITH-shortcut test below. The residual
    // real double-run is a non-leaf include's direct routes (never precomputed).
    // That cost was MEASURED (~0.75us/route, ~50% of manifest-build but <0.5% of a
    // real RSC request, amortized to ~0 by the warm cache — lazy-include-cost.bench.ts)
    // and DEFERRED as not worth the LP4-coupled risk (see the LP3 it.todo below and
    // docs/internal/matching-and-lazy-discovery.md). This `2` is expected to STAY `2`.
    await runLoadManifest(entry, routeKey);
    expect(runs()).toBe(2);

    // A subsequent request (same routeKey/isSSR) hits the module cache: no run.
    await runLoadManifest(entry, routeKey);
    expect(runs()).toBe(2);
  });

  it("WITH the precomputed shortcut: skips the match-time run, render still runs once", async () => {
    const { entry, runs, routeKey } = makeCountingLazyEntry(41);
    const precomputed = new Map<string, Record<string, string>>([
      [entry.staticPrefix, { [routeKey]: "/sub/" }],
    ]);
    const deps = {
      routesEntries: [entry],
      mergedRouteMap: {} as Record<string, string>,
      nextMountIndex: () => 100,
      getPrecomputedByPrefix: () => precomputed, // shortcut available
    };

    // Match-time evaluation takes the precomputed shortcut: handler NOT run.
    evaluateLazyEntry(entry, deps);
    expect(runs()).toBe(0);

    // But render-time loadManifest must still run the handler once to build the
    // EntryData tree — the shortcut only saves the match-time run, not render.
    await runLoadManifest(entry, routeKey);
    expect(runs()).toBe(1);

    await runLoadManifest(entry, routeKey);
    expect(runs()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Part C — dev now precomputes leaf-include entries (C8) so dev/Cloudflare gets
// the same match-time shortcut as production (the double run collapses to one).
// ---------------------------------------------------------------------------

describe("dev trie rebuild precomputes leaf-include entries (C8)", () => {
  it("buildRouterTrieFromUrlpatterns sets per-router precomputed entries for leaf includes", async () => {
    const subPatterns = urls<any>(({ path }) => [
      path("/leaf", Page, { name: "leaf" }),
    ]);
    const top = urls<any>(({ path, include }) => [
      path("/", Page, { name: "home" }),
      include("/sub", subPatterns, { name: "sub" }),
    ]);

    await buildRouterTrieFromUrlpatterns({
      id: "lazy-perf-c8",
      urlpatterns: top,
      basename: undefined,
    });

    const precomputed = getRouterPrecomputedEntries("lazy-perf-c8");
    expect(precomputed).toBeDefined();
    // The leaf include "/sub" is precomputed, so evaluateLazyEntry takes the
    // shortcut at match time instead of re-running the include handler.
    const subEntry = precomputed!.find((e) => e.staticPrefix === "/sub");
    expect(subEntry).toBeDefined();
    expect(subEntry!.routes).toHaveProperty("sub.leaf");
  });
});

// ---------------------------------------------------------------------------
// Known future work (needs-design) — see docs/internal/matching-and-lazy-discovery.md
// "Lazy include() performance audit" (LP1, LP3, LP4). These are intentionally
// `todo`: the desired behavior is not yet implemented and the fixes are
// behavior-sensitive. The Part B sentinel will flip when LP3 lands.
// ---------------------------------------------------------------------------

describe("lazy-include redundancies still to remove (future work)", () => {
  // LP1: loadManifest() builds a manifest PRUNED to forRoute=routeKey
  // (path-helper.ts skips registering sibling routes), and the cache is keyed
  // by routeKey. So an include with M routes runs its handler M times across
  // the isolate's life — once per sibling route, each cached after its first
  // request. MEASURED (lazy-include-cost.bench.ts): for a 30-route include,
  // warming all 30 routes from cold is ~20x the cost of re-hitting them (cache
  // hits) — ~20-25us/route, paid once each, amortized to 0. Running it once per
  // include needs an UNPRUNED manifest cache with prune-on-read (NOT a
  // handler-identity cache key — that thrashes, because a sibling miss would
  // overwrite the pruned entry; verified regression). DEFERRED: risk >> reward.
  it.todo(
    "LP1: include with M routes runs handler once not M times (measured ~20us/route, deferred — see lazy-include-cost.bench.ts)",
  );

  // LP3: a non-leaf include (path() routes alongside a nested include(), so it is
  // never precomputed) runs its handler at match time (evaluateLazyEntry) AND
  // render time (loadManifest) on the first request — the match-time EntryData
  // build is discarded. MEASURED (lazy-include-cost.bench.ts): ~0.75us/route for
  // the redundant match run, ~50% of manifest-build but <0.5% of a real RSC
  // request, amortized to ~0 by the warm manifest cache. Removing it is
  // entangled with LP4: evaluateLazyEntry runs in a throwaway "lazy" namespace
  // WITHOUT isSSR (not even known at match time), while loadManifest builds under
  // the per-request ALS Store; reusing the match-time tree needs isSSR-dependent
  // state split out (the LP4 refactor, touching shortCodes + the semantic matrix).
  // DEFERRED: risk >> reward. Kept as a marker, not planned work. (Leaf includes
  // are already 1 run via C8 — see the WITH-shortcut test above.)
  it.todo(
    "LP3: non-leaf include handler runs match+render (measured ~0.75us/route, deferred — see lazy-include-cost.bench.ts)",
  );

  // LP4: a cold document request resolves twice — classify (isSSR=false) then
  // render (isSSR=true) — and both miss the isSSR-keyed manifest cache, so the
  // handler runs twice. MEASURED (lazy-include-cost.bench.ts): the double resolve
  // is ~1.9x a single — ~20-25us waste per cold document request, paid once per
  // route per isolate, amortized to 0.
  // Dropping isSSR is unsafe (the EntryData tree differs by isSSR via loading()
  // behavior); the fix must split the isSSR-dependent state out of the cached
  // tree (or warm the isSSR=true key during classification) — the same refactor
  // LP3 depends on, touching shortCodes + the semantic matrix. DEFERRED: risk >>
  // reward; LP4 is the gate for revisiting LP3.
  it.todo(
    "LP4: cold document request runs each handler once across isSSR false/true (measured ~20us, deferred — see lazy-include-cost.bench.ts)",
  );
});
