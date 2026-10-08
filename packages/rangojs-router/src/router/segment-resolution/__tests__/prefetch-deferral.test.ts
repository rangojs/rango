import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntryData, LoaderEntry } from "../../../server/context";
import {
  belowDeferredUnit,
  defersAboveRecord,
  defersLoader,
  defersUnit,
  firstUnitCandidate,
  getPrefetchDeferral,
  isFillRequest,
  markUnitDeferred,
  partialDeferralMode,
  planPrefetchDeferral,
  requestKind,
  resolveDeferralScope,
  type PrefetchDeferral,
} from "../prefetch-deferral";

// `prefetch: false`: which work a prefetch defers (the static scope of a
// matched chain) and the per-match plan the decision sites read
// (docs/design/prefetch-false.md, "Which loaders are deferrable" and "The
// plan").

let nextId = 0;

function loaderEntry(
  id: string,
  options: { prefetch?: false; bake?: true } = {},
): LoaderEntry {
  return { loader: { $$id: id }, ...options } as unknown as LoaderEntry;
}

function entry(
  type: "layout" | "route" | "parallel" | "cache",
  overrides: Record<string, unknown> = {},
): EntryData {
  const n = nextId++;
  return {
    type,
    id: `${type}-${n}`,
    shortCode: `${type[0].toUpperCase()}${n}`,
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    ...overrides,
  } as unknown as EntryData;
}

const flagged = { loading: "fallback", loadingPrefetch: false as const };

const ids = (scope: { loaderIds: ReadonlySet<string> }) =>
  [...scope.loaderIds].sort();

function ctxWith(plan: PrefetchDeferral | undefined) {
  return { _prefetchDeferral: plan } as any;
}

afterEach(() => vi.restoreAllMocks());

describe("resolveDeferralScope", () => {
  it("is empty for a tree with no flag, and for no entries", () => {
    const route = entry("route", { loader: [loaderEntry("a")] });
    const scope = resolveDeferralScope([entry("layout"), route]);
    expect(scope.loaders.size + scope.units.size).toBe(0);
    expect(resolveDeferralScope([]).loaders.size).toBe(0);
  });

  it("holds a flagged loader and not its unflagged sibling", () => {
    const price = loaderEntry("price");
    const reviews = loaderEntry("reviews", { prefetch: false });
    const route = entry("route", { loader: [price, reviews] });
    const scope = resolveDeferralScope([entry("layout"), route]);

    expect(scope.loaders.has(reviews)).toBe(true);
    expect(scope.loaders.has(price)).toBe(false);
    expect(ids(scope)).toEqual(["reviews"]);
    expect(scope.units.size).toBe(0);
  });

  it("puts everything a flagged route's fallback covers behind it", () => {
    const slot = entry("parallel", { loader: [loaderEntry("slot")] });
    const nested = entry("layout", { loader: [loaderEntry("nested")] });
    const orphan = entry("layout", {
      loader: [loaderEntry("orphan")],
      layout: [nested],
    });
    const route = entry("route", {
      ...flagged,
      loader: [loaderEntry("own")],
      parallel: { "@side": slot },
      layout: [orphan],
    });
    const outer = entry("layout", { loader: [loaderEntry("outer")] });
    const scope = resolveDeferralScope([outer, route]);

    expect(ids(scope)).toEqual(["nested", "orphan", "own", "slot"]);
    // The route is the unit, at its chain index. Nothing above it is covered.
    expect([...scope.units]).toEqual([
      [route, { index: 1, ids: [route.shortCode] }],
    ]);
  });

  it("a flagged layout covers every deeper entry of the chain", () => {
    const outer = entry("layout", { loader: [loaderEntry("outer")] });
    const section = entry("layout", {
      ...flagged,
      loader: [loaderEntry("section")],
    });
    const route = entry("route", { loader: [loaderEntry("page")] });
    const scope = resolveDeferralScope([outer, section, route]);

    expect(ids(scope)).toEqual(["page", "section"]);
    expect([...scope.units]).toEqual([
      [section, { index: 1, ids: [section.shortCode] }],
    ]);
  });

  it("describes a unit by its chain index and its segment ids, nothing else", () => {
    const section = entry("layout", flagged);
    const route = entry("route", { transition: {} });
    expect(
      resolveDeferralScope([entry("layout"), section, route]).units.get(
        section,
      ),
    ).toEqual({ index: 1, ids: [section.shortCode] });
  });

  it("a flagged route does not cover anything after it", () => {
    // A cache() entry between two routes cannot exist; a route is the leaf.
    const route = entry("route", flagged);
    const scope = resolveDeferralScope([entry("layout"), route]);
    expect([...scope.units.keys()]).toEqual([route]);
  });

  it("a slot with its own flagged loading() is its own unit, at its parent's index", () => {
    const slot = entry("parallel", {
      ...flagged,
      loader: [loaderEntry("slot")],
    });
    const route = entry("route", {
      loader: [loaderEntry("page")],
      parallel: { "@side": slot },
    });
    const scope = resolveDeferralScope([entry("layout"), route]);

    expect(ids(scope)).toEqual(["slot"]);
    // Its segment is the slot's: `<parent>.<slot>`.
    expect([...scope.units]).toEqual([
      [slot, { index: 1, ids: [`${route.shortCode}.@side`] }],
    ]);
  });

  it("an orphan layout's flagged loading() defers its loaders, not its handler", () => {
    const orphan = entry("layout", {
      ...flagged,
      loader: [loaderEntry("orphan")],
    });
    const route = entry("route", { layout: [orphan] });
    const scope = resolveDeferralScope([entry("layout"), route]);

    expect(ids(scope)).toEqual(["orphan"]);
    expect(scope.units.size).toBe(0);
  });

  it("does not walk a chain layout twice through its parent's layout list", () => {
    const child = entry("layout", { loader: [loaderEntry("child")] });
    const parent = entry("layout", { layout: [child] });
    const route = entry("route", {
      loader: [loaderEntry("page", { prefetch: false })],
    });
    const scope = resolveDeferralScope([parent, child, route]);
    expect(ids(scope)).toEqual(["page"]);
  });

  it("ignores a flag without a fallback to show", () => {
    // dsl-helpers.ts records loadingPrefetch only for a renderable fallback.
    const route = entry("route", {
      loading: false,
      loader: [loaderEntry("page")],
    });
    expect(resolveDeferralScope([route]).units.size).toBe(0);
  });

  it("is inert on a clientUrls() route", () => {
    const route = entry("route", {
      ...flagged,
      clientGroup: "group",
      loader: [loaderEntry("page", { prefetch: false })],
    });
    const scope = resolveDeferralScope([entry("layout", flagged), route]);
    expect(scope.loaders.size + scope.units.size).toBe(0);
  });

  it("never defers a bake-lane loader on a ppr route, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bake = loaderEntry("bake", { prefetch: false, bake: true });
    const behind = loaderEntry("behind", { bake: true });
    const live = loaderEntry("live", { prefetch: false });
    const route = entry("route", {
      ppr: true,
      ...flagged,
      loader: [bake, behind, live],
    });
    const scope = resolveDeferralScope([route]);

    expect(ids(scope)).toEqual(["live"]);
    // Only the explicit combination is the author's mistake.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"bake"');
    expect(warn.mock.calls[0][0]).toContain("prefetch: false is ignored");

    resolveDeferralScope([entry("route", { ppr: true, loader: [bake] })]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("defers an ssr: false loader outside ppr", () => {
    const loader = loaderEntry("doc", { prefetch: false, bake: true });
    const scope = resolveDeferralScope([entry("route", { loader: [loader] })]);
    expect(scope.loaders.has(loader)).toBe(true);
  });

  it("is computed once per leaf entry", () => {
    const route = entry("route", {
      loader: [loaderEntry("page", { prefetch: false })],
    });
    const chain = [entry("layout"), route];
    expect(resolveDeferralScope(chain)).toBe(resolveDeferralScope(chain));
  });
});

// Read once, when the request context is created: what the request says it
// is. Whether a prefetch defers is partialDeferralMode's decision, below.
describe("requestKind", () => {
  const kindOf = (url: string, headers?: Record<string, string>) =>
    requestKind(new Request(url, { headers }), new URL(url));
  const PARTIAL = "http://localhost/p?_rsc_partial=true&_rsc_segments=L0";

  it("is a prefetch by the header and a fill by the param", () => {
    expect(kindOf(PARTIAL, { "X-Rango-Prefetch": "1" })).toBe("prefetch");
    expect(kindOf(`${PARTIAL}&_rsc_fill=1`)).toBe("fill");
    expect(kindOf(PARTIAL)).toBe(undefined);
  });

  it("is a fill when a request carries both", () => {
    expect(kindOf(`${PARTIAL}&_rsc_fill=1`, { "X-Rango-Prefetch": "1" })).toBe(
      "fill",
    );
  });

  // The match passes the request context's URL: the request's own may have
  // lost its internal params.
  it("reads the param from the raw URL it is given", () => {
    expect(
      requestKind(
        new Request("http://localhost/p"),
        new URL(`${PARTIAL}&_rsc_fill=1`),
      ),
    ).toBe("fill");
  });
});

describe("partialDeferralMode", () => {
  // A plain GET navigation that carries the prefetch header.
  const PREFETCH = {
    fill: false,
    prefetch: true,
    method: "GET",
    isAction: false,
    isIntercept: false,
    isShellCapture: false,
  };

  it("is a prefetch for a plain GET navigation with the prefetch header", () => {
    expect(partialDeferralMode(PREFETCH)).toBe("prefetch");
    expect(partialDeferralMode({ ...PREFETCH, prefetch: false })).toBe(
      undefined,
    );
  });

  // Each condition on its own: today an action is also a POST and a capture
  // runs the full match, so no request shows them apart.
  it.each([
    ["an action revalidation", { isAction: true }],
    ["a request that resolves an intercept", { isIntercept: true }],
    ["a shell capture", { isShellCapture: true }],
    ["a POST", { method: "POST" }],
    ["a HEAD", { method: "HEAD" }],
  ])("is never a prefetch for %s", (_label, override) => {
    expect(partialDeferralMode({ ...PREFETCH, ...override })).toBe(undefined);
  });

  it("is a fill whenever the URL carries the marker, whatever else it says", () => {
    expect(partialDeferralMode({ ...PREFETCH, fill: true })).toBe("fill");
    expect(
      partialDeferralMode({
        fill: true,
        prefetch: false,
        method: "POST",
        isAction: true,
        isIntercept: true,
        isShellCapture: true,
      }),
    ).toBe("fill");
  });
});

describe("planPrefetchDeferral", () => {
  const flaggedChain = () => {
    const outer = entry("layout");
    const section = entry("layout", flagged);
    const route = entry("route", { loader: [loaderEntry("page")] });
    return { outer, section, route, chain: [outer, section, route] };
  };

  it("is undefined for an unflagged tree, unless the request is a fill", () => {
    const chain = [entry("layout"), entry("route")];
    expect(planPrefetchDeferral(chain, "prefetch", {}, null)).toBeUndefined();
    expect(planPrefetchDeferral(chain, undefined, {}, null)).toBeUndefined();
    expect(planPrefetchDeferral(chain, "fill", {}, null)).toMatchObject({
      mode: "fill",
    });
  });

  it("carries the scope on every request of a flagged tree", () => {
    const { chain } = flaggedChain();
    const plan = planPrefetchDeferral(chain, undefined, {}, null)!;
    expect(plan.mode).toBeUndefined();
    expect(plan.scope.loaderIds.has("page")).toBe(true);
    expect(plan.storedFrom).toBe(Infinity);
  });

  it.each([
    ["a prerendered match", { pr: true }, {}],
    ["an on-demand match", { od: true }, {}],
    ["a ppr route", {}, { ppr: true }],
    // Dev renders a Prerender route live: the rule is the declaration's.
    ["a Prerender route with no artifact", {}, { isPrerender: true }],
  ])("stores the whole chain for %s", (_label, matched, leaf) => {
    const chain = [
      entry("layout", flagged),
      entry("route", { ...leaf, loader: [loaderEntry("page")] }),
    ];
    const plan = planPrefetchDeferral(chain, "prefetch", matched, null)!;
    expect(plan.storedFrom).toBe(0);
    expect(defersUnit(ctxWith(plan), chain[0].shortCode)).toBe(false);
  });

  it("stores from the cache() boundary down", () => {
    const { outer, section, route, chain } = flaggedChain();
    const at = (boundary: string | undefined, enabled = true) =>
      planPrefetchDeferral(chain, "prefetch", {}, {
        enabled,
        boundary,
      } as any)!.storedFrom;

    expect(at(route.shortCode)).toBe(2);
    expect(at(section.shortCode)).toBe(1);
    expect(at(outer.shortCode)).toBe(0);
    // A scope with no boundary, or one outside the chain, covers all of it.
    expect(at(undefined)).toBe(0);
    expect(at("not-in-chain")).toBe(0);
    expect(at(route.shortCode, false)).toBe(Infinity);
  });
});

describe("the decisions", () => {
  const NONE: ReadonlySet<string> = new Set();
  const holding = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  /** The plan of one request: what it listed as held is part of it. */
  function plan(
    mode: PrefetchDeferral["mode"],
    build: () => { chain: EntryData[]; cacheBoundary?: string },
    held: ReadonlySet<string> = NONE,
  ) {
    const { chain, cacheBoundary } = build();
    return planPrefetchDeferral(
      chain,
      mode,
      {},
      cacheBoundary
        ? ({ enabled: true, boundary: cacheBoundary } as any)
        : null,
      held,
    )!;
  }

  it("defer a loader only in a prefetch", () => {
    const reviews = loaderEntry("reviews", { prefetch: false });
    const price = loaderEntry("price");
    const build = () => ({
      chain: [entry("route", { loader: [price, reviews] })],
    });
    const defers = (
      mode: PrefetchDeferral["mode"] | "no plan",
      loader: LoaderEntry,
    ) =>
      defersLoader(
        ctxWith(mode === "no plan" ? undefined : plan(mode, build)),
        loader,
        "R0D0.x",
      );

    expect(defers("prefetch", reviews)).toBe(true);
    expect(defers("prefetch", price)).toBe(false);
    expect(defers("fill", reviews)).toBe(false);
    expect(defers(undefined, reviews)).toBe(false);
    expect(defers("no plan", reviews)).toBe(false);
  });

  // The flag applies only to a segment the client does not have yet.
  it("never defer a loader whose segment the client holds", () => {
    const reviews = loaderEntry("reviews", { prefetch: false });
    const build = () => ({ chain: [entry("route", { loader: [reviews] })] });
    const defers = (held: ReadonlySet<string>) =>
      defersLoader(
        ctxWith(plan("prefetch", build, held)),
        reviews,
        "R0D0.reviews",
      );
    expect(defers(NONE)).toBe(true);
    expect(defers(holding("R0D0.reviews"))).toBe(false);
    // Holding the route, not the loader's segment: still new, still deferred.
    expect(defers(holding("R0"))).toBe(true);
  });

  it("defer a loader behind a flagged entry only while the client does not hold that entry", () => {
    const sectionLoader = loaderEntry("section");
    const pageLoader = loaderEntry("page");
    const flaggedPageLoader = loaderEntry("flagged", { prefetch: false });
    const section = entry("layout", { ...flagged, loader: [sectionLoader] });
    const route = entry("route", { loader: [pageLoader, flaggedPageLoader] });
    const build = () => ({ chain: [section, route] });
    const pageId = `${route.shortCode}D0.page`;

    // The section is new: everything its fallback covers is deferred.
    const fresh = ctxWith(plan("prefetch", build));
    expect(defersLoader(fresh, pageLoader, pageId)).toBe(true);
    expect(defersLoader(fresh, sectionLoader, "S.D0")).toBe(true);
    // The client holds the section: a new route's loaders run.
    const inside = ctxWith(plan("prefetch", build, holding(section.shortCode)));
    expect(defersLoader(inside, pageLoader, pageId)).toBe(false);
    // A loader with its own flag does not need the section.
    expect(defersLoader(inside, flaggedPageLoader, "R.D1")).toBe(true);
  });

  it("defer a loader behind a flagged slot while one of its slots is new", () => {
    const slotLoader = loaderEntry("slot");
    const slot = entry("parallel", { ...flagged, loader: [slotLoader] });
    const route = entry("route", { parallel: { "@side": slot } });
    const slotId = `${route.shortCode}.@side`;
    const defers = (held: ReadonlySet<string>) =>
      defersLoader(
        ctxWith(plan("prefetch", () => ({ chain: [route] }), held)),
        slotLoader,
        "R.D0",
      );

    expect(defers(NONE)).toBe(true);
    expect(defers(holding(slotId))).toBe(false);
    expect(defers(holding(route.shortCode))).toBe(true);
  });

  it("defer a loader behind a flagged orphan layout while the client does not hold it", () => {
    const orphanLoader = loaderEntry("orphan");
    const orphan = entry("layout", { ...flagged, loader: [orphanLoader] });
    const route = entry("route", { layout: [orphan] });
    const defers = (held: ReadonlySet<string>) =>
      defersLoader(
        ctxWith(plan("prefetch", () => ({ chain: [route] }), held)),
        orphanLoader,
        "O.D0",
      );

    expect(defers(NONE)).toBe(true);
    expect(defers(holding(orphan.shortCode))).toBe(false);
  });

  it("defer a unit only in a prefetch, above the stored part of the chain", () => {
    const section = entry("layout", flagged);
    const route = entry("route", flagged);
    const open = () => ({ chain: [section, route] });
    const cachedRoute = () => ({
      chain: [section, route],
      cacheBoundary: route.shortCode,
    });
    const defers = (
      mode: PrefetchDeferral["mode"],
      build: () => { chain: EntryData[]; cacheBoundary?: string },
      unit: EntryData,
    ) => defersUnit(ctxWith(plan(mode, build)), unit.shortCode);

    expect(defers("prefetch", open, section)).toBe(true);
    expect(defers("prefetch", open, route)).toBe(true);
    expect(defers("fill", open, section)).toBe(false);
    expect(defers(undefined, open, section)).toBe(false);
    // The route's handler output is stored: served as usual.
    expect(defers("prefetch", cachedRoute, route)).toBe(false);
    expect(defers("prefetch", cachedRoute, section)).toBe(true);
    expect(defers("prefetch", open, entry("route"))).toBe(false);
    expect(defersUnit(ctxWith(undefined), section.shortCode)).toBe(false);
  });

  it("never defer a unit whose segment the client holds, whether or not it re-renders", () => {
    const section = entry("layout", flagged);
    const route = entry("route", flagged);
    const build = () => ({ chain: [section, route] });
    const inSection = ctxWith(
      plan("prefetch", build, holding(section.shortCode)),
    );

    expect(defersUnit(inSection, section.shortCode)).toBe(false);
    // A new route under the held section is still its own unit.
    expect(defersUnit(inSection, route.shortCode)).toBe(true);
    expect(
      defersUnit(
        ctxWith(plan("prefetch", build, holding(route.shortCode))),
        route.shortCode,
      ),
    ).toBe(false);
  });

  it("defer each slot of a flagged parallel entry by its own segment", () => {
    const slots = entry("parallel", flagged);
    const route = entry("route", { parallel: { "@a": slots, "@b": slots } });
    const a = `${route.shortCode}.@a`;
    const b = `${route.shortCode}.@b`;
    const active = plan("prefetch", () => ({ chain: [route] }), holding(a));

    expect([...active.skipped]).toEqual([b]);
    expect(defersUnit(ctxWith(active), a)).toBe(false);
    expect(defersUnit(ctxWith(active), b)).toBe(true);
  });

  it("never defer a Static handler", () => {
    const layout = entry("layout", { ...flagged, isStaticPrerender: true });
    const build = () => ({ chain: [layout, entry("route")] });
    expect(defersUnit(ctxWith(plan("prefetch", build)), layout.shortCode)).toBe(
      false,
    );
  });

  it("report whether this prefetch skips a layout above the cache boundary", () => {
    const section = entry("layout", flagged);
    const route = entry("route");
    const slot = entry("parallel", flagged);
    const slotOnly = entry("route", { parallel: { "@side": slot } });
    const aboveRecord = () => ({
      chain: [section, route],
      cacheBoundary: route.shortCode,
    });

    expect(defersAboveRecord(ctxWith(plan("prefetch", aboveRecord)))).toBe(
      true,
    );
    // The client holds the layout: nothing above the record is skipped, so
    // the record is read and written.
    expect(
      defersAboveRecord(
        ctxWith(plan("prefetch", aboveRecord, holding(section.shortCode))),
      ),
    ).toBe(false);
    // Not a prefetch: the record is read and written as usual.
    expect(
      defersAboveRecord(
        ctxWith(plan(undefined, () => ({ chain: [section, route] }))),
      ),
    ).toBe(false);
    // A slot unit skips nothing the record holds.
    expect(
      defersAboveRecord(
        ctxWith(plan("prefetch", () => ({ chain: [slotOnly] }))),
      ),
    ).toBe(false);
    // A flagged layout the record itself stores is not a unit.
    expect(
      defersAboveRecord(
        ctxWith(
          plan("prefetch", () => ({
            chain: [section, route],
            cacheBoundary: section.shortCode,
          })),
        ),
      ),
    ).toBe(false);
    expect(defersAboveRecord(ctxWith(undefined))).toBe(false);
  });

  it("name the first unit a prefetch of the tree can skip", () => {
    const section = entry("layout", flagged);
    const route = entry("route", flagged);
    const open = plan(undefined, () => ({ chain: [section, route] }));
    expect(firstUnitCandidate(open)).toBe(section);

    const stored = planPrefetchDeferral(
      [section, route],
      undefined,
      { pr: true },
      null,
    )!;
    expect(firstUnitCandidate(stored)).toBeUndefined();
  });

  it("record the first unit a prefetch skipped", () => {
    const route = entry("route", flagged);
    const active = plan("prefetch", () => ({ chain: [route] }));
    const ctx = ctxWith(active);
    markUnitDeferred(ctx, "L0R1");
    markUnitDeferred(ctx, "L0R1.@side");
    expect(active.deferredUnit).toBe("L0R1");
    expect(() => markUnitDeferred(ctxWith(undefined), "x")).not.toThrow();
  });

  // The walk is in chain order: what it reaches after a chain unit it
  // skipped is below that unit.
  it("below a chain unit a prefetch skipped, defer everything the client does not hold", () => {
    const section = entry("layout", flagged);
    const route = entry("route");
    const slot = `${route.shortCode}.@side`;
    const active = plan(
      "prefetch",
      () => ({ chain: [section, route] }),
      holding("held"),
    );
    const ctx = ctxWith(active);

    expect(defersUnit(ctx, route.shortCode)).toBe(false);
    expect(belowDeferredUnit(ctx, route.shortCode)).toBe(false);

    markUnitDeferred(ctx, section.shortCode, true);
    expect(defersUnit(ctx, route.shortCode)).toBe(true);
    expect(defersUnit(ctx, slot)).toBe(true);
    expect(belowDeferredUnit(ctx, slot)).toBe(true);
    expect(defersUnit(ctx, "held")).toBe(false);
    expect(belowDeferredUnit(ctx, "held")).toBe(false);
    expect(belowDeferredUnit(ctxWith(undefined), slot)).toBe(false);
  });

  it("a slot that is its own unit takes nothing with it", () => {
    const slots = entry("parallel", flagged);
    const layout = entry("layout", { parallel: { "@side": slots } });
    const route = entry("route");
    const active = plan("prefetch", () => ({ chain: [layout, route] }));
    const ctx = ctxWith(active);

    markUnitDeferred(ctx, `${layout.shortCode}.@side`);
    expect(defersUnit(ctx, `${layout.shortCode}.@side`)).toBe(true);
    expect(defersUnit(ctx, route.shortCode)).toBe(false);
  });

  it("read the plan off a handler context, or nothing", () => {
    const route = entry("route", flagged);
    const fill = plan("fill", () => ({ chain: [route] }));
    expect(getPrefetchDeferral(ctxWith(fill))).toBe(fill);
    expect(getPrefetchDeferral(undefined)).toBeUndefined();
    expect(isFillRequest(ctxWith(fill))).toBe(true);
    expect(isFillRequest(ctxWith(undefined))).toBe(false);
  });
});
