/**
 * A `cache({ key })` record is per request kind, as a default-keyed one is:
 * a document request, a plain navigation and each intercept navigation to
 * one URL keep their own record, and the `key()` result decides sharing
 * within one kind.
 *
 * The scope's own `key()` replaced the whole default key, the
 * `doc:` / `partial:` / `intercept:<intercept>:` prefix included, so every
 * kind read and wrote one record. After an intercept navigation stored its
 * record (the layout and the intercept's slot, no route page), a navigation
 * that selected no intercept and a document GET of the same URL both
 * rendered the intercept's body and dropped the page.
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
import { runInRequestContext } from "../index.js";
import {
  createRouter,
  revalidateTag,
  updateTag,
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

const from =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

/**
 * - `by path`: `key()` names the path, as a default key does.
 * - `shared`: `key()` ignores the `:id` param, so /item/1 and /item/2 share
 *   a record on purpose.
 */
type KeyShape = "by path" | "shared";

const KEYS: Record<KeyShape, (ctx: RequestContext) => string> = {
  "by path": (ctx) => `page:${ctx.url.pathname}`,
  shared: () => "items",
};

function makeRouter(keyShape: KeyShape) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept }) => {
      const source = (pathname: string, name: string) =>
        path(pathname, () => <ul>{`${name} body`}</ul>, { name });
      const interceptHandler = (name: string) => () => {
        ran(name);
        return <dialog>{`${name} body`}</dialog>;
      };
      return [
        cache({ ttl: 600, tags: ["items"], key: KEYS[keyShape] }, () => [
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
 * How /item/:id is requested: a document GET, or a navigation from a
 * source page. From /cart no intercept's `when()` passes (a plain
 * navigation); from /list `@modal` is selected, from /other `@drawer`.
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

/** Request `url` as `kind` against `cacheStore`. */
async function serve(
  router: Router,
  cacheStore: MemorySegmentCacheStore,
  kind: Kind,
  held: Held,
  url = "/item/1",
): Promise<Served> {
  const partial = await partialOf(router, kind, held);
  for (const name of Object.keys(runs)) delete runs[name];
  const result = await serveShellRequest(router, url, { cacheStore, partial });
  return { result, answer: await answerOf(result), runs: { ...runs } };
}

/** The same request against an empty store: a live render. */
function live(router: Router, kind: Kind, held: Held): Promise<Served> {
  return serve(router, new MemorySegmentCacheStore(), kind, held);
}

/** `served` renders what a live render of the same request does. */
async function expectSameAsLive(
  router: Router,
  kind: Kind,
  held: Held,
  served: Served,
): Promise<void> {
  const rendered = await live(router, kind, held);
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

describe("cache({ key }) route with intercepts: each request kind keeps its own record", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const held of HELD) {
    describe(held, () => {
      for (const first of KINDS) {
        it(`after ${first === "document" ? "a document GET" : `a navigation from ${first}`} stored its record, every other kind renders what a live render does`, async () => {
          const router = makeRouter("by path");
          const cacheStore = new MemorySegmentCacheStore();
          await serve(router, cacheStore, first, held);
          for (const kind of KINDS) {
            if (kind === first) continue;
            const served = await serve(router, cacheStore, kind, held);
            await expectSameAsLive(router, kind, held, served);
          }
        });
      }

      it("each kind HITs its own record once every kind stored one", async () => {
        const router = makeRouter("by path");
        const cacheStore = new MemorySegmentCacheStore();
        for (const kind of KINDS) await serve(router, cacheStore, kind, held);
        for (const kind of KINDS) {
          const served = await serve(router, cacheStore, kind, held);
          expect(served.runs, kind).toEqual({});
          await expectSameAsLive(router, kind, held, served);
        }
      });

      it("a key() that ignores a param still shares one record per kind across URLs", async () => {
        const router = makeRouter("shared");
        const cacheStore = new MemorySegmentCacheStore();
        for (const kind of KINDS) await serve(router, cacheStore, kind, held);
        for (const kind of KINDS) {
          const served = await serve(router, cacheStore, kind, held, "/item/2");
          expect(served.runs, kind).toEqual({});
          await expectSameAsLive(router, kind, held, served);
        }
      });
    });
  }

  it.each(["updateTag", "revalidateTag"] as const)(
    "%s() on the cache() tag evicts every kind's record",
    async (verb) => {
      const router = makeRouter("by path");
      const cacheStore = new MemorySegmentCacheStore();
      for (const kind of KINDS) {
        await serve(router, cacheStore, kind, "nothing held");
      }
      await runInRequestContext(
        async () => {
          if (verb === "updateTag") await updateTag("items");
          else revalidateTag("items");
        },
        { cacheStore },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const kind of KINDS) {
        const served = await serve(router, cacheStore, kind, "nothing held");
        expect(served.runs[SELECTED[kind] ?? "item-page"], kind).toBe(1);
      }
    },
  );
});

/**
 * A document renders a layout's `loading(..., { ssr: false })` without its
 * fallback; a navigation keeps it (getDocumentModeEntry, server/context.ts).
 * So a document record and a navigation record of one URL hold different
 * segments. Under one record, a navigation after a document showed no
 * fallback, and a document after a navigation streamed one.
 */
describe("cache({ key }) over a layout with loading(..., { ssr: false }): a document and a navigation keep their own record", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });

  /** Every request shares one `key()` result. */
  function makeFallbackRouter() {
    return createRouter({}).routes(
      urls(({ layout, loading, path, cache }) => [
        path("/other", () => <p>other</p>, { name: "other" }),
        cache({ ttl: 600, key: () => "store" }, () => [
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
    expect(
      await load(router, new MemorySegmentCacheStore(), "document"),
    ).toEqual({ fallback: false, page: true, runs: 1 });
    expect(
      await load(router, new MemorySegmentCacheStore(), "navigation"),
    ).toEqual({ fallback: true, page: true, runs: 1 });
  });

  for (const [first, second] of [
    ["document", "navigation"],
    ["navigation", "document"],
  ] as const) {
    it(`a ${second} after a ${first} stored its record renders what a live ${second} does, then each HITs its own`, async () => {
      const router = makeFallbackRouter();
      const cacheStore = new MemorySegmentCacheStore();
      const live = {
        document: { fallback: false, page: true },
        navigation: { fallback: true, page: true },
      };
      await load(router, cacheStore, first);
      expect(await load(router, cacheStore, second)).toEqual({
        ...live[second],
        runs: 1,
      });
      for (const kind of [first, second]) {
        expect(await load(router, cacheStore, kind), kind).toEqual({
          ...live[kind],
          runs: 0,
        });
      }
    });
  }
});
