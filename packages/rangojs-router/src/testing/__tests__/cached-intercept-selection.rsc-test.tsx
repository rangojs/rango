/**
 * Two intercepts target one route under cache(), each with its own `when()`:
 * a navigation selects one (findInterceptForRoute: the innermost whose
 * `when()` passes). Its `intercept:` record must be that intercept's own.
 *
 * The record key named only the URL, so the record written under one
 * intercept answered a navigation that selected the other: the HIT carried
 * the first intercept's slot and body while `metadata.slots` named the
 * selected slot (handleCacheHitIntercept files the stored slot under the
 * selected slot's name). Two intercepts on one layout that fill the same slot
 * share the slot's segment id, so the key names the intercept itself, not
 * only its slot.
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

import { collectHandle } from "../collect-handle.js";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { runInRequestContext } from "../index.js";
import {
  createHandle,
  createRouter,
  revalidateTag,
  updateTag,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { InterceptSelectorContext } from "../../server/context.js";
import type { ResolvedSegment } from "../../types.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Intercept handler runs by name. */
const runs: Record<string, number> = {};

function interceptHandler(name: string) {
  return (ctx: HandlerContext) => {
    runs[name] = (runs[name] ?? 0) + 1;
    ctx.use(Crumbs)(name);
    return <dialog>{`${name} body`}</dialog>;
  };
}

const from =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

/**
 * - `when`: `@modal` from /list and `@drawer` from /other, on one layout.
 * - `same slot`: two `@modal` intercepts on one layout, `modal` from /list
 *   and `sheet` from /other; they share the slot's segment id.
 */
type Shape = "when" | "same slot";

const SHAPES: readonly Shape[] = ["when", "same slot"];

/** The intercept each source selects, by shape. */
const SELECTED: Record<Shape, Record<string, string>> = {
  when: { "/list": "modal", "/other": "drawer" },
  "same slot": { "/list": "modal", "/other": "sheet" },
};

function makeRouter(shape: Shape) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept }) => {
      const source = (pathname: string, name: string) =>
        path(
          pathname,
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)(name);
            return <ul>{`${name} body`}</ul>;
          },
          { name },
        );
      // Called inside the layout's children: a DSL call attaches to the
      // entry being built.
      const second = () =>
        shape === "when"
          ? intercept("@drawer", ".item", interceptHandler("drawer"), {
              when: from("/other"),
            })
          : intercept("@modal", ".item", interceptHandler("sheet"), {
              when: from("/other"),
            });
      return [
        cache({ ttl: 600, tags: ["items"] }, () => [
          layout(
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("layout");
              return <main>shell</main>;
            },
            () => [
              source("/list", "list"),
              source("/other", "other"),
              path(
                "/item/:id",
                (ctx: HandlerContext<{ id: string }>) => {
                  ctx.use(Crumbs)("item-page");
                  return <article>item page body</article>;
                },
                { name: "item" },
              ),
              intercept("@modal", ".item", interceptHandler("modal"), {
                when: from("/list"),
              }),
              second(),
            ],
          ),
        ]),
      ];
    }),
  );
}

type Router = Parameters<typeof serveShellRequest>[0];

type HandleData = Record<string, Record<string, unknown[]>>;

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

async function handlesOf(result: ServeShellRequestResult): Promise<HandleData> {
  const handles = await result.readHandles();
  return (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
}

/**
 * The Crumbs value useHandle shows once the response lands on a client that
 * shows `before`: a segment the response carries replaces the client's.
 */
async function shownCrumbs(
  result: ServeShellRequestResult,
  before: HandleData,
): Promise<string[]> {
  const bySegment: Record<string, string[]> = {
    ...(before[Crumbs.$$id] as Record<string, string[]>),
    ...((await handlesOf(result))[Crumbs.$$id] as Record<string, string[]>),
  };
  const { matched } = await answerOf(result);
  return collectHandle(
    Crumbs,
    matched.map((id) => bySegment[id] ?? []),
  );
}

/** The intercept slots the response carries: `<segment id> <slot>`. */
function slotsOf(answer: Answer): string[] {
  return answer.segments
    .filter((s) => s.namespace?.startsWith("intercept:") && s.slot)
    .map((s) => `${s.id} ${s.slot}`);
}

/** The slots `metadata.slots` marks active. */
function activeSlotsOf(answer: Answer): string[] {
  return Object.entries(answer.slots ?? {})
    .filter(([, slot]) => slot.active)
    .map(([name]) => name);
}

/** How the client opens the intercept: nothing held, or the source page's segments held. */
type Held = "nothing held" | "layout held";

const HELD: readonly Held[] = ["nothing held", "layout held"];

async function visitOf(
  router: Router,
  source: string,
  held: Held,
): Promise<{
  partial: ServeShellRequestOptions["partial"];
  before: HandleData;
}> {
  if (held === "nothing held") {
    return { partial: { from: source, segments: [] }, before: {} };
  }
  const page = await serveShellRequest(router, source, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  return {
    partial: { from: source, segments: (await answerOf(page)).matched },
    before: await handlesOf(page),
  };
}

interface Opened {
  result: ServeShellRequestResult;
  answer: Answer;
  before: HandleData;
  /** Intercept handler runs of this request. */
  runs: Record<string, number>;
}

/** Open /item/1 from `source` against `cacheStore`. */
async function open(
  router: Router,
  cacheStore: MemorySegmentCacheStore,
  source: string,
  held: Held,
): Promise<Opened> {
  const { partial, before } = await visitOf(router, source, held);
  for (const name of Object.keys(runs)) delete runs[name];
  const result = await serveShellRequest(router, "/item/1", {
    cacheStore,
    partial,
  });
  return { result, answer: await answerOf(result), before, runs: { ...runs } };
}

/** What a live render (an empty store) of the same navigation answers. */
function live(router: Router, source: string, held: Held): Promise<Opened> {
  return open(router, new MemorySegmentCacheStore(), source, held);
}

async function expectSameAsLive(
  shape: Shape,
  source: string,
  opened: Opened,
  rendered: Opened,
): Promise<void> {
  const selected = SELECTED[shape][source]!;
  const others = Object.values(SELECTED[shape]).filter((n) => n !== selected);
  expect(slotsOf(rendered.answer)).toHaveLength(1);
  expect(slotsOf(opened.answer)).toEqual(slotsOf(rendered.answer));
  expect(activeSlotsOf(opened.answer)).toEqual(activeSlotsOf(rendered.answer));
  expect(opened.answer.matched).toEqual(rendered.answer.matched);
  expect(opened.result.flight).toContain(`${selected} body`);
  for (const other of others) {
    expect(rendered.result.flight).not.toContain(`${other} body`);
    expect(opened.result.flight).not.toContain(`${other} body`);
  }
  const shown = await shownCrumbs(rendered.result, rendered.before);
  expect(shown).toContain(selected);
  expect(await shownCrumbs(opened.result, opened.before)).toEqual(shown);
}

describe("cache() route with two intercepts selected by when(): each navigation gets the intercept it selects", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const shape of SHAPES) {
    for (const held of HELD) {
      describe(`${shape}, ${held}`, () => {
        it("opened from /other after /list, carries the intercept a live render does", async () => {
          const router = makeRouter(shape);
          const cacheStore = new MemorySegmentCacheStore();
          await open(router, cacheStore, "/list", held);
          const opened = await open(router, cacheStore, "/other", held);
          await expectSameAsLive(
            shape,
            "/other",
            opened,
            await live(router, "/other", held),
          );
        });

        it("opened from /list after /other, carries the intercept a live render does", async () => {
          const router = makeRouter(shape);
          const cacheStore = new MemorySegmentCacheStore();
          await open(router, cacheStore, "/other", held);
          const opened = await open(router, cacheStore, "/list", held);
          await expectSameAsLive(
            shape,
            "/list",
            opened,
            await live(router, "/list", held),
          );
        });

        it("keeps a record per intercept: opening again from either source is a HIT of its own", async () => {
          const router = makeRouter(shape);
          const cacheStore = new MemorySegmentCacheStore();
          await open(router, cacheStore, "/list", held);
          await open(router, cacheStore, "/other", held);
          for (const source of ["/list", "/other"]) {
            const selected = SELECTED[shape][source]!;
            const opened = await open(router, cacheStore, source, held);
            expect(opened.runs[selected] ?? 0, source).toBe(0);
            await expectSameAsLive(
              shape,
              source,
              opened,
              await live(router, source, held),
            );
          }
        });
      });
    }

    it.each(["updateTag", "revalidateTag"] as const)(
      `${shape}: %s() on the cache() tag evicts every intercept's record`,
      async (verb) => {
        const router = makeRouter(shape);
        const cacheStore = new MemorySegmentCacheStore();
        for (const source of ["/list", "/other"]) {
          await open(router, cacheStore, source, "nothing held");
        }
        await runInRequestContext(
          async () => {
            if (verb === "updateTag") await updateTag("items");
            else revalidateTag("items");
          },
          { cacheStore },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const source of ["/list", "/other"]) {
          const selected = SELECTED[shape][source]!;
          const opened = await open(router, cacheStore, source, "nothing held");
          expect(opened.runs[selected], source).toBe(1);
        }
      },
    );
  }
});
