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

    // Render-time loadManifest runs it AGAIN (a separate handler execution on
    // the same first request). This `2` is the SENTINEL for LP3 (the known
    // match+render double run — see docs/internal/matching-stability-review.md
    // and the `it.todo` below): when LP3 is fixed so the handler runs once, this
    // assertion will flip to `1` — update it here and drop the LP3 todo.
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
// Known future work (needs-design) — see docs/internal/matching-stability-review.md
// "Lazy include() performance audit" (LP1, LP3, LP4). These are intentionally
// `todo`: the desired behavior is not yet implemented and the fixes are
// behavior-sensitive. The Part B sentinel will flip when LP3 lands.
// ---------------------------------------------------------------------------

describe("lazy-include redundancies still to remove (future work)", () => {
  // LP1: loadManifest() builds a manifest PRUNED to forRoute=routeKey
  // (path-helper.ts skips registering sibling routes), and the cache is keyed
  // by routeKey. So an include with M routes runs its handler M times across
  // the isolate's life — once per sibling route, each cached after its first
  // request. Running it once per include needs an UNPRUNED manifest cache with
  // prune-on-read (NOT a handler-identity cache key — that thrashes, because a
  // sibling miss would overwrite the pruned entry; verified regression).
  it.todo(
    "LP1: an include with M routes runs its handler once, not once per route (unpruned cache + prune-on-read)",
  );

  // LP3: on the first matching request, a non-leaf / precomputed-miss include
  // runs its handler at match time (evaluateLazyEntry) AND render time
  // (loadManifest) — the match-time EntryData build is discarded. Unifying them
  // so the handler runs once is behavior-sensitive: evaluateLazyEntry runs in a
  // throwaway "lazy" namespace without isSSR/mountIndex, while loadManifest
  // builds under the per-request ALS Store. The Part B "WITHOUT the precomputed
  // shortcut" test pins the current run count (2); it flips to 1 when this lands.
  it.todo(
    "LP3: a precomputed-miss include runs its handler once on the first request (match+render unified)",
  );

  // LP4: a cold document request resolves twice — classify (isSSR=false) then
  // render (isSSR=true) — and both miss the isSSR-keyed manifest cache, so the
  // handler runs twice. Dropping isSSR is unsafe (the EntryData tree differs by
  // isSSR via loading() behavior); the fix must split the isSSR-dependent state
  // out of the cached tree, or warm the isSSR=true key during classification.
  it.todo(
    "LP4: a cold document request runs each handler once across the isSSR=false/true resolves",
  );
});
