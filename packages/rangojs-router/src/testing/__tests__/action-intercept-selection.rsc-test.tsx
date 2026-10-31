/**
 * Two intercepts target one route, each selected by its own `when()`. A
 * server action submitted from the open intercept must answer with that
 * intercept: its slot, its body, its loaders re-run, and no other intercept.
 *
 * The action's match skipped `when()` and took the first intercept declared
 * for the route, whichever the client had open. With different slots the
 * answer opened the first one next to the open one (the client keeps the
 * held slot and adds the answered one), and the open one's loaders did not
 * re-run; with one shared slot the open intercept's content was replaced.
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
import {
  Prerender,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { InterceptSelectorContext } from "../../server/context.js";
import type { ResolvedSegment } from "../../types.js";

/** Intercept handler and loader runs, by intercept name. */
const runs: Record<string, number> = {};
const loaderRuns: Record<string, number> = {};

function clearRuns(): void {
  for (const name of Object.keys(runs)) delete runs[name];
  for (const name of Object.keys(loaderRuns)) delete loaderRuns[name];
}

function interceptLoader(name: string) {
  return createLoader(async () => {
    loaderRuns[name] = (loaderRuns[name] ?? 0) + 1;
    return { name };
  });
}

const ModalLoader = interceptLoader("modal");
const DrawerLoader = interceptLoader("drawer");
const SheetLoader = interceptLoader("sheet");

function interceptHandler(name: string) {
  return (_ctx: HandlerContext) => {
    runs[name] = (runs[name] ?? 0) + 1;
    return <dialog>{`${name} body`}</dialog>;
  };
}

const from =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

/**
 * - `different slots`: `@modal` from /list, then `@drawer` from /other.
 * - `same slot`: `@modal` "modal" from /list, then `@modal` "sheet" from
 *   /other; they share the slot's segment id.
 * - `single`: only the `@drawer` intercept from /other.
 * - `include names`: `different slots` under `include("/", ..., { name:
 *   "shop" })`, the `@drawer` declared for the bare name "item", which the
 *   route matches as its local name (the route's own name is "shop.item").
 * - `same slot, split names`: `same slot` under that include, "sheet"
 *   declared for the local name: the two share the slot's id across names.
 * - `parallel default`: `different slots` with a `parallel()` default for
 *   `@modal` on the layout, which holds the modal's slot id while the drawer
 *   is open.
 * - `parallel default, include names`: the same under the include, the
 *   drawer declared for the local name: the held `@modal` id is the route's
 *   own name's intercept, the drawer its local name's.
 */
type Shape =
  | "different slots"
  | "same slot"
  | "single"
  | "include names"
  | "same slot, split names"
  | "parallel default"
  | "parallel default, include names";

/** Shapes mounted under `include("/", ..., { name: "shop" })`. */
const INCLUDED: ReadonlySet<Shape> = new Set<Shape>([
  "include names",
  "same slot, split names",
  "parallel default, include names",
]);

/** Shapes whose layout has a `parallel()` default for `@modal`. */
const PARALLEL_DEFAULT: ReadonlySet<Shape> = new Set<Shape>([
  "parallel default",
  "parallel default, include names",
]);

/** The route the intercepts open over: a live one or a Prerender() one. */
type Target = "live" | "prerender";

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }],
  () => <article>item page body</article>,
);

const liveItem = (): React.ReactNode => <article>item page body</article>;

async function touch(): Promise<string> {
  return "touched";
}

function makeRouter(shape: Shape, cached: boolean, target: Target) {
  // The drawer, or the sheet, targets the route's local name where its shape
  // says so.
  const drawerTarget =
    shape === "include names" || shape === "parallel default, include names"
      ? "item"
      : ".item";
  const sheetTarget = shape === "same slot, split names" ? "item" : ".item";
  const patterns = urls(
    ({ path, cache, layout, intercept, loader, parallel }) => {
      const source = (pathname: string, name: string) =>
        path(pathname, () => <ul>{`${name} body`}</ul>, { name });
      // Called inside the layout's children: a DSL call attaches to the
      // entry being built.
      const modal = () =>
        intercept(
          "@modal",
          ".item",
          interceptHandler("modal"),
          { when: from("/list") },
          () => [loader(ModalLoader)],
        );
      const drawer = () =>
        intercept(
          "@drawer",
          drawerTarget,
          interceptHandler("drawer"),
          { when: from("/other") },
          () => [loader(DrawerLoader)],
        );
      const sheet = () =>
        intercept(
          "@modal",
          sheetTarget,
          interceptHandler("sheet"),
          { when: from("/other") },
          () => [loader(SheetLoader)],
        );
      const intercepts = () =>
        shape === "single"
          ? [drawer()]
          : shape === "same slot" || shape === "same slot, split names"
            ? [modal(), sheet()]
            : [modal(), drawer()];
      const parallels = () =>
        PARALLEL_DEFAULT.has(shape)
          ? [parallel({ "@modal": () => <aside>no modal</aside> })]
          : [];
      const tree = layout(
        () => <main>shell</main>,
        () => [
          ...parallels(),
          source("/list", "list"),
          source("/other", "other"),
          path(
            "/item/:id",
            target === "prerender" ? PrerenderedItem : liveItem,
            { name: "item" },
          ),
          ...intercepts(),
        ],
      );
      return cached ? [cache({ ttl: 600 }, () => [tree])] : [tree];
    },
  );
  return createRouter({}).routes(
    INCLUDED.has(shape)
      ? urls(({ include }) => [include("/", patterns, { name: "shop" })])
      : patterns,
  );
}

type Router = Parameters<typeof serveShellRequest>[0];

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

/** The intercept slots the answer carries: `<segment id> <slot>`. */
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

/** The intercept segment ids `matched` lists: what the client renders. */
function interceptIdsOf(answer: Answer): string[] {
  return answer.matched.filter((id) => id.includes(".@"));
}

/** How the client opened the intercept: nothing held, or the source page's segments held. */
type Held = "nothing held" | "layout held";

interface Acted {
  opened: Answer;
  openedFlight: string;
  acted: Answer;
  actedFlight: string;
  status: number;
  result: unknown;
  /** Intercept handler and loader runs of the action. */
  runs: Record<string, number>;
  loaderRuns: Record<string, number>;
}

/**
 * Open /item/1 from `source`, then call an action from the open intercept as
 * the browser sends it: the page's URL as client path, the held segment ids
 * and the intercept source.
 */
async function actFromOpenIntercept(
  router: Router,
  target: Target,
  source: string,
  held: Held,
  actionId: string,
): Promise<Acted> {
  const cacheStore = new MemorySegmentCacheStore();
  let segments: string[] = [];
  if (held === "layout held") {
    const page = await serveShellRequest(router, source, {
      cacheStore,
      partial: true,
    });
    segments = (await answerOf(page)).matched;
  }
  const openIt = () =>
    serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: source, segments },
    });
  // Over a Prerender() the first request bakes the variant.
  if (target === "prerender") await openIt();
  const openRes = await openIt();
  const opened = await answerOf(openRes);

  clearRuns();
  const actRes = await serveShellRequest(router, "/item/1", {
    cacheStore,
    headers: { "X-RSC-Router-Intercept-Source": source },
    action: { ref: touch, id: actionId, segments: opened.matched },
  });
  const action = await actRes.readAction();
  return {
    opened,
    openedFlight: openRes.flight!,
    acted: await answerOf(actRes),
    actedFlight: actRes.flight!,
    status: actRes.response.status,
    result: action?.result,
    runs: { ...runs },
    loaderRuns: { ...loaderRuns },
  };
}

/** Each shape, the source it opens from, the intercept open, and the others. */
const CASES: ReadonlyArray<{
  shape: Shape;
  source: string;
  open: string;
  others: string[];
}> = [
  {
    shape: "different slots",
    source: "/other",
    open: "drawer",
    others: ["modal"],
  },
  { shape: "same slot", source: "/other", open: "sheet", others: ["modal"] },
  {
    shape: "include names",
    source: "/other",
    open: "drawer",
    others: ["modal"],
  },
  // The page holds a slot id an intercept under the route's own name
  // matches, while the open one is under its local name, or shares that id.
  {
    shape: "same slot, split names",
    source: "/other",
    open: "sheet",
    others: ["modal"],
  },
  {
    shape: "parallel default, include names",
    source: "/other",
    open: "drawer",
    others: ["modal"],
  },
  {
    shape: "parallel default",
    source: "/other",
    open: "drawer",
    others: ["modal"],
  },
  // Controls: the first intercept declared is the open one, or the only one.
  {
    shape: "different slots",
    source: "/list",
    open: "modal",
    others: ["drawer"],
  },
  { shape: "same slot", source: "/list", open: "modal", others: ["sheet"] },
  {
    shape: "same slot, split names",
    source: "/list",
    open: "modal",
    others: ["sheet"],
  },
  {
    shape: "parallel default, include names",
    source: "/list",
    open: "modal",
    others: ["drawer"],
  },
  { shape: "single", source: "/other", open: "drawer", others: [] },
];

const HELD: readonly Held[] = ["nothing held", "layout held"];
const TARGETS: readonly Target[] = ["live", "prerender"];

describe("an action from an open intercept answers with that intercept", () => {
  beforeEach(async () => {
    await resetShellTestState();
    clearRuns();
  });

  let actionSeq = 0;

  for (const { shape, source, open, others } of CASES) {
    for (const target of TARGETS) {
      for (const cached of [false, true]) {
        for (const held of HELD) {
          const title = `${shape}, opened from ${source} (${open}), ${target} route${cached ? " under cache()" : ""}, ${held}`;
          it(title, async () => {
            const router = makeRouter(shape, cached, target);
            const r = await actFromOpenIntercept(
              router,
              target,
              source,
              held,
              `src/intercept.actions.ts#touch${++actionSeq}`,
            );

            // The intercept opened as expected.
            expect(slotsOf(r.opened)).toHaveLength(1);
            expect(r.openedFlight).toContain(`${open} body`);

            expect(r.status).toBe(200);
            expect(r.result).toBe("touched");
            // The client renders only the intercept segments it held, and
            // the answer carries no other intercept's slot.
            expect(interceptIdsOf(r.acted)).toEqual(interceptIdsOf(r.opened));
            expect(activeSlotsOf(r.acted)).toEqual(activeSlotsOf(r.opened));
            for (const slot of slotsOf(r.acted)) {
              expect(slotsOf(r.opened)).toContain(slot);
            }
            if (target === "live") {
              // A live render re-renders the open intercept's handler.
              expect(slotsOf(r.acted)).toEqual(slotsOf(r.opened));
              expect(r.actedFlight).toContain(`${open} body`);
            }
            // Its loader re-runs after the action; no other intercept runs.
            expect(r.loaderRuns[open]).toBe(1);
            for (const other of others) {
              expect(r.actedFlight).not.toContain(`${other} body`);
              expect(r.runs[other] ?? 0).toBe(0);
              expect(r.loaderRuns[other] ?? 0).toBe(0);
            }
          });
        }
      }
    }
  }
});
