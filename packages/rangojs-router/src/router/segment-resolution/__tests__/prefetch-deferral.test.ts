import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntryData, LoaderEntry } from "../../../server/context";
import {
  chainUnitPossible,
  defersLoader,
  defersUnit,
  firstUnitCandidate,
  getPrefetchDeferral,
  isFillRequest,
  markUnitDeferred,
  planPrefetchDeferral,
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
    expect([...scope.units]).toEqual([[route, 1]]);
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
    expect([...scope.units]).toEqual([[section, 1]]);
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
    expect([...scope.units]).toEqual([[slot, 1]]);
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
    expect(defersUnit(ctxWith(plan), chain[0])).toBe(false);
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
  function plan(
    mode: PrefetchDeferral["mode"],
    build: () => { chain: EntryData[]; cacheBoundary?: string },
  ) {
    const { chain, cacheBoundary } = build();
    return planPrefetchDeferral(
      chain,
      mode,
      {},
      cacheBoundary
        ? ({ enabled: true, boundary: cacheBoundary } as any)
        : null,
    )!;
  }

  it("defer a loader only in a prefetch", () => {
    const reviews = loaderEntry("reviews", { prefetch: false });
    const price = loaderEntry("price");
    const build = () => ({
      chain: [entry("route", { loader: [price, reviews] })],
    });

    expect(defersLoader(ctxWith(plan("prefetch", build)), reviews)).toBe(true);
    expect(defersLoader(ctxWith(plan("prefetch", build)), price)).toBe(false);
    expect(defersLoader(ctxWith(plan("fill", build)), reviews)).toBe(false);
    expect(defersLoader(ctxWith(plan(undefined, build)), reviews)).toBe(false);
    expect(defersLoader(ctxWith(undefined), reviews)).toBe(false);
  });

  it("defer a unit only in a prefetch, above the stored part of the chain", () => {
    const section = entry("layout", flagged);
    const route = entry("route", flagged);
    const open = () => ({ chain: [section, route] });
    const cachedRoute = () => ({
      chain: [section, route],
      cacheBoundary: route.shortCode,
    });

    expect(defersUnit(ctxWith(plan("prefetch", open)), section)).toBe(true);
    expect(defersUnit(ctxWith(plan("prefetch", open)), route)).toBe(true);
    expect(defersUnit(ctxWith(plan("fill", open)), section)).toBe(false);
    expect(defersUnit(ctxWith(plan(undefined, open)), section)).toBe(false);
    // The route's handler output is stored: served as usual.
    expect(defersUnit(ctxWith(plan("prefetch", cachedRoute)), route)).toBe(
      false,
    );
    expect(defersUnit(ctxWith(plan("prefetch", cachedRoute)), section)).toBe(
      true,
    );
    expect(defersUnit(ctxWith(plan("prefetch", open)), entry("route"))).toBe(
      false,
    );
  });

  it("never defer a Static handler", () => {
    const layout = entry("layout", { ...flagged, isStaticPrerender: true });
    const build = () => ({ chain: [layout, entry("route")] });
    expect(defersUnit(ctxWith(plan("prefetch", build)), layout)).toBe(false);
  });

  it("report whether a prefetch can skip a chain entry above the cache boundary", () => {
    const section = entry("layout", flagged);
    const route = entry("route");
    const slot = entry("parallel", flagged);
    const slotOnly = entry("route", { parallel: { "@side": slot } });

    const above = plan("prefetch", () => ({
      chain: [section, route],
      cacheBoundary: route.shortCode,
    }));
    expect(chainUnitPossible(ctxWith(above))).toBe(true);
    // Not a prefetch: the record is read and written as usual.
    expect(
      chainUnitPossible(
        ctxWith(plan(undefined, () => ({ chain: [section, route] }))),
      ),
    ).toBe(false);
    // A slot unit skips nothing the record holds.
    expect(
      chainUnitPossible(
        ctxWith(plan("prefetch", () => ({ chain: [slotOnly] }))),
      ),
    ).toBe(false);
    expect(chainUnitPossible(ctxWith(undefined))).toBe(false);
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

  it("read the plan off a handler context, or nothing", () => {
    const route = entry("route", flagged);
    const fill = plan("fill", () => ({ chain: [route] }));
    expect(getPrefetchDeferral(ctxWith(fill))).toBe(fill);
    expect(getPrefetchDeferral(undefined)).toBeUndefined();
    expect(isFillRequest(ctxWith(fill))).toBe(true);
    expect(isFillRequest(ctxWith(undefined))).toBe(false);
  });
});
