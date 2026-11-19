/**
 * The Cache-Control of a partial nothing may reuse: a prefetch scoped to its
 * source page, a prefetch that defers work (`prefetch: false`), the fill that
 * follows it, and a stale partial. Each is sent `private, no-cache` unless the
 * route already set `no-store`, which it keeps: a signed-in page that is never
 * stored stays never stored. A middleware that writes the header after
 * `next()` still has the last word. Through the public serveShellRequest
 * primitive.
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
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
  type Middleware,
} from "../../index.rsc.js";

const NOT_REUSED = "private, no-cache";
const NO_STORE = "private, no-store";

const Ratings = createLoader(async () => ({ stars: 4 }));

/** Sets `value` before the render, as a signed-in app's middleware does. */
const sets =
  (value: string): Middleware =>
  async (ctx, next) => {
    ctx.header("Cache-Control", value);
    await next();
  };

/**
 * Pages under `prefix`, below a layout whose revalidate() reads the source
 * page's URL and keeps the layout: a prefetch from a page that holds it is
 * that page's answer only. `/deferring` defers its loader in a prefetch.
 */
function area(
  {
    layout,
    path,
    loader,
    revalidate,
  }: Parameters<Parameters<typeof urls>[0]>[0],
  prefix: string,
  handlerHeader?: string,
) {
  const page = (name: string) => (ctx: HandlerContext) => {
    if (handlerHeader) ctx.headers.set("Cache-Control", handlerHeader);
    return <p>{name}</p>;
  };
  return layout(
    () => <main>{prefix}</main>,
    () => [
      revalidate(({ currentUrl, defaultShouldRevalidate }) =>
        currentUrl.searchParams.has("refresh") ? true : defaultShouldRevalidate,
      ),
      path(`${prefix}/a`, page(`${prefix}-a`), { name: `${prefix}A` }),
      path(`${prefix}/b`, page(`${prefix}-b`), { name: `${prefix}B` }),
      path(
        `${prefix}/deferring`,
        page(`${prefix}-deferring`),
        { name: `${prefix}Deferring` },
        () => [loader(Ratings, { prefetch: false })],
      ),
    ],
  );
}

function app() {
  const router = createRouter({})
    .use("/account/*", sets(NO_STORE))
    .use("/upper/*", sets("Private, No-Store"))
    .use("/weaker/*", sets("private, max-age=60"))
    .use("/late/*", async (ctx, next) => {
      ctx.header("Cache-Control", NO_STORE);
      await next();
      ctx.header("Cache-Control", "private, max-age=5");
    })
    .routes(
      urls((helpers) => [
        helpers.path("/", () => <p>home</p>, { name: "home" }),
        area(helpers, "/account"),
        area(helpers, "/public"),
        area(helpers, "/upper"),
        area(helpers, "/weaker"),
        area(helpers, "/late"),
        area(helpers, "/handler", NO_STORE),
      ]),
    );

  const serve = (url: string, opts: ServeShellRequestOptions = {}) =>
    serveShellRequest(router, url, opts);

  /** The ids a page holds once a navigation to it committed. */
  const held = async (at: string) =>
    payloadOf(await serve(at, { partial: { from: "/elsewhere" } })).matched;

  const prefetch = async (url: string, from: string) =>
    serve(url, {
      partial: { from, segments: await held(from), prefetch: true },
    });

  /** The fill the browser sends after adopting a deferring prefetch. */
  const fill = async (url: string, prefetched: ServeShellRequestResult) => {
    const { matched, deferred } = payloadOf(prefetched);
    return serve(url, {
      partial: {
        from: url,
        segments: matched.filter((id) => !deferred.includes(id)),
        fill: true,
      },
    });
  };

  const stale = (url: string) =>
    serve(url, { partial: { from: url, stale: true } });

  return { serve, prefetch, fill, stale };
}

/** The metadata row (`0:`) of a partial response. */
function payloadOf(result: ServeShellRequestResult) {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  const { segments, matched } = JSON.parse(row!.slice(2)).metadata as {
    segments: Array<{ id: string; deferred?: boolean }>;
    matched: string[];
  };
  return {
    matched,
    deferred: segments.filter((s) => s.deferred === true).map((s) => s.id),
  };
}

const headersOf = (result: ServeShellRequestResult) => ({
  status: result.response.status,
  cacheControl: result.response.headers.get("cache-control"),
});

/** Each not-reused kind for the pages under `prefix`, in order. */
async function notReusedKinds(prefix: string) {
  const { prefetch, fill, stale } = app();
  const scoped = await prefetch(`${prefix}/b`, `${prefix}/a`);
  expect(scoped.response.headers.get("x-rsc-prefetch-scope")).toBe("source");
  expect(payloadOf(scoped).deferred).toEqual([]);

  const deferring = await prefetch(`${prefix}/deferring`, `${prefix}/a`);
  expect(payloadOf(deferring).deferred).toHaveLength(1);

  const filled = await fill(`${prefix}/deferring`, deferring);
  expect(filled.flight).toContain("stars");

  return {
    scoped: headersOf(scoped),
    deferring: headersOf(deferring),
    fill: headersOf(filled),
    stale: headersOf(await stale(`${prefix}/a`)),
  };
}

const every = (cacheControl: string) => ({
  scoped: { status: 200, cacheControl },
  deferring: { status: 200, cacheControl },
  fill: { status: 200, cacheControl },
  stale: { status: 200, cacheControl },
});

beforeEach(async () => {
  await resetShellTestState();
});

describe("a partial nothing may reuse", () => {
  it("keeps a route's private, no-store on each kind", async () => {
    expect(await notReusedKinds("/account")).toEqual(every(NO_STORE));
  });

  it("is sent private, no-cache when the route set nothing", async () => {
    expect(await notReusedKinds("/public")).toEqual(every(NOT_REUSED));
  });

  it("keeps no-store whatever its case", async () => {
    expect(await notReusedKinds("/upper")).toEqual(every("Private, No-Store"));
  });

  it("replaces a header that would let the browser reuse it", async () => {
    expect(await notReusedKinds("/weaker")).toEqual(every(NOT_REUSED));
  });

  it("leaves the last word to a middleware that writes after next()", async () => {
    expect(await notReusedKinds("/late")).toEqual(every("private, max-age=5"));
  });

  it("keeps no-store a route handler set on a scoped prefetch", async () => {
    const { prefetch } = app();
    const scoped = await prefetch("/handler/b", "/handler/a");
    expect(scoped.response.headers.get("x-rsc-prefetch-scope")).toBe("source");
    expect(headersOf(scoped)).toEqual({ status: 200, cacheControl: NO_STORE });
  });

  it("keeps a handler's no-store only where the handler runs: not on a fill that keeps its segment", async () => {
    const { prefetch, fill } = app();
    const deferring = await prefetch("/handler/deferring", "/handler/a");
    expect(headersOf(deferring).cacheControl).toBe(NO_STORE);
    const filled = await fill("/handler/deferring", deferring);
    expect(filled.flight).not.toContain("/handler-deferring");
    expect(headersOf(filled).cacheControl).toBe(NOT_REUSED);
  });

  it("leaves a plain prefetch and navigation as they were", async () => {
    const { serve, prefetch } = app();
    const plain = await prefetch("/account/a", "/");
    expect(plain.response.headers.get("x-rsc-prefetch-scope")).toBeNull();
    expect(headersOf(plain).cacheControl).toBe(NO_STORE);
    const nav = await serve("/public/b", { partial: { from: "/" } });
    expect(headersOf(nav).cacheControl).toBeNull();
  });
});
