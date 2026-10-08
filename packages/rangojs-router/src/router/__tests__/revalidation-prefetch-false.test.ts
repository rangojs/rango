/**
 * `prefetch: false` at the decision sites of the partial resolution funnel
 * (segment-resolution/revalidation.ts): "deferral replaces execution" in a
 * prefetch, and "held is skipped outright" in a fill
 * (docs/design/prefetch-false.md, "Where the decisions are made").
 *
 * The funnel is driven directly with a plan on the handler context, the way
 * match-api.ts leaves it. The end-to-end version, through a real request, is
 * src/testing/__tests__/prefetch-false.rsc-test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: false,
}));

const { resolveLoaderDataMock } = vi.hoisted(() => ({
  resolveLoaderDataMock: vi.fn((loaderEntry: any) =>
    Promise.resolve({ from: loaderEntry.loader.$$id }),
  ),
}));
vi.mock("../segment-resolution/loader-cache.js", () => ({
  resolveLoaderData: resolveLoaderDataMock,
}));

vi.mock("../segment-resolution/helpers.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  tryStaticHandler: vi.fn(),
  tryStaticSlot: vi.fn(),
  resolveLayoutComponent: vi.fn(async (entry: any, ctx: any) =>
    entry.handler(ctx),
  ),
  resolveWithErrorBoundary: vi.fn(
    async (_entry: any, _params: any, resolver: () => any) => resolver(),
  ),
  buildLoaderErrorContext: vi.fn(() => ({})),
}));

vi.mock("../router-context.js", () => ({
  getRouterContext: vi.fn(() => null),
}));

vi.mock("../telemetry.js", () => ({
  resolveSink: vi.fn(() => null),
  safeEmit: vi.fn(),
}));

vi.mock("../../server/context.js", async () => {
  const actual = await vi.importActual("../../server/context.js");
  return {
    ...(actual as object),
    track: vi.fn(() => vi.fn()),
    runInsideLoaderScope: <T>(fn: () => T): T => fn(),
  };
});

import { resolveAllSegmentsWithRevalidation } from "../segment-resolution/revalidation.js";
import {
  planPrefetchDeferral,
  type PrefetchDeferral,
} from "../segment-resolution/prefetch-deferral.js";
import type { EntryData } from "../../server/context.js";
import type { SegmentResolutionDeps } from "../types.js";
import type { ResolvedSegment } from "../../types.js";

const URL_PAGE = "http://localhost/product/1";

function makeDeps(): SegmentResolutionDeps<any> {
  return {
    wrapLoaderPromise: vi.fn((promise: any) => promise) as any,
    trackHandler: vi.fn((p) => p),
    findNearestErrorBoundary: vi.fn(() => null),
    findNearestNotFoundBoundary: vi.fn(() => null),
    callOnError: vi.fn(),
  };
}

function loaderEntry(id: string, options: { prefetch?: false } = {}): any {
  return { loader: { $$id: id }, revalidate: [], ...options };
}

function entry(
  type: "layout" | "route" | "parallel",
  shortCode: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: `entry.${shortCode}`,
    type,
    shortCode,
    handler: vi.fn(() => `content-${shortCode}`),
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
    ...overrides,
  };
}

const flagged = { loading: "fallback", loadingPrefetch: false };

async function resolve(
  chain: EntryData[],
  mode: PrefetchDeferral["mode"],
  clientIds: string[],
  options: { started?: string[] } = {},
) {
  // The plan holds what the request listed as held, as match-api builds it.
  const plan = planPrefetchDeferral(chain, mode, {}, null, new Set(clientIds));
  const context: any = {
    request: new Request(URL_PAGE),
    env: {},
    params: { id: "1" },
    pathname: "/product/1",
    url: new URL(URL_PAGE),
    var: {},
    use: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    _prefetchDeferral: plan,
    _loaderStarted: (id: string) => options.started?.includes(id) ?? false,
  };
  const result = await resolveAllSegmentsWithRevalidation(
    chain,
    "product",
    { id: "1" },
    context,
    new Set(clientIds),
    { id: "1" },
    new Request(URL_PAGE),
    new URL(URL_PAGE),
    new URL(URL_PAGE),
    undefined,
    null,
    "product",
    "/product/1",
    makeDeps(),
  );
  const byId = new Map<string, ResolvedSegment>(
    result.segments.map((s) => [s.id, s]),
  );
  return { ...result, byId, plan };
}

const ran = () =>
  resolveLoaderDataMock.mock.calls.map((call) => call[0].loader.$$id);

beforeEach(() => {
  resolveLoaderDataMock.mockClear();
});

describe("a prefetch: deferral replaces execution", () => {
  it("emits a flagged loader as a deferred segment and does not run it", async () => {
    const route = entry("route", "R1", {
      loading: "fallback",
      loader: [
        loaderEntry("price"),
        loaderEntry("reviews", { prefetch: false }),
      ],
    });
    const { byId, matchedIds } = await resolve(
      [entry("layout", "L0"), route],
      "prefetch",
      [],
    );

    expect(ran()).toEqual(["price"]);
    expect(byId.get("R1D0.price")).toMatchObject({ loaderId: "price" });
    expect(byId.get("R1D0.price")!.deferred).toBeUndefined();
    const reviews = byId.get("R1D1.reviews")!;
    expect(reviews).toMatchObject({ type: "loader", deferred: true });
    expect("loaderData" in reviews).toBe(false);
    expect(matchedIds).toContain("R1D1.reviews");
    // The handler is not deferred: it ran.
    expect(route.handler).toHaveBeenCalledTimes(1);
  });

  it("does not defer a flagged loader that would not have run", async () => {
    const route = entry("route", "R1", {
      loader: [loaderEntry("reviews", { prefetch: false })],
    });
    // Held, same URL and params: the default decision keeps it.
    const { segments } = await resolve([route], "prefetch", [
      "R1",
      "R1D0.reviews",
    ]);

    expect(ran()).toEqual([]);
    expect(segments.some((s) => s.deferred)).toBe(false);
    expect(segments.some((s) => s.type === "loader")).toBe(false);
  });

  it("delivers a flagged loader something already started in the request", async () => {
    const route = entry("route", "R1", {
      loader: [loaderEntry("awaited", { prefetch: false })],
    });
    const { byId } = await resolve([route], "prefetch", [], {
      started: ["awaited"],
    });

    const loader = byId.get("R1D0.awaited")!;
    expect(loader.deferred).toBeUndefined();
    await expect(loader.loaderData).resolves.toEqual({ from: "awaited" });
  });

  it("skips a flagged route with everything its fallback covers", async () => {
    const slot = entry("parallel", "P0", {
      handler: { "@side": vi.fn(() => "slot") },
      loader: [loaderEntry("slot")],
    });
    const orphan = entry("layout", "R1L0", { loader: [loaderEntry("orphan")] });
    const route = entry("route", "R1", {
      ...flagged,
      loader: [loaderEntry("own")],
      parallel: { "@side": slot },
      layout: [orphan],
    });
    const outer = entry("layout", "L0", { loader: [loaderEntry("outer")] });
    const { byId, segments, plan } = await resolve(
      [outer, route],
      "prefetch",
      [],
    );

    expect(route.handler).not.toHaveBeenCalled();
    expect(orphan.handler).not.toHaveBeenCalled();
    expect(slot.handler["@side"]).not.toHaveBeenCalled();
    // Only the loader outside the unit ran.
    expect(ran()).toEqual(["outer"]);
    expect(outer.handler).toHaveBeenCalledTimes(1);

    expect(byId.get("R1")).toMatchObject({
      type: "route",
      component: null,
      loading: "fallback",
      deferred: true,
      _handlerRan: false,
    });
    // The unit's own loaders and its slots' loaders ride as deferred loader
    // segments under the unit's id; the slot and the orphan do not.
    expect(
      segments
        .filter((s) => s.deferred && s.type === "loader")
        .map((s) => s.id),
    ).toEqual(["R1D0.own", "R1D0.slot"]);
    expect(byId.has("R1.@side")).toBe(false);
    expect(byId.has("R1L0")).toBe(false);
    expect(plan!.deferredUnit).toBe("R1");
  });

  it("stops the chain at a flagged layout", async () => {
    const outer = entry("layout", "L0");
    const section = entry("layout", "L0L1", {
      ...flagged,
      loader: [loaderEntry("section")],
    });
    const route = entry("route", "R2", { loader: [loaderEntry("page")] });
    const { byId, matchedIds, plan } = await resolve(
      [outer, section, route],
      "prefetch",
      [],
    );

    expect(section.handler).not.toHaveBeenCalled();
    expect(route.handler).not.toHaveBeenCalled();
    expect(ran()).toEqual([]);
    expect(byId.get("L0L1")).toMatchObject({
      type: "layout",
      component: null,
      deferred: true,
    });
    // Nothing below the unit is matched: the fill renders it.
    expect(matchedIds).toEqual(["L0", "L0L1D0.section", "L0L1"]);
    expect(plan!.deferredUnit).toBe("L0L1");
  });

  // The flag applies only to a segment the client does not have yet.
  it("under a held flagged layout a new route's handler and loaders run", async () => {
    const section = entry("layout", "L0L1", flagged);
    const route = entry("route", "R2", { loader: [loaderEntry("page")] });
    const { segments, byId, plan } = await resolve(
      [section, route],
      "prefetch",
      ["L0L1"],
    );

    expect(section.handler).not.toHaveBeenCalled();
    expect(route.handler).toHaveBeenCalledTimes(1);
    // Behind the section's fallback, which this navigation does not show.
    expect(ran()).toEqual(["page"]);
    expect("loaderData" in byId.get("R2D0.page")!).toBe(true);
    expect(segments.some((s) => s.deferred)).toBe(false);
    expect(plan!.deferredUnit).toBeUndefined();
  });

  it("renders a held flagged layout whose revalidate() returns true, and everything below it", async () => {
    const predicate = vi.fn(() => true);
    const section = entry("layout", "L0L1", {
      ...flagged,
      revalidate: [predicate],
      loader: [loaderEntry("section")],
    });
    const route = entry("route", "R2", { loader: [loaderEntry("page")] });
    const { segments, byId, plan } = await resolve(
      [section, route],
      "prefetch",
      ["L0L1"],
    );

    expect(predicate).toHaveBeenCalledTimes(1);
    expect(section.handler).toHaveBeenCalledTimes(1);
    expect(route.handler).toHaveBeenCalledTimes(1);
    expect(byId.get("L0L1")!.component).toBe("content-L0L1");
    // The section's own loader is new to the client; its unit is not.
    expect(ran()).toEqual(["section", "page"]);
    expect(segments.some((s) => s.deferred)).toBe(false);
    expect(plan!.deferredUnit).toBeUndefined();
  });

  it("renders a held flagged route that re-renders", async () => {
    const route = entry("route", "R1", {
      ...flagged,
      revalidate: [() => true],
    });
    const { byId, plan } = await resolve([route], "prefetch", ["R1"]);

    expect(route.handler).toHaveBeenCalledTimes(1);
    expect(byId.get("R1")!.deferred).toBeUndefined();
    expect(plan!.deferredUnit).toBeUndefined();
  });

  it("runs a flagged loader on a held segment when it revalidates", async () => {
    const predicate = vi.fn(() => true);
    const reviews = { ...loaderEntry("reviews", { prefetch: false }) };
    reviews.revalidate = [predicate];
    const route = entry("route", "R1", {
      loading: "fallback",
      loader: [reviews],
    });
    const { byId } = await resolve([route], "prefetch", ["R1", "R1D0.reviews"]);

    expect(predicate).toHaveBeenCalledTimes(1);
    expect(ran()).toEqual(["reviews"]);
    expect(byId.get("R1D0.reviews")!.deferred).toBeUndefined();
  });

  it("a new route under a held flagged layout is still deferred by its own flagged loading()", async () => {
    const section = entry("layout", "L0L1", flagged);
    const route = entry("route", "R2", {
      ...flagged,
      loader: [loaderEntry("page")],
    });
    const { byId, plan } = await resolve([section, route], "prefetch", [
      "L0L1",
    ]);

    expect(route.handler).not.toHaveBeenCalled();
    expect(ran()).toEqual([]);
    expect(byId.get("R2")).toMatchObject({ deferred: true, component: null });
    expect(byId.get("R2D0.page")).toMatchObject({ deferred: true });
    expect(plan!.deferredUnit).toBe("R2");
  });

  it("does not defer a held slot with its own flagged loading()", async () => {
    const slot = entry("parallel", "P0", {
      ...flagged,
      revalidate: [() => true],
      handler: { "@side": vi.fn(() => "slot") },
      loader: [loaderEntry("slot")],
    });
    const route = entry("route", "R1", { parallel: { "@side": slot } });
    const { byId, plan } = await resolve([route], "prefetch", [
      "R1",
      "R1.@side",
    ]);

    expect(slot.handler["@side"]).toHaveBeenCalledTimes(1);
    expect(byId.get("R1.@side")!.deferred).toBeUndefined();
    // New to the client, behind a fallback the client already holds.
    expect(byId.get("R1D0.slot")!.deferred).toBeUndefined();
    expect(plan!.deferredUnit).toBeUndefined();
  });

  it("defers a slot with its own flagged loading() and runs the rest of its parent", async () => {
    const slot = entry("parallel", "P0", {
      ...flagged,
      handler: { "@side": vi.fn(() => "slot") },
      loader: [loaderEntry("slot")],
    });
    const route = entry("route", "R1", { parallel: { "@side": slot } });
    const { byId, plan } = await resolve([route], "prefetch", []);

    expect(route.handler).toHaveBeenCalledTimes(1);
    expect(slot.handler["@side"]).not.toHaveBeenCalled();
    expect(byId.get("R1.@side")).toMatchObject({
      type: "parallel",
      component: null,
      loading: "fallback",
      deferred: true,
    });
    expect(byId.get("R1D0.slot")).toMatchObject({ deferred: true });
    expect(plan!.deferredUnit).toBe("R1.@side");
  });

  it("without the prefetch mode the same tree resolves whole", async () => {
    const route = entry("route", "R1", {
      ...flagged,
      loader: [loaderEntry("own", { prefetch: false })],
    });
    const { segments } = await resolve([route], undefined, []);

    expect(route.handler).toHaveBeenCalledTimes(1);
    expect(ran()).toEqual(["own"]);
    expect(segments.some((s) => s.deferred)).toBe(false);
  });
});

describe("a fill: held is skipped outright", () => {
  it("runs what the client does not hold and no predicate of what it holds", async () => {
    const layoutPredicate = vi.fn(() => true);
    const routePredicate = vi.fn(() => true);
    const loaderPredicate = vi.fn(() => true);
    const outer = entry("layout", "L0", { revalidate: [layoutPredicate] });
    const route = entry("route", "R1", {
      loading: "fallback",
      revalidate: [routePredicate],
      loader: [
        { ...loaderEntry("price"), revalidate: [loaderPredicate] },
        loaderEntry("reviews", { prefetch: false }),
      ],
    });
    const { segments } = await resolve([outer, route], "fill", [
      "L0",
      "R1",
      "R1D0.price",
    ]);

    expect(ran()).toEqual(["reviews"]);
    expect(outer.handler).not.toHaveBeenCalled();
    expect(route.handler).not.toHaveBeenCalled();
    expect(layoutPredicate).not.toHaveBeenCalled();
    expect(routePredicate).not.toHaveBeenCalled();
    expect(loaderPredicate).not.toHaveBeenCalled();
    // Nothing is deferred in a fill, flagged or not.
    expect(segments.some((s) => s.deferred)).toBe(false);
    expect(
      segments.filter((s) => s.type === "loader").map((s) => s.id),
    ).toEqual(["R1D1.reviews"]);
  });

  it("skips a held orphan layout without asking its predicate", async () => {
    const orphanPredicate = vi.fn(() => true);
    const orphan = entry("layout", "R1L0", { revalidate: [orphanPredicate] });
    const route = entry("route", "R1", {
      loading: "fallback",
      layout: [orphan],
      loader: [loaderEntry("reviews", { prefetch: false })],
    });
    const { segments } = await resolve([entry("layout", "L0"), route], "fill", [
      "L0",
      "R1",
      "R1L0",
    ]);

    expect(orphanPredicate).not.toHaveBeenCalled();
    expect(orphan.handler).not.toHaveBeenCalled();
    expect(route.handler).not.toHaveBeenCalled();
    expect(ran()).toEqual(["reviews"]);
    // Held segments carry nothing: only the loader the client lacks does.
    expect(
      segments
        .filter((s) => s.component !== null || s.loaderData !== undefined)
        .map((s) => s.id),
    ).toEqual(["R1D0.reviews"]);
  });

  it("renders an orphan layout the client does not hold", async () => {
    const orphan = entry("layout", "R1L0");
    const route = entry("route", "R1", { layout: [orphan] });
    const { byId } = await resolve([route], "fill", ["R1"]);

    expect(route.handler).not.toHaveBeenCalled();
    expect(orphan.handler).toHaveBeenCalledTimes(1);
    expect(byId.get("R1L0")).toMatchObject({ type: "layout" });
  });

  it("renders a deferred unit and what is below it", async () => {
    const slotPredicate = vi.fn(() => false);
    const slot = entry("parallel", "P0", {
      handler: { "@side": vi.fn(() => "slot") },
      revalidate: [slotPredicate],
    });
    const outer = entry("layout", "L0");
    const section = entry("layout", "L0L1", flagged);
    const route = entry("route", "R2", {
      loader: [loaderEntry("page")],
      parallel: { "@side": slot },
    });
    const { segments, matchedIds } = await resolve(
      [outer, section, route],
      "fill",
      ["L0"],
    );

    expect(outer.handler).not.toHaveBeenCalled();
    expect(section.handler).toHaveBeenCalledTimes(1);
    expect(route.handler).toHaveBeenCalledTimes(1);
    expect(slot.handler["@side"]).toHaveBeenCalledTimes(1);
    expect(slotPredicate).not.toHaveBeenCalled();
    expect(ran()).toEqual(["page"]);
    expect(segments.some((s) => s.deferred)).toBe(false);
    expect(matchedIds).toEqual(
      expect.arrayContaining(["L0", "L0L1", "R2", "R2D0.page", "R2.@side"]),
    );
  });
});
