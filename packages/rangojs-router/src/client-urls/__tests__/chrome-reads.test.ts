import { describe, expect, it, vi } from "vitest";
import { chromeKeeps, chromeReadsOf } from "../chrome-reads.js";
import type { EntryData } from "../../server/context.js";
import type { HandlerContext, ShouldRevalidateFn } from "../../types.js";

type Rule = ShouldRevalidateFn<any, any>;

function entry(
  id: string,
  parent: EntryData | null,
  fields: Partial<{
    type: "layout" | "route" | "parallel" | "cache";
    revalidate: Rule[];
    loaderRules: Rule[][];
    layout: EntryData[];
    parallel: Record<string, EntryData>;
  }> = {},
): EntryData {
  return {
    id,
    shortCode: id,
    type: fields.type ?? "layout",
    parent,
    revalidate: fields.revalidate ?? [],
    loader: (fields.loaderRules ?? []).map((revalidate, index) => ({
      loader: { $$id: `${id}-loader-${index}` },
      revalidate,
    })),
    layout: fields.layout ?? [],
    parallel: fields.parallel ?? {},
    intercept: [],
    middleware: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handler: () => null,
  } as unknown as EntryData;
}

/** A group route under `chrome` (one layout entry above it). */
function routeUnder(chrome: EntryData): EntryData {
  return entry("route", chrome, { type: "route" });
}

const url = new URL("http://localhost/shop/c/audio");

function readsOf(route: EntryData, params: Record<string, string>) {
  return chromeReadsOf(
    route,
    params,
    {} as HandlerContext<any, any>,
    url,
    "shop.plp",
  );
}

// The #1331 template's rule: re-render when the category changes.
const categoryRule: Rule = ({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  if (isAction()) return false;
  return (currentParams.category ?? null) !== (nextParams.category ?? null)
    ? true
    : defaultShouldRevalidate;
};

describe("chromeReadsOf", () => {
  it("no rule above the group: no reads", () => {
    const layout = entry("L0", null);
    expect(readsOf(routeUnder(layout), { category: "audio" })).toBeUndefined();
  });

  it("records the destination params a rule read, with this page's values", () => {
    const layout = entry("L0", null, { revalidate: [categoryRule] });
    expect(readsOf(routeUnder(layout), { category: "audio" })).toEqual({
      params: { category: "audio" },
    });
    // An absent param is read too: null.
    expect(readsOf(routeUnder(layout), { productId: "1" })).toEqual({
      params: { category: null },
    });
  });

  it("an optional param present as undefined reads as null", () => {
    const layout = entry("L0", null, {
      revalidate: [({ nextParams }) => nextParams.locale === "?"],
    });
    const params = { locale: undefined } as unknown as Record<string, string>;
    expect(readsOf(routeUnder(layout), params)).toEqual({
      params: { locale: null },
    });
  });

  it("a rule that reads only the source page: no reads", () => {
    const layout = entry("L0", null, {
      revalidate: [({ currentParams }) => currentParams.category === "x"],
    });
    expect(readsOf(routeUnder(layout), { category: "audio" })).toBeUndefined();
  });

  it("walks every ancestor, their loaders, orphan layouts and parallels", () => {
    const orphan = entry("L0O", null, {
      revalidate: [({ nextParams }) => nextParams.a === "?"],
    });
    const slot = entry("L0P", null, {
      type: "parallel",
      revalidate: [({ nextParams }) => nextParams.b === "?"],
    });
    const root = entry("L0", null, {
      loaderRules: [[({ nextParams }) => nextParams.c === "?"]],
      layout: [orphan],
      parallel: { "@side": slot },
    });
    const inner = entry("L0L0", root, {
      revalidate: [({ nextParams }) => nextParams.d === "?"],
    });
    const reads = readsOf(routeUnder(inner), { a: "1", d: "4" });
    expect(reads).toEqual({
      params: { a: "1", b: null, c: null, d: "4" },
    });
  });

  it("skips the group route's own rules", () => {
    const layout = entry("L0", null);
    const route = entry("route", layout, {
      type: "route",
      revalidate: [() => true],
      loaderRules: [[() => true]],
    });
    expect(readsOf(route, {})).toBeUndefined();
  });

  it("passes each rule a navigation from this page and its segment's metadata", () => {
    const seen: unknown[] = [];
    const rule: Rule = (args) => {
      seen.push({
        segmentType: args.segmentType,
        layoutName: args.layoutName,
        slotName: args.slotName,
        method: args.method,
        isAction: args.isAction(),
        actionId: args.actionId,
        fromRouteName: args.fromRouteName,
        currentParams: { ...args.currentParams },
        currentUrl: args.currentUrl.href,
        defaultShouldRevalidate: args.defaultShouldRevalidate,
        stale: args.stale,
      });
      return undefined;
    };
    const slot = entry("L0P", null, { type: "parallel", revalidate: [rule] });
    const layout = entry("L0", null, {
      revalidate: [rule],
      loaderRules: [[rule]],
      parallel: { "@side": slot },
    });
    expect(readsOf(routeUnder(layout), { category: "audio" })).toBeUndefined();
    const common = {
      method: "GET",
      isAction: false,
      actionId: undefined,
      fromRouteName: "shop.plp",
      currentParams: { category: "audio" },
      currentUrl: url.href,
      defaultShouldRevalidate: false,
      stale: false,
    };
    expect(seen).toEqual([
      {
        ...common,
        segmentType: "layout",
        layoutName: "L0",
        slotName: undefined,
      },
      {
        ...common,
        segmentType: "loader",
        layoutName: undefined,
        slotName: undefined,
      },
      {
        ...common,
        segmentType: "parallel",
        layoutName: undefined,
        slotName: "@side",
      },
    ]);
  });

  it.each<[string, Rule]>([
    ["re-renders on every navigation", () => true],
    ["sets a true default", () => ({ defaultShouldRevalidate: true })],
    ["reads the destination URL", ({ nextUrl }) => nextUrl.pathname === "/x"],
    ["reads the destination route name", ({ toRouteName }) => !toRouteName],
    ["reads routeName", ({ routeName }) => !routeName],
    [
      "throws",
      () => {
        throw new Error("boom");
      },
    ],
  ])("a rule that %s: any destination", (_, rule) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const layout = entry("L0", null, { revalidate: [rule] });
    expect(readsOf(routeUnder(layout), { category: "audio" })).toBe("any");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("a hard false ends the chain, as evaluateRevalidation does", () => {
    const after = vi.fn(() => true);
    const layout = entry("L0", null, {
      revalidate: [({ nextParams }) => nextParams.category === "?", after],
    });
    expect(readsOf(routeUnder(layout), { category: "audio" })).toEqual({
      params: { category: "audio" },
    });
    expect(after).not.toHaveBeenCalled();
  });

  it("a soft false after a soft true keeps the chrome", () => {
    const layout = entry("L0", null, {
      revalidate: [
        () => ({ defaultShouldRevalidate: true }),
        ({ nextParams }) => ({
          defaultShouldRevalidate: nextParams.category === "?",
        }),
      ],
    });
    expect(readsOf(routeUnder(layout), { category: "audio" })).toEqual({
      params: { category: "audio" },
    });
  });

  it.each<[string, Rule]>([
    ["spreads", ({ nextParams }) => Object.keys({ ...nextParams }).length > 9],
    ["serializes", ({ nextParams }) => JSON.stringify(nextParams) === "{}"],
    ["enumerates", ({ nextParams }) => Object.keys(nextParams).length > 9],
  ])("a rule that %s the destination params reads every key", (_, rule) => {
    const layout = entry("L0", null, { revalidate: [rule] });
    expect(
      readsOf(routeUnder(layout), { category: "audio", page: "2" }),
    ).toEqual({
      params: expect.objectContaining({ category: "audio", page: "2" }),
      keys: true,
    });
  });
});

describe("chromeKeeps", () => {
  it("no reads: every destination", () => {
    expect(chromeKeeps(undefined, { productId: "1" })).toBe(true);
  });

  it("any: no destination", () => {
    expect(chromeKeeps("any", {})).toBe(false);
  });

  it("compares each read param, an absent one as null", () => {
    const fromCategory = { params: { category: "audio" } };
    expect(chromeKeeps(fromCategory, { category: "audio" })).toBe(true);
    expect(chromeKeeps(fromCategory, { category: "video" })).toBe(false);
    expect(chromeKeeps(fromCategory, { productId: "1" })).toBe(false);

    const fromProduct = { params: { category: null } };
    expect(chromeKeeps(fromProduct, { productId: "2" })).toBe(true);
    expect(chromeKeeps(fromProduct, {})).toBe(true);
    expect(chromeKeeps(fromProduct, { category: undefined })).toBe(true);
    expect(chromeKeeps(fromProduct, { category: "audio" })).toBe(false);
  });

  it("an inherited name is not a param", () => {
    expect(chromeKeeps({ params: { toString: null } }, {})).toBe(true);
  });

  it("keys: a destination with another param differs", () => {
    const reads = { params: { locale: "en" }, keys: true as const };
    expect(chromeKeeps(reads, { locale: "en" })).toBe(true);
    expect(chromeKeeps(reads, { locale: "en", id: "1" })).toBe(false);
    expect(chromeKeeps(reads, { locale: "en", id: undefined })).toBe(true);
  });
});
