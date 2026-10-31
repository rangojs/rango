/**
 * A parallel slot of an orphan layout (a routeless layout() beside the
 * routes) answers to its own revalidate() rules on a navigation that holds
 * it, live, from a cache() HIT and from a Prerender() bake alike.
 *
 * The live walk reads the slot's rules from its entry (resolveParallelSegments,
 * the slot id `${orphan}.@slot`). A cache() HIT (cachedSegmentSends) and a
 * bake HIT (storedEntrySends) look them up in buildEntryRevalidateMap, which
 * filed an orphan's slots under the orphan's parent, so a held slot whose rule
 * asks for it stayed held on a HIT, and a route-scoped one whose rule declines
 * it was re-sent from a cache() HIT. When the parent declared a slot of the
 * same name, the orphan's slot overwrote the parent's rules under that key.
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
import { createRouter, Prerender, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { ResolvedSegment } from "../../types.js";

/** Where the destination page comes from. */
type Target = "live" | "cache" | "prerender";

const TARGETS: readonly Target[] = ["live", "cache", "prerender"];

/**
 * Where the slot with the rule sits: in an orphan layout beside the routes or
 * inside the path(), or ("shared") in the layout itself, whose orphan beside
 * the routes declares a slot of the same name with no rule.
 */
type Placement = "layout" | "path" | "shared";

interface Shape {
  placement: Placement;
  /** What the slot's revalidate() returns. */
  rule: boolean;
}

const RULED_BODY = "ruled slot body";
const PLAIN_BODY = "plain slot body";

const page = (name: string) => <article>{name} body</article>;

const itemPage = (ctx: { params: { id: string } }) =>
  page(`item ${ctx.params.id}`);

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }, { id: "2" }],
  itemPage,
);
const PrerenderedA = Prerender(() => page("a"));
const PrerenderedB = Prerender(() => page("b"));

function makeRouter(target: Target, shape: Shape) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, parallel, revalidate }) => {
      const shared = shape.placement === "shared";
      const ruledSlot = () =>
        parallel({ "@oside": () => <aside>{RULED_BODY}</aside> }, () => [
          revalidate(() => shape.rule),
        ]);
      const orphan = () =>
        layout(
          () => <section>orphan body</section>,
          () => [
            shared
              ? parallel({ "@oside": () => <aside>{PLAIN_BODY}</aside> })
              : ruledSlot(),
          ],
        );
      const inPath = () => (shape.placement === "path" ? [orphan()] : []);
      const prerender = target === "prerender";
      const tree = () =>
        layout(
          () => <main>shell body</main>,
          () => [
            ...(shared ? [ruledSlot()] : []),
            ...(shape.placement === "path" ? [] : [orphan()]),
            path(
              "/item/:id",
              prerender ? PrerenderedItem : itemPage,
              { name: "item" },
              inPath,
            ),
            path("/a", prerender ? PrerenderedA : () => page("a"), {
              name: "a",
            }),
            path("/b", prerender ? PrerenderedB : () => page("b"), {
              name: "b",
            }),
          ],
        );
      return target === "cache"
        ? [cache({ ttl: 600 }, () => [tree()])]
        : [tree()];
    }),
  );
}

interface Answer {
  segments: ResolvedSegment[];
  matched: string[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  return (await deserializeResult<{ metadata: Answer }>(result.flight!))
    .metadata;
}

interface Navigation {
  name: string;
  from: string;
  to: string;
}

const PARAMS_CHANGE: Navigation = {
  name: "params change",
  from: "/item/1",
  to: "/item/2",
};
const PARAMS_KEPT: Navigation = {
  name: "no params change",
  from: "/a",
  to: "/b",
};

/** What the client holds when it asks for `to`. */
type Held = "nothing" | "layouts";

/**
 * Serve `to`: a document request when the client holds nothing, else the
 * navigation from `from` with every segment of that page held. Under cache()
 * and over a Prerender() the second request is the one compared: the first
 * writes the record or bakes the artifact. Returns the `@oside` slot ids in
 * walker order: the slot with the rule, then the orphan's plain one
 * ("shared").
 */
async function serve(
  target: Target,
  { shape, navigation, held }: Case,
): Promise<{ result: ServeShellRequestResult; slotIds: string[] }> {
  const router = makeRouter(target, shape);
  const source = await serveShellRequest(router, navigation.from, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  const { matched } = await answerOf(source);
  const slotIds = matched.filter((id) => id.endsWith(".@oside"));
  expect(slotIds).toHaveLength(shape.placement === "shared" ? 2 : 1);
  const cacheStore = new MemorySegmentCacheStore();
  const request = () =>
    serveShellRequest(router, navigation.to, {
      cacheStore,
      ...(held === "layouts"
        ? { partial: { from: navigation.from, segments: matched } }
        : {}),
    });
  if (target !== "live") await request();
  return { result: await request(), slotIds };
}

/** Whether the response carries the slot's content (`body`). */
async function slotSent(
  result: ServeShellRequestResult,
  slotId: string,
  body: string,
): Promise<boolean> {
  const { segments } = await answerOf(result);
  const slot = segments.find((s) => s.id === slotId);
  const sent = slot !== undefined && slot.component !== null;
  expect(result.flight!.includes(body)).toBe(sent);
  return sent;
}

interface Case {
  shape: Shape;
  navigation: Navigation;
  held: Held;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const rule of [true, false]) {
    for (const held of ["nothing", "layouts"] as const) {
      for (const navigation of [PARAMS_CHANGE, PARAMS_KEPT]) {
        for (const placement of ["layout", "shared"] as const) {
          out.push({ shape: { placement, rule }, navigation, held });
        }
      }
      // A route-scoped orphan exists only on its own route.
      out.push({
        shape: { placement: "path", rule },
        navigation: PARAMS_CHANGE,
        held,
      });
    }
  }
  return out;
}

/**
 * Whether `target` sends the slot: a slot the client lacks always, a held one
 * as its rule says. A bake HIT consults no rule (storedEntrySends) when the
 * params did not change, and sends a route's own segments whenever they did.
 */
function sends(target: Target, { shape, navigation, held }: Case): boolean {
  const byRule = held === "nothing" || shape.rule;
  if (target !== "prerender") return byRule;
  if (shape.placement === "path") return true;
  if (navigation === PARAMS_KEPT) return held === "nothing";
  return byRule;
}

describe("an orphan layout's parallel slot follows its revalidate() rules, live, from cache() and from a Prerender() bake", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });

  for (const c of cases()) {
    const where =
      c.shape.placement === "shared"
        ? "layout's own slot beside an orphan's slot of the same name"
        : `orphan in the ${c.shape.placement}`;
    const title = `${where}, revalidate(() => ${c.shape.rule}), ${c.navigation.name}, client holds ${c.held}`;
    describe(title, () => {
      for (const target of TARGETS) {
        const send = sends(target, c);
        it(`${target}: ${send ? "sends" : "keeps"} the slot`, async () => {
          const {
            result,
            slotIds: [slotId],
          } = await serve(target, c);
          expect(await slotSent(result, slotId!, RULED_BODY)).toBe(send);
        });
        if (c.shape.placement === "shared" && c.held === "layouts") {
          it(`${target}: keeps the orphan's slot, which has no rule`, async () => {
            const {
              result,
              slotIds: [, plainId],
            } = await serve(target, c);
            expect(await slotSent(result, plainId!, PLAIN_BODY)).toBe(false);
          });
        }
      }
    });
  }
});
