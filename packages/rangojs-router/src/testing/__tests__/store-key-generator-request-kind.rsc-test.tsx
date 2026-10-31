/**
 * A store `keyGenerator` result is a route record's key, and the request kind
 * stays in it: a document request, a plain navigation and each intercept
 * navigation to one URL keep their own record, whatever the keyGenerator
 * returns.
 *
 * A keyGenerator that ignored `defaultKey` (a constant, or the pathname alone)
 * dropped the `doc:` / `partial:` / `intercept:<intercept>:` prefix the
 * default key carries, so every kind read and wrote one record. After an
 * intercept navigation stored its record (the layout and the intercept's
 * slot, no route page), a document GET of the same URL rendered the
 * intercept's body and no page.
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
import { shellCacheKey } from "../index.js";
import {
  createRouter,
  createVar,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { InterceptSelectorContext } from "../../server/context.js";
import type { RequestContext } from "../../server/request-context.js";
import type { ResolvedSegment } from "../../types.js";

/** Handler runs by name: `layout`, `item-page`, `modal`, `drawer`. */
const runs: Record<string, number> = {};

function ran(name: string): void {
  runs[name] = (runs[name] ?? 0) + 1;
}

/** keyGenerators that ignore `defaultKey`. */
const KEY_GENERATORS = {
  constant: () => "items",
  "pathname only": (ctx: RequestContext) => ctx.url.pathname,
} satisfies Record<string, (ctx: RequestContext, defaultKey: string) => string>;

type Shape = keyof typeof KEY_GENERATORS;

const SHAPES = Object.keys(KEY_GENERATORS) as Shape[];

function storeOf(shape: Shape): MemorySegmentCacheStore {
  return new MemorySegmentCacheStore({ keyGenerator: KEY_GENERATORS[shape] });
}

const from =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept }) => {
      const source = (pathname: string, name: string) =>
        path(pathname, () => <ul>{`${name} body`}</ul>, { name });
      const interceptHandler = (name: string) => () => {
        ran(name);
        return <dialog>{`${name} body`}</dialog>;
      };
      return [
        cache({ ttl: 600 }, () => [
          layout(
            () => {
              ran("layout");
              return <main>shell</main>;
            },
            () => [
              source("/list", "list"),
              source("/other", "other"),
              source("/cart", "cart"),
              path(
                "/item/:id",
                () => {
                  ran("item-page");
                  return <article>item page body</article>;
                },
                { name: "item" },
              ),
              intercept("@modal", ".item", interceptHandler("modal"), {
                when: from("/list"),
              }),
              intercept("@drawer", ".item", interceptHandler("drawer"), {
                when: from("/other"),
              }),
            ],
          ),
        ]),
      ];
    }),
  );
}

type Router = Parameters<typeof serveShellRequest>[0];

/**
 * How /item/1 is requested: a document GET, or a navigation from a source
 * page. From /cart no intercept's `when()` passes (a plain navigation); from
 * /list `@modal` is selected, from /other `@drawer`.
 */
type Kind = "document" | "/cart" | "/list" | "/other";

const KINDS: readonly Kind[] = ["document", "/cart", "/list", "/other"];

/** The intercept each kind selects, if any. */
const SELECTED: Record<Kind, "modal" | "drawer" | null> = {
  document: null,
  "/cart": null,
  "/list": "modal",
  "/other": "drawer",
};

/** How the client navigates: nothing held, or the source page's segments held. */
type Held = "nothing held" | "layout held";

const HELD: readonly Held[] = ["nothing held", "layout held"];

interface Answer {
  segments: ResolvedSegment[];
  matched: string[];
  slots?: Record<string, { active: boolean; segments: string[] }>;
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  const { segments, matched, slots } = (
    await deserializeResult<{ metadata: Answer }>(result.flight!)
  ).metadata;
  return { segments, matched, slots };
}

/** The slots `metadata.slots` marks active. */
function activeSlotsOf(answer: Answer): string[] {
  return Object.entries(answer.slots ?? {})
    .filter(([, slot]) => slot.active)
    .map(([name]) => name);
}

async function partialOf(
  router: Router,
  kind: Kind,
  held: Held,
): Promise<ServeShellRequestOptions["partial"]> {
  if (kind === "document") return undefined;
  if (held === "nothing held") return { from: kind, segments: [] };
  const page = await serveShellRequest(router, kind, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  return { from: kind, segments: (await answerOf(page)).matched };
}

interface Served {
  result: ServeShellRequestResult;
  answer: Answer;
  /** Handler runs of this request. */
  runs: Record<string, number>;
}

/** Request /item/1 as `kind` against `cacheStore`. */
async function serve(
  router: Router,
  cacheStore: MemorySegmentCacheStore,
  kind: Kind,
  held: Held,
): Promise<Served> {
  const partial = await partialOf(router, kind, held);
  for (const name of Object.keys(runs)) delete runs[name];
  const result = await serveShellRequest(router, "/item/1", {
    cacheStore,
    partial,
  });
  return { result, answer: await answerOf(result), runs: { ...runs } };
}

/** `served` renders what a live render of the same request does. */
async function expectSameAsLive(
  router: Router,
  kind: Kind,
  held: Held,
  served: Served,
): Promise<void> {
  const rendered = await serve(
    router,
    new MemorySegmentCacheStore(),
    kind,
    held,
  );
  const selected = SELECTED[kind];
  const flight = served.result.flight!;
  expect(served.answer.matched, kind).toEqual(rendered.answer.matched);
  expect(activeSlotsOf(served.answer), kind).toEqual(
    activeSlotsOf(rendered.answer),
  );
  for (const name of ["modal", "drawer"] as const) {
    if (name === selected) expect(flight, kind).toContain(`${name} body`);
    else expect(flight, kind).not.toContain(`${name} body`);
  }
  // An intercept navigation that held the layout keeps the source page on
  // screen; every other request carries the page.
  if (selected === null) expect(flight, kind).toContain("item page body");
  expect(rendered.result.flight!.includes("item page body"), kind).toBe(
    flight.includes("item page body"),
  );
}

beforeEach(async () => {
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a store keyGenerator that ignores defaultKey: each request kind keeps its own record", () => {
  for (const shape of SHAPES) {
    for (const held of HELD) {
      describe(`${shape}, ${held}`, () => {
        for (const first of KINDS) {
          it(`after ${first === "document" ? "a document GET" : `a navigation from ${first}`} stored its record, every other kind renders what a live render does`, async () => {
            const router = makeRouter();
            const cacheStore = storeOf(shape);
            await serve(router, cacheStore, first, held);
            for (const kind of KINDS) {
              if (kind === first) continue;
              const served = await serve(router, cacheStore, kind, held);
              await expectSameAsLive(router, kind, held, served);
            }
          });
        }

        it("each kind HITs its own record once every kind stored one", async () => {
          const router = makeRouter();
          const cacheStore = storeOf(shape);
          for (const kind of KINDS) await serve(router, cacheStore, kind, held);
          for (const kind of KINDS) {
            const served = await serve(router, cacheStore, kind, held);
            expect(served.runs, kind).toEqual({});
            await expectSameAsLive(router, kind, held, served);
          }
        });
      });
    }
  }
});

/**
 * A document renders a layout's `loading(..., { ssr: false })` without its
 * fallback; a navigation keeps it (getDocumentModeEntry, server/context.ts).
 * Under one record, a navigation after a document showed no fallback, and a
 * document after a navigation streamed one.
 */
describe("a store keyGenerator that ignores defaultKey, over a layout with loading(..., { ssr: false }): a document and a navigation keep their own record", () => {
  function makeFallbackRouter() {
    return createRouter({}).routes(
      urls(({ layout, loading, path, cache }) => [
        path("/other", () => <p>other</p>, { name: "other" }),
        cache({ ttl: 600 }, () => [
          layout(
            () => <main>store layout</main>,
            () => [
              loading(<p>store fallback</p>, { ssr: false }),
              path(
                "/direct",
                () => {
                  ran("direct-page");
                  return <article>direct page</article>;
                },
                { name: "direct" },
              ),
            ],
          ),
        ]),
      ]),
    );
  }

  type DocKind = "document" | "navigation";

  const LIVE: Record<DocKind, { fallback: boolean; page: boolean }> = {
    document: { fallback: false, page: true },
    navigation: { fallback: true, page: true },
  };

  async function load(
    router: Router,
    cacheStore: MemorySegmentCacheStore,
    kind: DocKind,
  ): Promise<{ fallback: boolean; page: boolean; runs: number }> {
    for (const name of Object.keys(runs)) delete runs[name];
    const result = await serveShellRequest(router, "/direct", {
      cacheStore,
      partial: kind === "navigation" ? { from: "/other" } : undefined,
    });
    return {
      fallback: result.flight!.includes("store fallback"),
      page: result.flight!.includes("direct page"),
      runs: runs["direct-page"] ?? 0,
    };
  }

  it("a live document has no fallback, a live navigation has one", async () => {
    const router = makeFallbackRouter();
    for (const kind of ["document", "navigation"] as const) {
      expect(
        await load(router, new MemorySegmentCacheStore(), kind),
        kind,
      ).toEqual({ ...LIVE[kind], runs: 1 });
    }
  });

  for (const shape of SHAPES) {
    for (const [first, second] of [
      ["document", "navigation"],
      ["navigation", "document"],
    ] as const) {
      it(`${shape}: a ${second} after a ${first} stored its record renders what a live ${second} does, then each HITs its own`, async () => {
        const router = makeFallbackRouter();
        const cacheStore = storeOf(shape);
        await load(router, cacheStore, first);
        expect(await load(router, cacheStore, second)).toEqual({
          ...LIVE[second],
          runs: 1,
        });
        for (const kind of [first, second]) {
          expect(await load(router, cacheStore, kind), kind).toEqual({
            ...LIVE[kind],
            runs: 0,
          });
        }
      });
    }
  }
});

/**
 * A ppr route's shell partition is the raw keyGenerator result
 * (resolveShellPartition): the record keys keep the request kind, and the
 * shells still split per keyGenerator result.
 */
describe("a ppr route under a store keyGenerator that ignores defaultKey: shells partition per result", () => {
  const Tier = createVar<string>();

  function tierOf(ctx: { request: Request }): string {
    return ctx.request.headers.get("x-tier") ?? "none";
  }

  function makePprRouter() {
    return createRouter({})
      .use(async (ctx, next) => {
        ctx.set(Tier, tierOf(ctx));
        await next();
      })
      .routes(
        urls(({ path, cache }) => [
          path("/start", () => <p>start</p>, { name: "start" }),
          cache({ ttl: 300 }, () => [
            path(
              "/cached",
              (ctx: HandlerContext) => <p>{`cached-${ctx.get(Tier)}`}</p>,
              { name: "cached", ppr: true },
            ),
          ]),
          path(
            "/bare",
            (ctx: HandlerContext) => <p>{`bare-${ctx.get(Tier)}`}</p>,
            { name: "bare", ppr: true },
          ),
        ]),
      );
  }

  const tier = (name: string) => ({ headers: { "x-tier": name } });

  for (const [route, scope] of [
    ["/cached", "under cache()"],
    ["/bare", "with no cache()"],
  ] as const) {
    it(`${route} (${scope}): each tier captures, HITs and replays its own shell`, async () => {
      const router = makePprRouter();
      const cacheStore = new MemorySegmentCacheStore({
        keyGenerator: (ctx: RequestContext) => `tier:${tierOf(ctx)}`,
      });
      const name = route.slice(1);
      const serve = (
        tierName: string,
        extra: Omit<ServeShellRequestOptions, "cacheStore" | "headers"> = {},
      ) =>
        serveShellRequest(router, route, {
          cacheStore,
          ...tier(tierName),
          ...extra,
        });

      for (const own of ["gold", "silver"]) {
        const miss = await serve(own);
        expect(miss.shellStatus, own).toBe("MISS");
        expect(miss.flight, own).toContain(`${name}-${own}`);
        expect(miss.key, own).toBe(
          shellCacheKey(router, `http://localhost${route}`, undefined, {
            generated: [`tier:${own}`],
          }),
        );
      }
      for (const [own, other] of [
        ["gold", "silver"],
        ["silver", "gold"],
      ] as const) {
        const hit = await serve(own);
        expect(hit.shellStatus, own).toBe("HIT");
        expect(hit.prelude, own).toContain(`${name}-${own}`);
        expect(hit.body, own).not.toContain(`${name}-${other}`);

        const navigation = await serve(own, { partial: { from: "/start" } });
        expect(navigation.replayStatus?.outcome, own).toBe("HIT");
        expect(navigation.flight, own).toContain(`${name}-${own}`);
        expect(navigation.flight, own).not.toContain(`${name}-${other}`);
      }
    });
  }
});
