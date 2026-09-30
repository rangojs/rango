/**
 * A PPR navigation replay (`x-rango-ppr-replay: HIT`) makes the same segment
 * decision as the live partial path (`BYPASS; reason=no-entry`) for the same
 * navigation (#986). The live path omits a segment the client holds when its
 * `revalidate()` returns false, and a replay HIT used to send the snapshot's
 * copy of it whenever the segment declared `transition({ when })`.
 *
 * Each navigation below is served twice with one store: the first partial is
 * the live path (no snapshot for that URL yet) and schedules the
 * navigation-only capture; the second partial replays that capture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import type { PprReplayStatus } from "../index.js";
import {
  createRouter,
  urls,
  type HandlerContext,
  type Revalidate,
  type TransitionWhenContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import * as RSDServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";

/**
 * transition({ when }) is a browser predicate. In a real app it is an export
 * of a "use client" module, so the RSC graph sees a client reference; here the
 * same shape is made by tagging the function in place.
 */
let whenIds = 0;
function clientWhen<T extends (...args: never[]) => unknown>(fn: T): T {
  RSDServer.registerClientReference(fn, "test/when.ts", `when${whenIds++}`);
  return fn;
}

/** Renders the page named by `?page` (default 1), as a paged list would. */
function ListPage(ctx: HandlerContext): React.ReactNode {
  const page = ctx.url.searchParams.get("page") ?? "1";
  return <ul>{`list-page-${page}`}</ul>;
}

function ListChrome(): React.ReactNode {
  return <header>list-chrome</header>;
}

/**
 * Paging is client-managed: a same-path `?page` navigation keeps the client's
 * list. `?fresh` forces a re-render; anything else keeps the default.
 */
const listRevalidate: Revalidate = ({ currentUrl, nextUrl }) => {
  if (currentUrl.pathname !== nextUrl.pathname) return undefined;
  if (nextUrl.searchParams.has("fresh")) return true;
  return nextUrl.searchParams.has("page") ? false : undefined;
};

type Mode = "hold" | "drop" | "none";
type Placement = "route" | "layout";

/**
 * `/list` with a transition({ when }) that holds same-path navigations
 * (`hold`), drops every transition (`drop`), or is absent (`none`), on the
 * route or on the list's layout (which has no revalidate()).
 */
function makeRouter(mode: Mode, on: Placement) {
  const when = clientWhen(
    (ctx: TransitionWhenContext): boolean =>
      mode === "hold" && ctx.from.url.pathname === ctx.to.url.pathname,
  );
  return createRouter({}).routes(
    urls(({ path, layout, transition, revalidate }) => {
      // DSL items bind to the entry whose callback calls them.
      const item = (at: Placement) =>
        mode !== "none" && on === at ? [transition({ when })] : [];
      return [
        layout(ListChrome, () => [
          ...item("layout"),
          path("/list", ListPage, { name: "list", ppr: true }, () => [
            ...item("route"),
            revalidate(listRevalidate),
          ]),
        ]),
      ];
    }),
  );
}

const present = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== "$undefined";

/**
 * What the client receives: the metadata row (`0:`) of the Flight payload,
 * with each sent segment reduced to its id and the fields it carries.
 */
function payloadOf(result: ServeShellRequestResult) {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  const { segments, matched, diff } = JSON.parse(row!.slice(2)).metadata as {
    segments: Array<Record<string, unknown>>;
    matched: string[];
    diff: string[];
  };
  return {
    segments: segments.map((segment) => ({
      id: segment.id as string,
      component: present(segment.component),
      loading: present(segment.loading),
      // A client reference serializes as a "$<row>" pointer to an I row; the
      // row number is not part of the contract.
      transition: present(segment.transition)
        ? Object.fromEntries(
            Object.entries(segment.transition as Record<string, unknown>).map(
              ([k, v]) => [
                k,
                k === "when" && typeof v === "string" && v.startsWith("$")
                  ? "client-ref"
                  : v,
              ],
            ),
          )
        : undefined,
    })),
    matched,
    diff,
  };
}

type Router = Parameters<typeof serveShellRequest>[0];

const REPLAY_HIT: PprReplayStatus = { outcome: "HIT", freshness: "fresh" };

/**
 * Load `from`, then serve the same client navigation to `target` twice: live
 * (no snapshot for `target` yet) and from what the live one stored — the
 * navigation-only capture it scheduled (a replay HIT), or the route's own
 * `cache()` entry it wrote.
 */
async function liveThenReplay(
  router: Router,
  target: string,
  { from = "/list", second = REPLAY_HIT } = {},
) {
  const cacheStore = new MemorySegmentCacheStore();
  const doc = await serveShellRequest(router, from, { cacheStore });
  expect(doc.shellStatus).toBe("MISS");
  const partial = { from, segments: payloadOf(doc).matched };
  const live = await serveShellRequest(router, target, { cacheStore, partial });
  expect(live.replayStatus).toEqual({ outcome: "BYPASS", reason: "no-entry" });
  const replay = await serveShellRequest(router, target, {
    cacheStore,
    partial,
  });
  expect(replay.replayStatus).toEqual(second);
  return { live, replay };
}

function ItemPage(ctx: HandlerContext<{ id: string }>): React.ReactNode {
  return <p>{`item-${ctx.params.id}`}</p>;
}

/** Segments the navigation keeps, each with a transition({ when }). */
const keptSegmentScenarios: Array<{
  label: string;
  router: () => Router;
  from: string;
  target: string;
  second?: PprReplayStatus;
}> = [
  {
    label: "a parallel slot with transition({ when }) and revalidate() false",
    router: () =>
      createRouter({}).routes(
        urls(({ path, layout, parallel, transition, revalidate }) => [
          layout(ListChrome, () => [
            parallel({ "@aside": () => <aside>list-aside</aside> }, () => [
              transition({ when: clientWhen(() => true) }),
              revalidate(() => false),
            ]),
            path("/list", ListPage, { name: "list", ppr: true }, () => [
              revalidate(listRevalidate),
            ]),
          ]),
        ]),
      ),
    from: "/list",
    target: "/list?page=2",
  },
  {
    label: "a params change on a route with revalidate() false",
    router: () =>
      createRouter({}).routes(
        urls(({ path, transition, revalidate }) => [
          path("/item/:id", ItemPage, { name: "item", ppr: true }, () => [
            transition({ when: clientWhen(() => true) }),
            revalidate(() => false),
          ]),
        ]),
      ),
    from: "/item/1",
    target: "/item/2",
  },
  {
    label: "the transition(config, () => [...]) wrapper across its routes",
    router: () =>
      createRouter({}).routes(
        urls(({ path, transition }) => [
          transition({ when: clientWhen(() => true) }, () => [
            path("/a", () => <p>page-a</p>, { name: "a", ppr: true }),
            path("/b", () => <p>page-b</p>, { name: "b", ppr: true }),
          ]),
        ]),
      ),
    from: "/a",
    target: "/b",
  },
  {
    label: "a ppr route under an explicit cache() (explicit-cache-hit)",
    router: () =>
      createRouter({}).routes(
        urls(({ path, layout, cache, transition, revalidate }) => [
          cache({ ttl: 300 }, () => [
            layout(ListChrome, () => [
              path("/list", ListPage, { name: "list", ppr: true }, () => [
                transition({ when: clientWhen(() => true) }),
                revalidate(listRevalidate),
              ]),
            ]),
          ]),
        ]),
      ),
    from: "/list",
    target: "/list?page=2",
    second: { outcome: "BYPASS", reason: "explicit-cache-hit" },
  },
];

beforeEach(async () => {
  await resetShellTestState();
});

describe("serveShellRequest: a replay HIT honours revalidate() (#986)", () => {
  it("a ?page=2 replay on a route with transition({ when }) and revalidate() false sends no route component", async () => {
    const { live, replay } = await liveThenReplay(
      makeRouter("hold", "route"),
      "/list?page=2",
    );

    expect(payloadOf(replay).segments).toEqual([]);
    expect(payloadOf(replay)).toEqual(payloadOf(live));
    expect(replay.flight).not.toContain("list-page-2");
  });

  describe("parity: the replay HIT sends what the live BYPASS sends", () => {
    const routers: Array<[Mode, Placement]> = [
      ["hold", "route"],
      ["hold", "layout"],
      ["drop", "route"],
      ["drop", "layout"],
      // Placement is moot without a transition.
      ["none", "route"],
    ];
    const targets = [
      { target: "/list?page=2", revalidates: false }, // revalidate() false
      { target: "/list?fresh=1", revalidates: true }, // revalidate() true
      { target: "/list?sort=new", revalidates: true }, // undefined: default
    ];
    for (const [mode, on] of routers) {
      for (const { target, revalidates } of targets) {
        it(`${target}, transition ${mode} on the ${on}`, async () => {
          const { live, replay } = await liveThenReplay(
            makeRouter(mode, on),
            target,
          );

          const sent = payloadOf(live);
          expect(payloadOf(replay)).toEqual(sent);
          // Only the route re-renders, and only when revalidate() says so.
          // The payload carries the static config with the predicate as a
          // client reference, hold or drop alike: no decision is serialized.
          const carries = mode !== "none" && on === "route";
          expect(sent.segments).toEqual(
            revalidates
              ? [
                  expect.objectContaining({
                    component: true,
                    transition: carries ? { when: "client-ref" } : undefined,
                  }),
                ]
              : [],
          );
          if (!revalidates) {
            expect(replay.flight).not.toContain("list-page-2");
            expect(replay.flight).not.toContain("list-chrome");
          }
        });
      }
    }

    for (const {
      label,
      router,
      from,
      target,
      second,
    } of keptSegmentScenarios) {
      it(label, async () => {
        const { live, replay } = await liveThenReplay(router(), target, {
          from,
          second,
        });

        expect(payloadOf(replay)).toEqual(payloadOf(live));
      });
    }
  });
});
