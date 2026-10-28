/**
 * An action that throws into an errorBoundary() gets the action's own
 * revalidation cut at the boundary, through serveShellRequest. Above the
 * boundary the response is what a successful action would send: every loader
 * the page holds, as its revalidate() decides, and every slot the page holds.
 * At the boundary's outlet it carries the error segment, and nothing at or
 * below the outlet runs. So a layout loader that reads the action's write (a
 * cart count) shows it beside the boundary.
 *
 * A redirect thrown in that revalidation redirects, as on a success. An
 * action sent from an intercept, and one whose revalidation returns null or
 * throws anything else, gets the error segment alone (matchError,
 * router/match-api.ts).
 *
 * An earlier action's follow-up, owed to the page that shows the boundary,
 * holds it (`partial.boundary` beside `stale`): it re-renders every segment
 * above the boundary, as a request that holds nothing does, and nothing at
 * or below it. The boundary stays on screen, and the layout above shows the
 * earlier write.
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
  createHandle,
  createLoader,
  createRouter,
  redirect,
  urls,
  type HandlerContext,
  type RevalidateParams,
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import {
  filterSegmentOrder,
  loaderParentId,
} from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());
/** Pushed by the cart loader. */
const Badge = createHandle<string, string[]>((segments) => segments.flat());

type Rule = (args: RevalidateParams) => boolean;
const DEFAULT_RULE: Rule = (args) => args.defaultShouldRevalidate;
const NO_RUNS = {
  product: 0,
  productLoader: 0,
  shelfLayout: 0,
  shelfLoader: 0,
  deal: 0,
  dealLoader: 0,
};

let cart = 0;
let cartRuns = 0;
let ratesFail = false;
/** The cart loader's revalidate(): the default unless a case replaces it. */
let cartRule = DEFAULT_RULE;
/** The section loader's, likewise. */
let sectionRule = DEFAULT_RULE;
/** Runs of what sits at or below a boundary's outlet. */
const runs = { ...NO_RUNS };
const errors: Array<[string, string]> = [];

const CartLoader = createLoader(async (ctx) => {
  cartRuns++;
  ctx.use(Badge)(`cart:${cart}`);
  return cart;
});
const RatesLoader = createLoader(async () => {
  if (ratesFail) throw new Error("rates unavailable");
  return "rates";
});
const ProductLoader = createLoader(async (ctx) => {
  runs.productLoader++;
  ctx.use(Badge)(`product:${runs.productLoader}`);
  return "product data";
});
const SectionLoader = createLoader(async () => `section:${cart}`);
const ShelfLoader = createLoader(async () => {
  runs.shelfLoader++;
  return "shelf data";
});
const PromoLoader = createLoader(async () => `promo:${cart}`);
const DealLoader = createLoader(async () => {
  runs.dealLoader++;
  return "deal data";
});

/** The request's action id, as a production build hashes it. */
const ADD_THEN_FAIL = "a1b2c3#addThenFail";
/** The action writes the cart, then throws. */
async function addThenFail(): Promise<never> {
  cart++;
  throw new Error("out of stock");
}
// A production build's file-path id ($id, expose-action-id), which
// isAction(ref) resolves.
Object.assign(addThenFail, { $id: "src/shop.actions.ts#addThenFail" });
/** The action writes the cart. */
async function add(): Promise<number> {
  return ++cart;
}

const router = createRouter({
  onError: ({ phase, error }) => {
    errors.push([
      phase,
      error instanceof Error ? error.message : String(error),
    ]);
  },
}).routes(
  urls(({ layout, path, loader, parallel, errorBoundary, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("shop");
        return <main>shop</main>;
      },
      () => [
        loader(CartLoader, () => [revalidate((args) => cartRule(args))]),
        loader(RatesLoader),
        parallel({
          "@aside": (ctx: HandlerContext) => {
            ctx.use(Crumbs)("aside");
            return <aside>aside</aside>;
          },
        }),
        path(
          "/product/:id",
          (ctx: HandlerContext<{ id: string }>) => {
            runs.product++;
            ctx.use(Crumbs)("product");
            return <p>product</p>;
          },
          { name: "product" },
          () => [loader(ProductLoader), errorBoundary(<p>product failed</p>)],
        ),
        // No boundary on its chain: the router's default one at the root.
        path("/plain", () => <p>plain</p>, { name: "plain" }),
        layout(
          () => <section>section</section>,
          () => [
            loader(SectionLoader, () => [
              revalidate((args) => sectionRule(args)),
            ]),
            errorBoundary(<p>section failed</p>),
            layout(
              () => {
                runs.shelfLayout++;
                return <div>shelf layout</div>;
              },
              () => [
                loader(ShelfLoader),
                path("/shelf", () => <p>shelf</p>, { name: "shelf" }),
              ],
            ),
          ],
        ),
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("deals");
            return <div>deals</div>;
          },
          () => [
            // Routeless, so an orphan layout: its boundary covers the
            // routes of the layout that declares it.
            layout(
              (ctx: HandlerContext) => {
                ctx.use(Crumbs)("promo");
                return <nav>promo</nav>;
              },
              () => [
                loader(PromoLoader),
                parallel({
                  "@banner": (ctx: HandlerContext) => {
                    ctx.use(Crumbs)("banner");
                    return <aside>banner</aside>;
                  },
                }),
                errorBoundary(<p>deals failed</p>),
              ],
            ),
            path(
              "/deal",
              (ctx: HandlerContext) => {
                runs.deal++;
                ctx.use(Crumbs)("deal");
                return <p>deal</p>;
              },
              { name: "deal" },
              () => [loader(DealLoader)],
            ),
          ],
        ),
      ],
    ),
  ]),
);

interface Segment {
  id: string;
  type: string;
  loaderId?: string;
  loaderData?: unknown;
}

interface Answer {
  segments: Segment[];
  matched: string[];
  diff: string[];
  resolvedIds: string[];
  isError?: boolean;
  handles?: AsyncIterable<HandleData>;
}

/** A response's metadata and the last handle state it streamed. */
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

/** The segment ids of the error segments a response sent. */
function errorIds(answer: Answer): string[] {
  return answer.segments.filter((s) => s.type === "error").map((s) => s.id);
}

/** The page `url` as a document: what it holds and its handle values. */
async function documentOf(url: string): Promise<{
  matched: string[];
  segments: Segment[];
  handles: HandleData;
}> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
  return { matched: answer.matched, segments: answer.segments, handles };
}

/** The page's `addThenFail` call. */
function throwOn(
  url: string,
  page: { matched: string[] },
  options: ServeShellRequestOptions = {},
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    action: { ref: addThenFail, id: ADD_THEN_FAIL, segments: page.matched },
    ...options,
  });
}

/** The id of the page's one segment that `match` picks. */
function idOf(
  page: { segments: Segment[] },
  match: (segment: Segment) => boolean,
): string {
  const found = page.segments.filter(match);
  expect(found).toHaveLength(1);
  return found[0]!.id;
}

const FROM_INTERCEPT = {
  headers: { "X-RSC-Router-Intercept-Source": "http://localhost/plain" },
};

beforeEach(async () => {
  cart = 0;
  cartRuns = 0;
  ratesFail = false;
  cartRule = DEFAULT_RULE;
  sectionRule = DEFAULT_RULE;
  Object.assign(runs, NO_RUNS);
  errors.length = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("an action that throws into an errorBoundary()", () => {
  it("an action that throws under its route's errorBoundary() answers the boundary and the layout loader's write", async () => {
    const page = await documentOf("/product/1");
    const before = { ...runs };
    const result = await throwOn("/product/1", page);

    expect(result.response.status).toBe(500);
    const { answer } = await readAnswer(result);
    expect(answer.isError).toBe(true);
    expect(result.flight).toContain("product failed");
    expect(errorIds(answer)).toEqual([idOf(page, (s) => s.type === "route")]);
    // Above the boundary: the layout's loaders, re-run as on a success.
    expect(await sent(answer, CartLoader)).toBe(1);
    expect(await sent(answer, RatesLoader)).toBe("rates");
    // At the boundary: the route's handler and loader did not run.
    expect(await sent(answer, ProductLoader)).toBeUndefined();
    expect(runs).toEqual(before);
    expect(errors).toEqual([["action", "out of stock"]]);
    // The call rejects with the action's error, as Flight sends it.
    expect(await result.readAction()).toMatchObject({
      ok: false,
      result: expect.any(Error),
    });
  });

  it("a layout loader's revalidate() decides in the boundary response as on a success", async () => {
    const seen: unknown[] = [];
    cartRule = (args) => {
      seen.push({
        isAction: args.isAction(addThenFail),
        actionId: args.actionId,
        actionResult: (args.actionResult as Error).message,
      });
      return false;
    };
    const page = await documentOf("/product/1");
    const { answer } = await readAnswer(await throwOn("/product/1", page));

    expect(seen).toEqual([
      {
        isAction: true,
        actionId: "src/shop.actions.ts#addThenFail",
        actionResult: "out of stock",
      },
    ]);
    // Kept out by its rule, still held; its sibling re-ran.
    expect(await sent(answer, CartLoader)).toBeUndefined();
    expect(answer.matched).toContain(
      idOf(page, (s) => s.loaderId === CartLoader.$$id),
    );
    expect(await sent(answer, RatesLoader)).toBe("rates");
  });

  it("the boundary response lists the slots the page holds, and a handle value a slot pushed stays", async () => {
    const page = await documentOf("/product/1");
    const slot = page.matched.find((id) => id.endsWith(".@aside"));
    expect(slot).toBeDefined();
    expect(
      collectHandleData(Crumbs, page.handles, filterSegmentOrder(page.matched)),
    ).toEqual(["shop", "aside", "product"]);

    const { answer, handles } = await readAnswer(
      await throwOn("/product/1", page),
    );
    expect(answer.matched).toContain(slot);
    // Merged as the browser merges a partial response's handle data.
    const order = filterSegmentOrder(answer.matched);
    const merged = mergePartialHandleData(
      page.handles,
      handles,
      order,
      answer.matched,
      answer.resolvedIds,
    );
    expect(collectHandleData(Crumbs, merged, order)).toEqual(["shop", "aside"]);
  });

  it("with no declared boundary the response is the default error boundary alone, as before", async () => {
    const page = await documentOf("/plain");
    const result = await throwOn("/plain", page);
    expect(result.response.status).toBe(500);
    const { answer } = await readAnswer(result);
    // The root entry's outlet: nothing above it runs.
    expect(answer.segments.map((s) => s.type)).toEqual(["error"]);
    expect(await sent(answer, CartLoader)).toBeUndefined();

    // The response the router sent before (the error segment alone), which
    // an action from an intercept still gets.
    const before = await readAnswer(
      await throwOn("/plain", page, FROM_INTERCEPT),
    );
    expect(answer.segments.map((s) => s.id)).toEqual(
      before.answer.segments.map((s) => s.id),
    );
    expect({
      matched: answer.matched,
      diff: answer.diff,
      resolvedIds: answer.resolvedIds,
    }).toEqual({
      matched: before.answer.matched,
      diff: before.answer.diff,
      resolvedIds: before.answer.resolvedIds,
    });
  });

  it("a layout's errorBoundary() cuts at its child: the loaders above it re-run, the ones below do not", async () => {
    const page = await documentOf("/shelf");
    const before = { ...runs };
    const result = await throwOn("/shelf", page);

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("section failed");
    const { answer } = await readAnswer(result);
    const shelfLoader = idOf(page, (s) => s.loaderId === ShelfLoader.$$id);
    const shelfLayout = loaderParentId(shelfLoader);
    // The error takes the shelf layout's place; its loader stays claimed.
    expect(errorIds(answer)).toEqual([shelfLayout]);
    expect(answer.matched).toContain(shelfLoader);
    expect(answer.matched).not.toContain(idOf(page, (s) => s.type === "route"));
    expect(await sent(answer, CartLoader)).toBe(1);
    expect(await sent(answer, SectionLoader)).toBe("section:1");
    expect(await sent(answer, ShelfLoader)).toBeUndefined();
    expect(runs).toEqual(before);
  });

  it("a loader above the boundary that throws reports as a loader, and the action's error reports once", async () => {
    const page = await documentOf("/product/1");
    ratesFail = true;
    const result = await throwOn("/product/1", page);

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("product failed");
    const { answer } = await readAnswer(result);
    expect(await sent(answer, CartLoader)).toBe(1);
    expect(errors).toEqual([
      ["action", "out of stock"],
      ["loader", "rates unavailable"],
    ]);
    expect(await result.readAction()).toEqual({
      ok: false,
      result: expect.any(Error),
      revalidationError: null,
    });
  });

  it("an orphan layout's errorBoundary() cuts at its owner's child: the orphan and its slot stay, and no route code runs", async () => {
    const page = await documentOf("/deal");
    const before = { ...runs };
    const result = await throwOn("/deal", page);

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("deals failed");
    const { answer, handles } = await readAnswer(result);
    // The error takes the route's place: the chain child of the layout that
    // declares the orphan.
    expect(errorIds(answer)).toEqual([idOf(page, (s) => s.type === "route")]);
    const orphan = loaderParentId(
      idOf(page, (s) => s.loaderId === PromoLoader.$$id),
    );
    expect(answer.matched).toEqual(
      expect.arrayContaining([orphan, `${orphan}.@banner`]),
    );
    expect(await sent(answer, PromoLoader)).toBe("promo:1");
    expect(await sent(answer, CartLoader)).toBe(1);
    expect(await sent(answer, DealLoader)).toBeUndefined();
    expect(runs).toEqual(before);
    // The chain's handle values stay; the route's go with it.
    expect(
      collectHandleData(Crumbs, page.handles, filterSegmentOrder(page.matched)),
    ).toEqual(["shop", "aside", "deals", "promo", "banner", "deal"]);
    const order = filterSegmentOrder(answer.matched);
    const merged = mergePartialHandleData(
      page.handles,
      handles,
      order,
      answer.matched,
      answer.resolvedIds,
    );
    expect(collectHandleData(Crumbs, merged, order)).toEqual([
      "shop",
      "aside",
      "deals",
      "promo",
      "banner",
    ]);
  });
});

describe("a redirect thrown in a thrown action's revalidation", () => {
  it("redirects, as from a successful action's revalidation", async () => {
    cartRule = () => {
      throw redirect("/plain");
    };
    const page = await documentOf("/product/1");
    const succeeded = await serveShellRequest(router, "/product/1", {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: add, id: "a1b2c3#add", segments: page.matched },
    });
    const result = await throwOn("/product/1", page);

    const target = "http://localhost/plain";
    expect(succeeded.response.headers.get("X-RSC-Redirect")).toBe(target);
    expect(result.response.headers.get("X-RSC-Redirect")).toBe(target);
    expect(result.response.status).toBe(succeeded.response.status);
    expect(result.flight).toBeUndefined();
  });
});

describe("a thrown action that keeps the error segment alone", () => {
  it("an action sent from an intercept", async () => {
    const page = await documentOf("/product/1");
    const result = await throwOn("/product/1", page, FROM_INTERCEPT);

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("product failed");
    const { answer } = await readAnswer(result);
    expect(answer.segments.map((s) => s.type)).toEqual(["error"]);
    expect(await sent(answer, CartLoader)).toBeUndefined();
  });

  it("an action whose revalidation returns null: matchError's response, without a warning", async () => {
    // The rsc project runs as production; the warning is development-only.
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = await documentOf("/product/1");
    const before = await readAnswer(
      await throwOn("/product/1", page, FROM_INTERCEPT),
    );
    // No previous URL the revalidation can diff against.
    const result = await throwOn("/product/1", page, {
      headers: { "X-RSC-Router-Client-Path": "http://[" },
    });

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("product failed");
    const { answer } = await readAnswer(result);
    const shape = ({ segments, matched, diff, resolvedIds }: Answer) => ({
      segments: segments.map((s) => [s.id, s.type]),
      matched,
      diff,
      resolvedIds,
    });
    expect(shape(answer)).toEqual(shape(before.answer));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("revalidation");
  });

  it("an action whose revalidation throws a Response that is not a redirect, after a loader above the boundary ran: no push of that loader, and a warning", async () => {
    // The rsc project runs as production; the warning is development-only.
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Evaluated after the cart loader above it ran.
    sectionRule = () => {
      throw new Response(null, { status: 403 });
    };
    const page = await documentOf("/shelf");
    const runsBefore = cartRuns;
    const result = await throwOn("/shelf", page);

    expect(result.response.status).toBe(500);
    expect(result.flight).toContain("section failed");
    const { answer, handles } = await readAnswer(result);
    expect(answer.segments.map((s) => s.type)).toEqual(["error"]);
    expect(cartRuns).toBe(runsBefore + 1);
    expect(handles).toEqual({});
    expect(errors).toEqual([["action", "out of stock"]]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("whose revalidation threw a 403 Response"),
    );
  });
});

/**
 * The follow-up an earlier action owes the page at `url` while it shows a
 * thrown action's boundary: a stale partial that holds nothing but the
 * boundary.
 */
function followUpHolding(
  url: string,
  boundary: string,
  partial: { stale?: boolean } = { stale: true },
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from: url, segments: [], boundary, ...partial },
  });
}

describe("an earlier action's follow-up while a thrown action's boundary is on screen", () => {
  /** The page at `url` after `addThenFail` threw: its boundary's id. */
  async function boundaryOn(url: string): Promise<string> {
    const { answer } = await readAnswer(
      await throwOn(url, await documentOf(url)),
    );
    const [id] = errorIds(answer);
    expect(id).toBeDefined();
    return id!;
  }

  it("a stale partial that names the error boundary on screen re-renders the layout loader, holds the boundary and runs no route code", async () => {
    const boundary = await boundaryOn("/product/1");
    // An earlier action's write, which the boundary's response did not read.
    cart = 7;
    const before = { ...runs };
    const runsBefore = cartRuns;
    const result = await followUpHolding("/product/1", boundary);

    expect(result.response.status).toBe(200);
    const { answer, handles } = await readAnswer(result);
    expect(cartRuns).toBe(runsBefore + 1);
    expect(await sent(answer, CartLoader)).toBe(7);
    expect(runs).toEqual(before);
    expect(result.flight).not.toContain("product failed");
    // The boundary and the route's loader stay claimed, and are not sent.
    const productLoader = `${boundary}D0.${ProductLoader.$$id}`;
    expect(answer.matched.slice(-2)).toEqual([boundary, productLoader]);
    expect(answer.segments.map((s) => s.id)).not.toContain(boundary);
    expect(answer.resolvedIds).not.toContain(boundary);
    // The slot above the boundary re-renders, and pushes its handle values.
    expect(answer.matched.some((id) => id.endsWith(".@aside"))).toBe(true);
    expect(
      collectHandleData(Badge, handles, filterSegmentOrder(answer.matched)),
    ).toEqual(["cart:7"]);
  });

  it("a layout's boundary: the loaders above it re-run, the ones below do not", async () => {
    const boundary = await boundaryOn("/shelf");
    cart = 7;
    const before = { ...runs };
    const { answer } = await readAnswer(
      await followUpHolding("/shelf", boundary),
    );

    expect(await sent(answer, CartLoader)).toBe(7);
    expect(await sent(answer, SectionLoader)).toBe("section:7");
    expect(await sent(answer, ShelfLoader)).toBeUndefined();
    expect(runs).toEqual(before);
    const shelfLoader = `${boundary}D0.${ShelfLoader.$$id}`;
    expect(answer.matched.slice(-2)).toEqual([boundary, shelfLoader]);
  });

  it("an orphan layout's boundary: the orphan and its slot re-render, and no route code runs", async () => {
    const boundary = await boundaryOn("/deal");
    cart = 7;
    const before = { ...runs };
    const { answer } = await readAnswer(
      await followUpHolding("/deal", boundary),
    );

    expect(await sent(answer, PromoLoader)).toBe("promo:7");
    expect(await sent(answer, CartLoader)).toBe(7);
    expect(await sent(answer, DealLoader)).toBeUndefined();
    expect(runs).toEqual(before);
    expect(answer.matched.some((id) => id.endsWith(".@banner"))).toBe(true);
    expect(answer.matched.at(-2)).toBe(boundary);
    expect(answer.segments.map((s) => s.id)).not.toContain(boundary);
  });

  it("the handle values at the boundary stay through the follow-up (no route loader re-ran), and the ones above it take the write", async () => {
    const page = await documentOf("/product/1");
    const thrown = await readAnswer(await throwOn("/product/1", page));
    const [boundary] = errorIds(thrown.answer);
    // Merged as the browser merges each partial response's handle data.
    const merge = (
      previous: HandleData,
      next: { answer: Answer; handles: HandleData },
    ) =>
      mergePartialHandleData(
        previous,
        next.handles,
        filterSegmentOrder(next.answer.matched),
        next.answer.matched,
        next.answer.resolvedIds,
      );
    const afterBoundary = merge(page.handles, thrown);
    expect(
      collectHandleData(
        Badge,
        afterBoundary,
        filterSegmentOrder(thrown.answer.matched),
      ),
    ).toEqual(["cart:1", "product:1"]);

    cart = 7;
    const followUp = await readAnswer(
      await followUpHolding("/product/1", boundary!),
    );
    expect(
      collectHandleData(
        Badge,
        merge(afterBoundary, followUp),
        filterSegmentOrder(followUp.answer.matched),
      ),
    ).toEqual(["cart:7", "product:1"]);
  });

  it("a layout loader whose revalidate() returns false re-runs: the request holds nothing above the boundary", async () => {
    const boundary = await boundaryOn("/product/1");
    cartRule = () => false;
    cart = 7;
    const { answer } = await readAnswer(
      await followUpHolding("/product/1", boundary),
    );
    expect(await sent(answer, CartLoader)).toBe(7);
  });

  it("without stale, the boundary is not read: the page renders whole", async () => {
    const boundary = await boundaryOn("/product/1");
    const before = runs.product;
    const result = await followUpHolding("/product/1", boundary, {
      stale: false,
    });
    const { answer } = await readAnswer(result);
    expect(runs.product).toBe(before + 1);
    expect(answer.segments.map((s) => s.id)).toContain(boundary);
  });
});
