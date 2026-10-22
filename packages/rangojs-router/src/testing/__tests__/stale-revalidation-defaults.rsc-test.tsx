/**
 * What a stale revalidation (`_rsc_stale`, the request Back/Forward sends for
 * a history entry an action marked stale) re-renders of a page the client
 * holds, against a plain revalidation and the action's own, through
 * serveShellRequest and runRevalidate.
 *
 * It takes an action's defaults (router/revalidation.ts): the route segment,
 * every loader and the route's children re-render; parent-chain layouts stay;
 * revalidate() still decides. It renders live as an action does
 * (router/match-context.ts rendersLive): no route-cache record or PPR replay,
 * either of which can predate the action's write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createMemoryPrerenderStore,
  runRevalidate,
  setBuildVersions,
  type RunRevalidateOptions,
} from "../index.js";
import {
  createLoader,
  createRouter,
  Prerender,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { RevalidateParams } from "../../types.js";

const runs: Record<string, number> = {};
const count = (name: string): number => runs[name] ?? 0;
const ran = (name: string): void => {
  runs[name] = count(name) + 1;
};
const resetRuns = (): void => {
  for (const key of Object.keys(runs)) delete runs[key];
};

function counted(name: string) {
  return createLoader(async () => {
    ran(name);
    return name;
  });
}

const CartLoader = counted("layoutLoader");
const OptOutLoader = counted("optOutLoader");
const StaleOptInLoader = counted("staleOptInLoader");
const PageLoader = counted("routeLoader");
const InterceptLoader = counted("interceptLoader");
const HeldInterceptLoader = counted("heldInterceptLoader");

/** What the /cached and /shelled handlers render; the action bumps it. */
let written = 0;
async function write(): Promise<number> {
  written += 1;
  return written;
}
const WRITE = "src/cart.actions.ts#write";

const router = createRouter({}).routes(
  urls(({ path, layout, loader, parallel, intercept, cache, revalidate }) => [
    layout(
      () => {
        ran("layout");
        return <main>shell</main>;
      },
      () => [
        // A layout loader on the defaults, one that opts out, one that
        // opts in to stale requests only.
        loader(CartLoader),
        loader(OptOutLoader, () => [revalidate(false)]),
        loader(StaleOptInLoader, () => [revalidate(({ stale }) => !!stale)]),
        path(
          "/a",
          () => {
            ran("route");
            return <p>a</p>;
          },
          { name: "a" },
          () => [
            loader(PageLoader),
            // A route child (belongsToRoute).
            parallel({
              "@side": () => {
                ran("routeSlot");
                return <aside>side</aside>;
              },
            }),
          ],
        ),
        path("/b", () => <p>b</p>, { name: "b" }),
        path("/photo/:id", () => <article>photo</article>, { name: "photo" }),
        intercept(
          "@detail",
          ".photo",
          () => <dialog>photo</dialog>,
          () => [
            loader(InterceptLoader),
            loader(HeldInterceptLoader, () => [revalidate(false)]),
          ],
        ),
        cache({ ttl: 300 }, () => [
          path("/cached", () => <p>{`cached-${written}`}</p>, {
            name: "cached",
          }),
        ]),
        path("/shelled", () => <p>{`shelled-${written}`}</p>, {
          name: "shelled",
          ppr: true,
        }),
      ],
    ),
  ]),
);

function metadataOf(result: ServeShellRequestResult): { matched: string[] } {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return JSON.parse(row!.slice(2)).metadata;
}

const cacheStore = new MemorySegmentCacheStore();
const serve = (
  url: string,
  extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
) => serveShellRequest(router, url, { cacheStore, ...extra });

/** The segment ids `at` holds after a navigation to it; runs reset. */
async function standingOn(at: string, from = "/b"): Promise<string[]> {
  const held = metadataOf(await serve(at, { partial: { from } })).matched;
  resetRuns();
  return held;
}

/** What re-ran, by name, for every handler and loader of /a. */
function rerun(): Record<string, number> {
  return {
    layout: count("layout"),
    layoutLoader: count("layoutLoader"),
    optOutLoader: count("optOutLoader"),
    staleOptInLoader: count("staleOptInLoader"),
    route: count("route"),
    routeLoader: count("routeLoader"),
    routeSlot: count("routeSlot"),
  };
}

beforeEach(async () => {
  resetRuns();
  written = 0;
  await resetShellTestState();
});

describe("a revalidation of the page the client holds", () => {
  const none = {
    layout: 0,
    layoutLoader: 0,
    optOutLoader: 0,
    staleOptInLoader: 0,
    route: 0,
    routeLoader: 0,
    routeSlot: 0,
  };
  const actionDefaults = {
    ...none,
    layoutLoader: 1,
    route: 1,
    routeLoader: 1,
    routeSlot: 1,
  };

  it.each([
    {
      request: "a plain one",
      send: (held: string[]) =>
        serve("/a", { partial: { from: "/a", segments: held } }),
      expected: none,
    },
    {
      request: "the action's own",
      send: (held: string[]) =>
        serve("/a", { action: { ref: write, id: WRITE, segments: held } }),
      expected: actionDefaults,
    },
    {
      // Back/Forward onto an entry an action made stale
      // (browser/navigation-client.ts).
      request: "a stale one",
      send: (held: string[]) =>
        serve("/a", { partial: { from: "/a", segments: held, stale: true } }),
      expected: { ...actionDefaults, staleOptInLoader: 1 },
    },
  ])("$request re-runs what the defaults pick", async ({ send, expected }) => {
    await send(await standingOn("/a"));
    expect(rerun()).toEqual(expected);
  });

  it("a stale one of an intercept entry re-runs the layout's loader above it; the intercept's revalidate(false) loader stays", async () => {
    const held = metadataOf(
      await serve("/photo/1", {
        partial: { from: "/a", interceptSource: "/a" },
      }),
    ).matched;
    resetRuns();

    // The intercept's params differ from its source's: its loader re-runs
    // on a plain revalidation too.
    await serve("/photo/1", {
      partial: { from: "/a", segments: held, interceptSource: "/a" },
    });
    expect({
      interceptLoader: count("interceptLoader"),
      layoutLoader: count("layoutLoader"),
    }).toEqual({ interceptLoader: 1, layoutLoader: 0 });
    resetRuns();

    await serve("/photo/1", {
      partial: {
        from: "/a",
        segments: held,
        interceptSource: "/a",
        stale: true,
      },
    });
    expect({
      interceptLoader: count("interceptLoader"),
      heldInterceptLoader: count("heldInterceptLoader"),
      layoutLoader: count("layoutLoader"),
      layout: count("layout"),
    }).toEqual({
      interceptLoader: 1,
      heldInterceptLoader: 0,
      layoutLoader: 1,
      layout: 0,
    });
  });
});

describe("a stale revalidation after an action renders live", () => {
  it("on a cache() route: the record from before the action is not sent over the client's newer copy", async () => {
    const held = await standingOn("/cached");
    // The record is stored, and hit.
    expect(
      (await serve("/cached", { partial: { from: "/b" } })).flight,
    ).toContain("cached-0");

    // An action re-renders live and stores nothing: the client shows its
    // write.
    const action = await serve("/cached", {
      action: { ref: write, id: WRITE, segments: held },
    });
    expect(action.flight).toContain("cached-1");

    // From a page whose search differs, so a record hit would re-send the
    // route segment: the record's cached-0 over the client's cached-1.
    const stale = await serve("/cached", {
      partial: { from: "/b?x=1", segments: held, stale: true },
    });
    expect(stale.flight).toContain("cached-1");
    expect(stale.flight).not.toContain("cached-0");
  });

  it("on a ppr route: it bypasses the navigation replay", async () => {
    // Captured and served as a shell; a navigation replays its record.
    expect((await serve("/shelled")).shellStatus).toBe("MISS");
    expect((await serve("/shelled")).shellStatus).toBe("HIT");
    const navigation = await serve("/shelled", { partial: { from: "/b" } });
    expect(navigation.replayStatus?.outcome).toBe("HIT");
    const held = metadataOf(navigation).matched;

    const action = await serve("/shelled", {
      action: { ref: write, id: WRITE, segments: held },
    });
    expect(action.flight).toContain("shelled-1");

    const stale = await serve("/shelled", {
      partial: { from: "/shelled", segments: held, stale: true },
    });
    expect(stale.replayStatus).toEqual({ outcome: "BYPASS", reason: "stale" });
    expect(stale.flight).toContain("shelled-1");
  });

  describe("on an on-demand prerender route", () => {
    const stamps = { producer: 0 };
    const ArticleDef = Prerender<{ slug: string }>(
      async () => [],
      async (ctx) => {
        stamps.producer += 1;
        return <h1>{`${ctx.params.slug}:stamp-${stamps.producer}`}</h1>;
      },
      { onDemand: { ttl: 3600 } },
    );

    afterEach(() => setBuildVersions());

    it("re-sends an entry refreshed since the client's copy, as on an action; a plain one keeps the client's", async () => {
      stamps.producer = 0;
      const store = createMemoryPrerenderStore();
      const prerendered = createRouter({ prerender: { store } }).routes(
        urls(({ path }) => [
          path("/", () => <p>home</p>, { name: "home" }),
          path("/article/:slug", ArticleDef, { name: "article" }),
        ]),
      );
      const refresh = prerendered.prerender({ env: {} });

      await refresh("/article/intro");
      const held = metadataOf(
        await serveShellRequest(prerendered, "/article/intro", {
          partial: { from: "/" },
        }),
      ).matched;
      // A refresh replaces the entry the client's copy came from.
      await refresh("/article/intro");
      expect(stamps.producer).toBe(2);

      const plain = await serveShellRequest(prerendered, "/article/intro", {
        partial: { from: "/article/intro", segments: held },
      });
      expect(plain.flight).not.toContain("intro:stamp-2");

      const stale = await serveShellRequest(prerendered, "/article/intro", {
        partial: { from: "/article/intro", segments: held, stale: true },
      });
      expect(stale.flight).toContain("intro:stamp-2");
    });
  });
});

describe("what a revalidate() predicate sees on a stale request", () => {
  /** The arguments a predicate gets on a stale request for `segment`. */
  async function staleArgs(
    segment: Pick<RunRevalidateOptions, "segmentType" | "belongsToRoute">,
  ): Promise<RevalidateParams> {
    let seen: RevalidateParams | undefined;
    await runRevalidate(
      (args) => {
        seen = args;
      },
      { ...segment, stale: true },
    );
    return seen!;
  }

  it("stale is true, and it is not an action", async () => {
    const args = await staleArgs({ belongsToRoute: false });
    expect(args.stale).toBe(true);
    expect(args.method).toBe("GET");
    expect(args.actionId).toBeUndefined();
    expect(args.isAction()).toBe(false);
  });

  it.each([
    ["a layout loader", { belongsToRoute: false }, true],
    ["a route", { segmentType: "route", belongsToRoute: true }, true],
    [
      "a parent-chain layout",
      { segmentType: "layout", belongsToRoute: false },
      false,
    ],
  ] satisfies [
    string,
    Pick<RunRevalidateOptions, "segmentType" | "belongsToRoute">,
    boolean,
  ][])(
    "defaultShouldRevalidate is the action's default for %s",
    async (_segment, segment, expected) => {
      expect((await staleArgs(segment)).defaultShouldRevalidate).toBe(expected);
    },
  );
});
