/**
 * The walker's stop at a thrown action's error boundary (resolveAllSegments,
 * ActionContext.boundary). matchPartial runs the action's revalidation with
 * matchError's segment on the action context: the entries above the
 * segment's outlet resolve as on a success, the segment takes the outlet's
 * place with the outlet's loader ids still claimed, and nothing at or below
 * the outlet runs. An earlier action's follow-up (a stale partial that holds
 * nothing) names that boundary while the page shows it (`_rsc_boundary`): the
 * walk stops at the same place and sends no segment for it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

import { createRouter } from "../../../router.js";
import { createLoader } from "../../../loader.rsc.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import { runWithRequestContext } from "../../../server/request-context.js";
import { writePartialParams } from "../../../browser/wire-protocol.js";
import { idsAboveBoundary } from "../../../browser/segment-reconciler.js";
import { makeRequestContext } from "../../../__tests__/kit/request-context.js";
import type { MatchResult, ResolvedSegment } from "../../../types.js";

/** What ran in a match, in order. */
const ran: string[] = [];

const loaderOf = (id: string) =>
  (createLoader as Function)(
    async () => {
      ran.push(id);
      return id;
    },
    undefined,
    `cut#${id}`,
  );
const Cart = loaderOf("cart");
const Item = loaderOf("item");
const Section = loaderOf("section");
const Shelf = loaderOf("shelf");

const handler = (id: string) => () => {
  ran.push(id);
  return <p>{id}</p>;
};

let router: any;

beforeAll(async () => {
  router = createRouter({} as any);
  router.routes((h: any) => [
    h.layout(handler("shop"), () => [
      h.loader(Cart),
      h.parallel({ "@side": handler("side") }),
      h.path("/item", handler("item route"), { name: "item" }, () => [
        h.loader(Item),
        h.errorBoundary(<p>item failed</p>),
      ]),
      h.path("/plain", handler("plain route"), { name: "plain" }),
      h.layout(handler("section"), () => [
        h.loader(Section),
        h.errorBoundary(<p>section failed</p>),
        h.layout(handler("shelf"), () => [
          h.loader(Shelf),
          h.path("/shelf", handler("shelf route"), { name: "shelf" }),
          h.path("/shelf2", handler("shelf2 route"), { name: "shelf2" }),
        ]),
      ]),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function inRequest<T>(request: Request, fn: () => Promise<T>) {
  return runWithRequestContext(
    makeRequestContext({
      url: request.url,
      init: { method: request.method, headers: request.headers },
    }),
    fn,
  );
}

/** The ids the page at `pathname` holds, from its document match. */
async function held(pathname: string): Promise<string[]> {
  const request = new Request(`https://example.com${pathname}`);
  const page: MatchResult = await inRequest(request, () =>
    router.match(request, { env: {} }),
  );
  return page.matched;
}

/** An action from the page at `pathname` that threw: its boundary pass. */
async function boundaryPass(pathname: string): Promise<{
  result: MatchResult;
  boundary: ResolvedSegment;
  page: string[];
}> {
  const page = await held(pathname);
  const url = writePartialParams(new URL(`https://example.com${pathname}`), {
    action: "cut#fail",
    segmentIds: page,
    emptySegments: "send",
  });
  const action = () =>
    new Request(url, {
      method: "POST",
      headers: { "X-RSC-Router-Client-Path": `https://example.com${pathname}` },
    });
  const errorRequest = action();
  const error: MatchResult = await inRequest(errorRequest, () =>
    router.matchError(errorRequest, { env: {} }, new Error("out of stock")),
  );
  const boundary = error.segments[0]!;
  ran.length = 0;
  const request = action();
  const result: MatchResult = await inRequest(request, () =>
    router.matchPartial(
      request,
      { env: {} },
      { actionId: "cut#fail", boundary },
    ),
  );
  return { result, boundary, page };
}

const loaderId = (owner: string, index: number, id: string) =>
  `${owner}D${index}.cut#${id}`;

describe("a thrown action's boundary pass", () => {
  it("stops at the route that declares the boundary: the layout's loader re-runs, its slot stays held", async () => {
    const { result, boundary, page } = await boundaryPass("/item");
    expect(ran).toEqual(["cart"]);
    expect(result.segments.map((s) => [s.id, s.type])).toEqual([
      [page.find((id) => id.endsWith(".cut#cart")), "loader"],
      [boundary.id, "error"],
    ]);
    expect(result.segments[1]!.component).toBe(boundary.component);
    // Every id the page holds, the slot and the route's loader included.
    expect(new Set(result.matched)).toEqual(new Set(page));
    expect(result.resolvedIds).toContain(boundary.id);
    expect(result.routeName).toBe("item");
  });

  it("stops at a boundary layout's child: the loaders below it neither run nor leave the page", async () => {
    const { result, boundary, page } = await boundaryPass("/shelf");
    expect(ran).toEqual(["cart", "section"]);
    expect(result.segments.map((s) => s.type)).toEqual([
      "loader",
      "loader",
      "error",
    ]);
    // The error takes the shelf layout's place; its loader stays claimed,
    // the route under it leaves `matched`.
    const shelfLoader = page.find((id) => id.endsWith(".cut#shelf"))!;
    expect(shelfLoader).toBe(loaderId(boundary.id, 0, "shelf"));
    expect(result.matched).toContain(boundary.id);
    expect(result.matched).toContain(shelfLoader);
    expect(result.matched.at(-1)).toBe(shelfLoader);
  });
});

/** The follow-up of the page at `pathname`: it holds nothing but `boundary`. */
async function followUp(
  pathname: string,
  boundary: string,
): Promise<MatchResult> {
  const url = writePartialParams(new URL(`https://example.com${pathname}`), {
    segmentIds: [],
    emptySegments: "send",
    stale: true,
    boundary,
  });
  const request = new Request(url, {
    headers: { "X-RSC-Router-Client-Path": `https://example.com${pathname}` },
  });
  ran.length = 0;
  return inRequest(request, () => router.matchPartial(request, { env: {} }));
}

describe("a follow-up that holds an action's boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders every entry above the boundary, claims it and its loaders, and stops", async () => {
    const { boundary, page } = await boundaryPass("/shelf");
    const result = await followUp("/shelf", boundary.id);
    // Held nothing: every entry above renders, the slot included.
    expect(ran).toEqual(
      expect.arrayContaining(["shop", "cart", "side", "section"]),
    );
    // Nothing at or below the boundary: the shelf layout, loader and route.
    expect(ran.filter((id) => id.startsWith("shelf"))).toEqual([]);
    expect(result.segments.map((s) => s.id)).not.toContain(boundary.id);
    expect(result.resolvedIds).not.toContain(boundary.id);
    const shelfLoader = loaderId(boundary.id, 0, "shelf");
    expect(result.matched.slice(-2)).toEqual([boundary.id, shelfLoader]);
    expect(page).toEqual(expect.arrayContaining(result.matched));
  });

  it("at a route's boundary, runs no route code", async () => {
    const { boundary } = await boundaryPass("/item");
    const result = await followUp("/item", boundary.id);
    expect(ran).toEqual(expect.arrayContaining(["shop", "cart", "side"]));
    expect(ran).not.toContain("item route");
    expect(ran).not.toContain("item");
    expect(result.matched.slice(-2)).toEqual([
      boundary.id,
      loaderId(boundary.id, 0, "item"),
    ]);
  });

  it("an id that matches no entry of the route's chain renders the page whole and warns in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await followUp("/item", "M9L9R9");
    expect(ran).toEqual(
      expect.arrayContaining(["shop", "cart", "item route", "item"]),
    );
    expect(result.segments.map((s) => s.type)).toContain("route");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('held the error boundary "M9L9R9"'),
    );
  });
});

/** A link from `from` to `to` while the client holds `held`. */
async function link(
  from: string,
  to: string,
  held: string[],
): Promise<MatchResult> {
  const url = writePartialParams(new URL(`https://example.com${to}`), {
    segmentIds: held,
    emptySegments: "send",
  });
  const request = new Request(url, {
    headers: { "X-RSC-Router-Client-Path": `https://example.com${from}` },
  });
  ran.length = 0;
  return inRequest(request, () => router.matchPartial(request, { env: {} }));
}

/** Whether `result` sent the loader `id` of the entry `owner`. */
const sent = (result: MatchResult, owner: string, id: string) =>
  result.segments.some((s) => s.id === loaderId(owner, 0, id));

describe("the next link after an action's boundary, with the ids the client then holds (idsAboveBoundary)", () => {
  it("a route's boundary: a link to the page re-runs the route and its loader", async () => {
    const { boundary, page } = await boundaryPass("/item");
    const result = await link(
      "/item",
      "/item",
      idsAboveBoundary(page, boundary.id),
    );
    expect(ran).toEqual(expect.arrayContaining(["item route", "item"]));
    expect(sent(result, boundary.id, "item")).toBe(true);
  });

  it("the router's default boundary at the root: a link re-runs the layout's loader read before the write", async () => {
    const { boundary, page } = await boundaryPass("/plain");
    const held = idsAboveBoundary(page, boundary.id);
    expect(held).toEqual([]);
    const result = await link("/plain", "/item", held);
    const cart = page.find((id) => id.endsWith(".cut#cart"))!;
    expect(result.segments.map((s) => s.id)).toContain(cart);
  });

  it("after the follow-up held a layout's boundary: a link to a sibling route under it re-runs that layout's loader", async () => {
    const { boundary } = await boundaryPass("/shelf");
    const fu = await followUp("/shelf", boundary.id);
    const result = await link(
      "/shelf",
      "/shelf2",
      idsAboveBoundary(fu.matched, boundary.id),
    );
    expect(sent(result, boundary.id, "shelf")).toBe(true);
    expect(ran).toContain("shelf2 route");
  });
});
