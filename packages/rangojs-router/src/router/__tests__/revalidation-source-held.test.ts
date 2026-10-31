/**
 * evaluateRevalidation marks the match's handler context `_sourceHeld` when a
 * predicate that read the source page (currentParams, currentUrl,
 * fromRouteName) kept the segment (#1331), with what it read: the answer is
 * right for every page with equal values of those reads (rango-t242).
 * match-result.ts turns the mark into `sourceHeld`, and rsc-rendering.ts
 * into the response's `x-rsc-prefetch-scope`.
 */
import { describe, expect, it } from "vitest";
import { evaluateRevalidation } from "../revalidation.js";
import { prefetchScopeOf, type SourceHeld } from "../source-reads.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { createTestRequestContext } from "../../testing/internal/context.js";
import type { ShouldRevalidateFn } from "../../types.js";

type Held = { _sourceHeld?: SourceHeld };

const SOURCE = { category: "audio", page: "2" };

function evaluate(
  fn: ShouldRevalidateFn | ShouldRevalidateFn[],
  extra: {
    floor?: boolean;
    context?: Held;
    source?: Record<string, string>;
    next?: Record<string, string>;
    /** The segment decided for; a layout outside the route by default. */
    segment?: { type: "layout" | "route" | "loader"; belongsToRoute?: boolean };
    nextUrl?: string;
  } = {},
): Promise<{ decision: boolean; context: Held }> {
  const context: Held = extra.context ?? {};
  const request = new Request("http://localhost/cart");
  const { ctx } = createTestRequestContext({ request, params: {} });
  ctx._prevRouteKey = "shop.category";
  const fns = Array.isArray(fn) ? fn : [fn];
  return runWithRequestContext(ctx as never, () =>
    evaluateRevalidation({
      segment: {
        id: "M0L0",
        type: "layout",
        ...extra.segment,
        params: extra.next ?? {},
      } as any,
      prevParams: extra.source ?? SOURCE,
      getPrevSegment: null,
      request,
      prevUrl: new URL("http://localhost/c/audio?page=2"),
      nextUrl: new URL(extra.nextUrl ?? "http://localhost/cart"),
      revalidations: fns.map((f, i) => ({ name: `revalidate${i}`, fn: f })),
      routeKey: "cart",
      context: context as any,
      ...(extra.floor
        ? { defaultOverride: { value: true, reason: "new", floor: true } }
        : {}),
    }),
  ).then((decision) => ({ decision, context }));
}

/** What the mark records, as plain data. */
const readsOf = (context: Held) => {
  const held = context._sourceHeld;
  if (!held) return undefined;
  return {
    keys: held.reads.keys,
    params: [...held.reads.params].sort(),
    route: held.reads.route,
    url: held.reads.url,
  };
};

describe("evaluateRevalidation: a held segment decided from the source", () => {
  it.each([
    [
      "currentParams",
      (({ currentParams }) => currentParams.x === "y") as ShouldRevalidateFn,
    ],
    [
      "currentUrl",
      (({ currentUrl }) => currentUrl.pathname === "/") as ShouldRevalidateFn,
    ],
    [
      "fromRouteName",
      (({ fromRouteName }) => fromRouteName === "home") as ShouldRevalidateFn,
    ],
  ])("reading %s and keeping the segment marks the match", async (_, fn) => {
    const { decision, context } = await evaluate(fn);
    expect(decision).toBe(false);
    expect(context._sourceHeld).toBeDefined();
  });

  it("a soft decision that keeps the segment after a source read marks it", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, defaultShouldRevalidate }) =>
        currentParams.category === "audio" ? { defaultShouldRevalidate } : true,
    );
    expect(decision).toBe(false);
    expect(context._sourceHeld).toBeDefined();
  });

  it("reading the source and re-rendering does not mark it", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams }) => currentParams.category === "audio",
    );
    expect(decision).toBe(true);
    expect(context._sourceHeld).toBeUndefined();
  });

  it("keeping the segment without reading the source does not mark it", async () => {
    const { decision, context } = await evaluate(
      ({ nextParams, nextUrl, isAction, toRouteName }) =>
        isAction() || nextUrl.pathname === nextParams.x || toRouteName === "x",
    );
    expect(decision).toBe(false);
    expect(context._sourceHeld).toBeUndefined();
  });

  it("a floored seed the predicate cannot lower does not mark it", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams }) => currentParams.category !== "audio",
      { floor: true },
    );
    expect(decision).toBe(true);
    expect(context._sourceHeld).toBeUndefined();
  });
});

describe("evaluateRevalidation: what a kept decision read", () => {
  it("one param read records that param and the key set, with the source's values", async () => {
    const { context } = await evaluate(
      ({ currentParams, nextParams }) =>
        currentParams.category === nextParams.category,
    );
    expect(readsOf(context)).toEqual({
      keys: true,
      params: ["category"],
      route: false,
      url: false,
    });
    expect(context._sourceHeld!.params).toEqual(SOURCE);
  });

  it("a read of an absent param records the key set only", async () => {
    const { context } = await evaluate(
      ({ currentParams }) => currentParams.locale === "fr",
    );
    expect(readsOf(context)).toEqual({
      keys: true,
      params: [],
      route: false,
      url: false,
    });
  });

  it("a key test without a value read records the key set", async () => {
    const { context } = await evaluate(
      ({ currentParams }) => Object.keys(currentParams).length === 0,
    );
    expect(readsOf(context)).toEqual({
      keys: true,
      params: [],
      route: false,
      url: false,
    });
  });

  it.each([
    [
      "a spread",
      (({ currentParams }) =>
        Object.keys({ ...currentParams }).length === 0) as ShouldRevalidateFn,
    ],
    [
      "JSON.stringify",
      (({ currentParams }) =>
        JSON.stringify(currentParams) === "{}") as ShouldRevalidateFn,
    ],
    [
      "Object.entries",
      (({ currentParams }) =>
        Object.entries(currentParams).length === 0) as ShouldRevalidateFn,
    ],
    [
      "structuredClone",
      (({ currentParams }) =>
        structuredClone(currentParams).category ===
        "rock") as ShouldRevalidateFn,
    ],
  ])("%s reads every param", async (_, fn) => {
    const { decision, context } = await evaluate(fn);
    expect(decision).toBe(false);
    expect(readsOf(context)?.params).toEqual(["category", "page"]);
  });

  it("structuredClone of currentParams yields the values (no Proxy)", async () => {
    let cloned: unknown;
    await evaluate(({ currentParams }) => {
      cloned = structuredClone(currentParams);
      return false;
    });
    expect(cloned).toEqual(SOURCE);
  });

  it("fromRouteName records the route, with its public name", async () => {
    const { context } = await evaluate(
      ({ fromRouteName }) => fromRouteName === "home",
    );
    expect(readsOf(context)).toEqual({
      keys: false,
      params: [],
      route: true,
      url: false,
    });
    expect(context._sourceHeld!.routeName).toBe("shop.category");
  });

  it("currentUrl records the url", async () => {
    const { context } = await evaluate(
      ({ currentUrl }) => currentUrl.pathname === "/",
    );
    expect(readsOf(context)?.url).toBe(true);
  });

  it("a chain records what every rule read before the keep", async () => {
    const { context } = await evaluate([
      ({ currentParams, defaultShouldRevalidate }) =>
        currentParams.category === "audio" ? { defaultShouldRevalidate } : true,
      ({ fromRouteName }) => (fromRouteName === "x" ? true : undefined),
    ]);
    expect(readsOf(context)).toEqual({
      keys: true,
      params: ["category"],
      route: true,
      url: false,
    });
  });

  it("a rule that throws keeps what it read before the throw", async () => {
    const error = console.error;
    console.error = () => {};
    try {
      const { decision, context } = await evaluate(({ currentParams }) => {
        if (currentParams.page === "2") throw new Error("boom");
        return true;
      });
      expect(decision).toBe(false);
      expect(readsOf(context)?.params).toEqual(["page"]);
    } finally {
      console.error = error;
    }
  });

  it("segments kept in one match union their reads", async () => {
    const context: Held = {};
    await evaluate(({ currentParams }) => currentParams.category === "x", {
      context,
    });
    await evaluate(({ currentParams }) => currentParams.page === "x", {
      context,
    });
    expect(readsOf(context)?.params).toEqual(["category", "page"]);
  });
});

/** The `x-rsc-prefetch-scope` a partial answer with this mark carries. */
const headerOf = (context: Held): string | undefined =>
  prefetchScopeOf(false, context._sourceHeld, false);

const EN = { locale: "en", page: "1" };

describe("x-rsc-prefetch-scope of a decision, by what the rule read (rango-t242)", () => {
  it("a rule that reads nothing from the source: no header", async () => {
    const { context } = await evaluate(() => false, { source: EN });
    expect(headerOf(context)).toBeUndefined();
  });

  it("a rule that reads only nextParams: no header", async () => {
    const { context } = await evaluate(
      ({ nextParams }) => nextParams.locale === "fr",
      { source: EN, next: EN },
    );
    expect(headerOf(context)).toBeUndefined();
  });

  it("reads currentParams.locale and keeps: grouped by locale", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, nextParams }) =>
        currentParams.locale !== nextParams.locale,
      { source: EN, next: { locale: "en" } },
    );
    expect(decision).toBe(false);
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en");
  });

  it("reads currentParams.locale and re-renders: no header", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, nextParams }) =>
        currentParams.locale !== nextParams.locale,
      { source: EN, next: { locale: "fr" } },
    );
    expect(decision).toBe(true);
    expect(headerOf(context)).toBeUndefined();
  });

  it("reads currentParams.locale, then returns undefined so the layout's default keep applies: grouped by locale", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, nextParams }) =>
        currentParams.locale !== nextParams.locale || undefined,
      { source: EN, next: { locale: "en" } },
    );
    expect(decision).toBe(false);
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en");
  });

  it("destructuring ({ currentParams: { locale } }) records locale only", async () => {
    const { context } = await evaluate(
      ({ currentParams: { locale }, nextParams }) =>
        locale !== nextParams.locale,
      { source: EN, next: { locale: "en" } },
    );
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en");
  });

  it("a read inside a helper function is recorded", async () => {
    const localeOf = (params: Record<string, string | undefined>) =>
      params.locale ?? "en";
    const { context } = await evaluate(
      ({ currentParams, nextParams }) =>
        localeOf(currentParams) !== localeOf(nextParams),
      { source: EN, next: { locale: "en" } },
    );
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en");
  });

  it.each([
    [
      "a spread",
      (({ currentParams }) =>
        ({ ...currentParams }).locale === "x") as ShouldRevalidateFn,
    ],
    [
      "JSON.stringify",
      (({ currentParams }) =>
        JSON.stringify(currentParams) === "x") as ShouldRevalidateFn,
    ],
    [
      "structuredClone",
      (({ currentParams }) =>
        structuredClone(currentParams).locale === "x") as ShouldRevalidateFn,
    ],
  ])("%s of currentParams groups by every param", async (_, fn) => {
    const { context } = await evaluate(fn, { source: EN });
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en&page=1");
  });

  it.each([
    [
      "Object.keys",
      (({ currentParams }) =>
        Object.keys(currentParams).length === 0) as ShouldRevalidateFn,
    ],
    [
      "the in operator",
      (({ currentParams }) =>
        "page" in currentParams && false) as ShouldRevalidateFn,
    ],
  ])(
    "%s on currentParams reads no value: grouped by the key set alone",
    async (_, fn) => {
      const { decision, context } = await evaluate(fn, { source: EN });
      expect(decision).toBe(false);
      expect(headerOf(context)).toBe("params; $k=locale,page");
    },
  );

  it("a rule that writes to currentParams does not throw, and what it wrote is not a source read", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams }) => {
        currentParams.locale = "x";
        return currentParams.locale !== "x";
      },
      { source: EN },
    );
    expect(decision).toBe(false);
    expect(headerOf(context)).toBe("params; $k=locale,page");
  });

  it("fromRouteName groups by the source's route name", async () => {
    const { context } = await evaluate(
      ({ fromRouteName }) => fromRouteName === "x",
      { source: EN },
    );
    expect(headerOf(context)).toBe("params; $r=shop.category");
  });

  it("currentUrl makes the answer the exact page's: source", async () => {
    const { context } = await evaluate(
      ({ currentUrl, currentParams }) =>
        currentUrl.search === "?x" && currentParams.locale === "x",
      { source: EN },
    );
    expect(headerOf(context)).toBe("source");
  });

  it("an async rule's reads after its await are ignored with its result: the default keep stands, no header", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      let read: string | undefined;
      const { decision, context } = await evaluate(
        (async (args: { currentParams: Record<string, string> }) => {
          await Promise.resolve();
          read = args.currentParams.locale;
          return true;
        }) as unknown as ShouldRevalidateFn,
        { source: EN },
      );
      await Promise.resolve();
      expect(read).toBe("en");
      expect(decision).toBe(false);
      expect(headerOf(context)).toBeUndefined();
    } finally {
      console.warn = warn;
    }
  });

  it("two kept rules in a chain reading different keys: the union", async () => {
    const { context } = await evaluate(
      [
        ({ currentParams }) =>
          currentParams.locale === "x" ? true : undefined,
        ({ currentParams }) => (currentParams.page === "x" ? true : undefined),
      ],
      { source: EN },
    );
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en&page=1");
  });

  it("one segment kept and one re-rendered in a match: only the kept segment's reads", async () => {
    const context: Held = {};
    await evaluate(({ currentParams }) => currentParams.page === "1", {
      context,
      source: EN,
    });
    await evaluate(({ currentParams }) => currentParams.locale === "x", {
      context,
      source: EN,
    });
    expect(headerOf(context)).toBe("params; $k=locale,page&locale=en");
  });

  it("an absent optional param (undefined value) is in the key set with no value", async () => {
    const { context } = await evaluate(
      ({ currentParams }) => currentParams.region === "x",
      { source: { locale: "en", region: undefined as unknown as string } },
    );
    expect(headerOf(context)).toBe("params; $k=locale,region&region");
  });

  it("a value with =, &, ; and unicode is URI-encoded in the label", async () => {
    const { context } = await evaluate(
      ({ currentParams }) => currentParams.q === "x",
      { source: { q: "a=b&c;d ü" } },
    );
    expect(headerOf(context)).toBe(
      "params; $k=q&q=" + encodeURIComponent("a=b&c;d ü"),
    );
  });
});

/**
 * A route segment's default, and the default of a segment the route owns,
 * compares the target's params and search with the source's: no read
 * records it. A rule that read the source and fell back to that default
 * keeps the segment for this source only. Grouped by the rule's reads, a
 * rewritten source (/deals rendering /en/p/1) prefetching /en/p/1 kept the
 * product, and /en/p/2 adopted the answer and kept product 2 at /en/p/1.
 */
describe("a route's default keep compares with the source: the answer is the exact page's (review of #1344)", () => {
  const P1 = { locale: "en", id: "1" };
  // The source's search: the target's params and search equal the source's,
  // so the route default keeps.
  const sameSearch = "http://localhost/en/p/1?page=2";
  const deferToDefault: ShouldRevalidateFn = ({ currentParams, nextParams }) =>
    currentParams.locale !== nextParams.locale ? true : undefined;

  it.each([
    ["the route segment", { type: "route" as const }],
    [
      "a layout the route owns",
      { type: "layout" as const, belongsToRoute: true },
    ],
    [
      "a loader the route owns",
      { type: "loader" as const, belongsToRoute: true },
    ],
  ])(
    "a rule on %s that reads currentParams.locale and returns undefined, so the default keep applies: source",
    async (_, segment) => {
      const { decision, context } = await evaluate(deferToDefault, {
        source: P1,
        next: P1,
        segment,
        nextUrl: sameSearch,
      });
      expect(decision).toBe(false);
      expect(headerOf(context)).toBe("source");
    },
  );

  it("a rule on the route segment that returns the defaultShouldRevalidate it was given: source", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, nextParams, defaultShouldRevalidate }) =>
        currentParams.locale !== nextParams.locale || defaultShouldRevalidate,
      { source: P1, next: P1, segment: { type: "route" }, nextUrl: sameSearch },
    );
    expect(decision).toBe(false);
    expect(headerOf(context)).toBe("source");
  });

  it("a hard keep on the route segment that never reads the default: grouped by what it read", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, nextParams }) =>
        currentParams.locale !== nextParams.locale,
      {
        source: P1,
        next: { locale: "en", id: "2" },
        segment: { type: "route" },
      },
    );
    expect(decision).toBe(false);
    expect(headerOf(context)).toBe("params; $k=id,locale&locale=en");
  });

  it("the route segment kept by its default with no source read: no header, as without a rule", async () => {
    const { decision, context } = await evaluate(() => undefined, {
      source: P1,
      next: P1,
      segment: { type: "route" },
      nextUrl: sameSearch,
    });
    expect(decision).toBe(false);
    expect(headerOf(context)).toBeUndefined();
  });

  it("a layout outside the route keeps by a default that reads no source: still grouped by the rule's reads", async () => {
    const { decision, context } = await evaluate(deferToDefault, {
      source: P1,
      next: P1,
      nextUrl: sameSearch,
    });
    expect(decision).toBe(false);
    expect(headerOf(context)).toBe("params; $k=id,locale&locale=en");
  });
});

describe("prefetchScopeOf: what wins over a params group", () => {
  const held = (): SourceHeld => ({
    reads: {
      keys: true,
      params: new Set(["locale"]),
      route: false,
      url: false,
    },
    params: { locale: "en" },
    routeName: undefined,
  });

  it("an intercept that targets the route, or a prefetch: false deferral, makes it source", () => {
    expect(prefetchScopeOf(true, held(), false)).toBe("source");
    expect(prefetchScopeOf(true, undefined, false)).toBe("source");
  });

  it("a source-held answer that sends nothing is source: its adopter would commit treeless", () => {
    expect(prefetchScopeOf(false, held(), true)).toBe("source");
  });

  it("no mark and nothing source-only: shared (no header)", () => {
    expect(prefetchScopeOf(false, undefined, true)).toBeUndefined();
  });

  it("a mark with params reads: the params group", () => {
    expect(prefetchScopeOf(false, held(), false)).toBe(
      "params; $k=locale&locale=en",
    );
  });
});
