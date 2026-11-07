/**
 * An action that throws inside an open intercept gets the action's own
 * revalidation, with the intercept's slot showing the error boundary. The
 * boundary is the one an intercept handler's throw renders on a navigation:
 * the nearest errorBoundary() from the layout that declares the intercept,
 * else the router's default. Above the slot the response is what a
 * successful action from the intercept sends: every loader the page under
 * the intercept holds re-runs as its revalidate() decides, so a layout
 * loader that reads the action's write (a cart count) shows it beside the
 * boundary. In the slot, the intercept's handler and loaders do not run; its
 * layout() still wraps the boundary, as it wraps a handler's throw.
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
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
  type RevalidateParams,
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

type Rule = (args: RevalidateParams) => boolean;
const DEFAULT_RULE: Rule = (args) => args.defaultShouldRevalidate;
const NO_RUNS = { list: 0, item: 0, modal: 0, modalLoader: 0 };

let cart = 0;
let cartRule = DEFAULT_RULE;
/** Runs of the page under the intercept and of the intercept itself. */
const runs = { ...NO_RUNS };
const errors: Array<[string, string]> = [];

const CartLoader = createLoader(async () => cart);
const ModalLoader = createLoader(async () => {
  runs.modalLoader++;
  return "modal data";
});

/** The action writes the cart, then throws. */
async function addThenFail(): Promise<never> {
  cart++;
  throw new Error("out of stock");
}
Object.assign(addThenFail, { $id: "src/shop.actions.ts#addThenFail" });
/** The action writes the cart. */
async function add(): Promise<number> {
  return ++cart;
}

/**
 * `/shop`: a layout with a cart loader and an errorBoundary(), which
 * declares an `@modal` intercept of its item route (with a loader, a
 * layout() and a handle push); the item route has a boundary of its own.
 * `/bare`: the same intercept under a layout with no boundary on its chain.
 */
const router = createRouter({
  onError: ({ phase, error }) => {
    errors.push([
      phase,
      error instanceof Error ? error.message : String(error),
    ]);
  },
}).routes(
  urls(({ layout, path, loader, intercept, errorBoundary, revalidate }) => {
    const shop = (prefix: string, withBoundary: boolean) =>
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("shop");
          return <main>shop layout</main>;
        },
        () => [
          loader(CartLoader, () => [revalidate((args) => cartRule(args))]),
          ...(withBoundary ? [errorBoundary(<p>shop failed</p>)] : []),
          path(
            `${prefix}/list`,
            () => {
              runs.list++;
              return <ul>list page</ul>;
            },
            { name: `${prefix.slice(1)}List` },
          ),
          path(
            `${prefix}/item`,
            () => {
              runs.item++;
              return <article>item page</article>;
            },
            { name: `${prefix.slice(1)}Item` },
            () => [errorBoundary(<p>item failed</p>)],
          ),
          intercept(
            "@modal",
            `.${prefix.slice(1)}Item`,
            (ctx: HandlerContext) => {
              runs.modal++;
              ctx.use(Crumbs)("modal");
              return <dialog>modal body</dialog>;
            },
            () => [loader(ModalLoader), layout(<section>modal frame</section>)],
          ),
        ],
      );
    return [shop("/shop", true), shop("/bare", false)];
  }),
);

interface Segment {
  id: string;
  type: string;
  slot?: string;
  namespace?: string;
  loaderId?: string;
  loaderData?: unknown;
  error?: { message: string; segmentId: string; segmentType: string };
}

interface Answer {
  segments: Segment[];
  matched: string[];
  diff: string[];
  resolvedIds: string[];
  isError?: boolean;
  handles?: AsyncIterable<HandleData>;
}

async function readAnswer(
  result: ServeShellRequestResult,
): Promise<{ answer: Answer; handles: HandleData }> {
  const { metadata } = await deserializeResult<{ metadata: Answer }>(
    result.flight!,
  );
  let handles: HandleData = {};
  for await (const data of metadata.handles ?? []) handles = data;
  return { answer: metadata, handles };
}

/** The data a response sent for `loader`, or undefined when not sent. */
async function sent(
  answer: Answer,
  loader: { $$id: string },
): Promise<unknown> {
  const segment = answer.segments.find((s) => s.loaderId === loader.$$id);
  if (!segment) return undefined;
  const result = (await segment.loaderData) as { ok: boolean; data: unknown };
  expect(result.ok).toBe(true);
  return result.data;
}

/** The intercept slots a response sent: `<id> <type>`. */
function slotsOf(answer: Answer): string[] {
  return answer.segments
    .filter((s) => s.namespace?.startsWith("intercept:") && s.slot)
    .map((s) => `${s.id} ${s.type}`);
}

/**
 * The list page as a document, then the item opened over it as an
 * intercept: what the browser holds, and its handle values.
 */
async function openIntercept(prefix: string): Promise<{
  matched: string[];
  handles: HandleData;
  slot: string;
}> {
  const cacheStore = new MemorySegmentCacheStore();
  const list = await readAnswer(
    await serveShellRequest(router, `${prefix}/list`, { cacheStore }),
  );
  const opened = await readAnswer(
    await serveShellRequest(router, `${prefix}/item`, {
      cacheStore,
      partial: { from: `${prefix}/list`, segments: list.answer.matched },
    }),
  );
  const slot = opened.answer.matched.find((id) => id.endsWith(".@modal"));
  expect(slot).toBeDefined();
  Object.assign(runs, NO_RUNS);
  return {
    matched: opened.answer.matched,
    handles: mergePartialHandleData(
      list.handles,
      opened.handles,
      filterSegmentOrder(opened.answer.matched),
      opened.answer.matched,
      opened.answer.resolvedIds,
    ),
    slot: slot!,
  };
}

/** `ref` called from the open intercept, as the browser sends it. */
function actFrom(
  prefix: string,
  page: { matched: string[] },
  ref: (...args: any[]) => Promise<unknown> = addThenFail,
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, `${prefix}/item`, {
    cacheStore: new MemorySegmentCacheStore(),
    headers: {
      "X-RSC-Router-Intercept-Source": `http://localhost${prefix}/list`,
    },
    action: {
      ref,
      id: ref === add ? "a1b2c3#add" : "a1b2c3#addThenFail",
      segments: page.matched,
    },
  });
}

beforeEach(async () => {
  cart = 0;
  cartRule = DEFAULT_RULE;
  Object.assign(runs, NO_RUNS);
  errors.length = 0;
  await resetShellTestState();
});

describe("an action that throws inside an open intercept", () => {
  it("answers the boundary in the intercept's slot and the layout loader's write, with the page under it kept", async () => {
    const page = await openIntercept("/shop");
    const result = await actFrom("/shop", page);

    expect(result.response.status).toBe(500);
    const { answer } = await readAnswer(result);
    expect(answer.isError).toBe(true);
    // The slot, as a parallel segment the browser renders in the modal's
    // outlet, with the boundary of the layout that declares the intercept.
    expect(slotsOf(answer)).toEqual([`${page.slot} parallel`]);
    expect(answer.segments.filter((s) => s.type === "error")).toEqual([]);
    // The error names the slot, as a throw in the intercept's handler does.
    expect(answer.segments.find((s) => s.id === page.slot)?.error).toEqual(
      expect.objectContaining({
        message: "An error occurred",
        segmentId: page.slot,
        segmentType: "parallel",
      }),
    );
    expect(result.flight).toContain("shop failed");
    expect(result.flight).not.toContain("item failed");
    expect(result.flight).not.toContain("modal body");
    // The intercept's layout() wraps it, as it wraps a handler's throw.
    expect(result.flight).toContain("modal frame");
    // Above the slot: the layout's loader, re-run as on a success.
    expect(await sent(answer, CartLoader)).toBe(1);
    // In the slot: neither the intercept's handler nor its loader ran. The
    // page under the intercept did not render, and stays held.
    expect(await sent(answer, ModalLoader)).toBeUndefined();
    expect(runs).toEqual(NO_RUNS);
    expect(answer.matched).toEqual(page.matched);
    expect(errors).toEqual([["action", "out of stock"]]);
    expect(await result.readAction()).toMatchObject({
      ok: false,
      result: expect.any(Error),
    });
  });

  it("a layout loader's revalidate() decides as on a successful action from the intercept", async () => {
    const page = await openIntercept("/shop");
    const seen: boolean[] = [];
    cartRule = (args) => {
      seen.push(args.isAction(addThenFail));
      return false;
    };
    const { answer } = await readAnswer(await actFrom("/shop", page));
    expect(seen).toEqual([true]);
    expect(await sent(answer, CartLoader)).toBeUndefined();
    expect(slotsOf(answer)).toEqual([`${page.slot} parallel`]);
  });

  it("the intercept's handle values go with it; the layout's stay", async () => {
    const page = await openIntercept("/shop");
    const order = filterSegmentOrder(page.matched);
    expect(collectHandleData(Crumbs, page.handles, order)).toEqual([
      "shop",
      "modal",
    ]);

    const { answer, handles } = await readAnswer(await actFrom("/shop", page));
    expect(answer.resolvedIds).toContain(page.slot);
    const merged = mergePartialHandleData(
      page.handles,
      handles,
      filterSegmentOrder(answer.matched),
      answer.matched,
      answer.resolvedIds,
    );
    expect(
      collectHandleData(Crumbs, merged, filterSegmentOrder(answer.matched)),
    ).toEqual(["shop"]);
  });

  it("with no declared boundary, the router's default error boundary fills the slot and the loaders above re-run", async () => {
    const page = await openIntercept("/bare");
    const result = await actFrom("/bare", page);

    expect(result.response.status).toBe(500);
    const { answer } = await readAnswer(result);
    expect(answer.isError).toBe(true);
    expect(slotsOf(answer)).toEqual([`${page.slot} parallel`]);
    expect(answer.segments.filter((s) => s.type === "error")).toEqual([]);
    expect(await sent(answer, CartLoader)).toBe(1);
    expect(runs).toEqual(NO_RUNS);
    expect(answer.matched).toEqual(page.matched);
  });

  it("control: a successful action from the intercept re-renders the intercept and the layout loader", async () => {
    const page = await openIntercept("/shop");
    const result = await actFrom("/shop", page, add);

    expect(result.response.status).toBe(200);
    const { answer } = await readAnswer(result);
    expect(answer.isError).toBeUndefined();
    expect(result.flight).toContain("modal body");
    expect(await sent(answer, CartLoader)).toBe(1);
    expect(await sent(answer, ModalLoader)).toBe("modal data");
    expect(runs).toEqual({ ...NO_RUNS, modal: 1, modalLoader: 1 });
  });
});
