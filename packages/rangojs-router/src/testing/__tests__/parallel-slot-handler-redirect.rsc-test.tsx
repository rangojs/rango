/**
 * A parallel slot handler's redirect, through the public testing primitives: a
 * route or layout handler's returned (or thrown) `redirect()` short-circuits
 * the request, and a slot handler's must too.
 *
 * A slot handler's result reached the segment walk raw, so a returned Response
 * became the slot's component: the document answered 200 with an error row
 * ("Only plain objects, and a few built-ins, can be passed to Client
 * Components"), a navigation answered 200 with no `X-RSC-Redirect`, and an
 * on-demand refresh failed with that serialization error instead of the
 * redirect. `resolveParallelSlotComponent` (segment-resolution/revalidation.ts)
 * now runs it through `handleHandlerResult`, the funnel a route or layout
 * handler's result goes through, so all three paths answer as they do for
 * those handlers:
 *
 * - a document request: 302 with `Location`;
 * - a client navigation: 204 with `X-RSC-Redirect`;
 * - an on-demand refresh: `render-failed` carrying the redirect, so nothing is
 *   stored and the page stored before keeps serving;
 * - a slot that declares `loading()` and redirects after an await: the response
 *   has already started, so the redirect rides the stream as an error row, as a
 *   streamed route handler's does. A synchronous one still becomes a redirect.
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
import { createMemoryPrerenderStore } from "../index.js";
import {
  createRouter,
  Prerender,
  redirect,
  urls,
  type Handler,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderResult,
} from "../../prerender/index.js";

const TARGET = "/target";
const Loading = <p>slot-loading</p>;

/** A slot handler that returns a redirect. */
function returnsRedirect(): React.ReactNode {
  return redirect(TARGET, 302) as unknown as React.ReactNode;
}
/** The same, after an await: the response streams past the redirect. */
async function returnsRedirectLater(): Promise<React.ReactNode> {
  await Promise.resolve();
  return redirect(TARGET, 302) as unknown as React.ReactNode;
}
/** A slot handler that throws one. */
function throwsRedirect(): React.ReactNode {
  throw redirect(TARGET, 302);
}
/** The same, after an await. */
async function throwsRedirectLater(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect(TARGET, 302);
}

function page(name: string): React.ReactNode {
  return <p>{name}</p>;
}

const Chrome = () => <main>slot-chrome</main>;

/**
 * Where the slot under test sits: in the layout beside the route ("layout"), in
 * a routeless layout beside the routes ("orphan", which the walk resolves on
 * its own path, resolveOrphanLayout), or in the route's own children ("route").
 */
type Placement = "layout" | "orphan" | "route";

/**
 * `/plain` lives in a second layout with no slot, so a navigation has a page to
 * start from.
 */
function makeRouter(
  slot: Handler,
  options: { loading?: boolean; placement?: Placement } = {},
) {
  const placement = options.placement ?? "layout";
  return createRouter({}).routes(
    urls(({ path, layout, parallel, loading }) => {
      const slotEntry = options.loading
        ? parallel({ "@aside": slot }, () => [loading(Loading)])
        : parallel({ "@aside": slot });
      const routes = [
        path(
          "/page",
          () => page("page"),
          { name: "page" },
          placement === "route" ? () => [slotEntry] : undefined,
        ),
        path(TARGET, () => page("target"), { name: "target" }),
      ];
      return [
        layout(
          () => <main>plain-chrome</main>,
          () => [path("/plain", () => page("plain"), { name: "plain" })],
        ),
        placement === "orphan"
          ? layout(Chrome, () => [slotEntry])
          : layout(Chrome, () => [
              ...(placement === "layout" ? [slotEntry] : []),
              ...routes,
            ]),
        ...(placement === "orphan" ? routes : []),
      ];
    }),
  );
}

type Router = ReturnType<typeof makeRouter>;

function document(router: Router): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, "/page", {
    cacheStore: new MemorySegmentCacheStore(),
  });
}

function navigation(router: Router): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, "/page", {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from: "/plain" },
  });
}

/** The redirect a document request answered with. */
function expectDocumentRedirect(res: ServeShellRequestResult): void {
  expect(res.flight).toBeUndefined();
  expect(res.response.status).toBe(302);
  expect(res.response.headers.get("location")).toBe(TARGET);
}

/** The redirect a client navigation answered with. */
function expectNavigationRedirect(res: ServeShellRequestResult): void {
  expect(res.response.status).toBe(204);
  expect(res.response.headers.get("x-rsc-redirect")).toBe(
    `http://localhost${TARGET}`,
  );
}

/** A streamed redirect: the response already started, so it rides the stream. */
function expectStreamedRedirect(res: ServeShellRequestResult): void {
  expect(res.response.status).toBe(200);
  expect(res.response.headers.get("location")).toBeNull();
  expect(res.flight).toMatch(/^\d+:E\{/m);
}

beforeEach(() => resetShellTestState());

describe("a slot handler's returned redirect (serveShellRequest)", () => {
  it("document: answers 302 with Location", async () => {
    expectDocumentRedirect(await document(makeRouter(returnsRedirect)));
  });

  it("document: an async slot handler answers 302 too", async () => {
    expectDocumentRedirect(await document(makeRouter(returnsRedirectLater)));
  });

  it("document: a slot under a routeless layout answers 302", async () => {
    expectDocumentRedirect(
      await document(makeRouter(returnsRedirect, { placement: "orphan" })),
    );
  });

  it("document: a slot in the route's own children answers 302", async () => {
    expectDocumentRedirect(
      await document(makeRouter(returnsRedirect, { placement: "route" })),
    );
  });

  it("navigation: answers 204 with X-RSC-Redirect", async () => {
    expectNavigationRedirect(await navigation(makeRouter(returnsRedirect)));
  });

  it("navigation: an async slot handler answers 204 too", async () => {
    expectNavigationRedirect(
      await navigation(makeRouter(returnsRedirectLater)),
    );
  });

  it("navigation: a slot under a routeless layout answers 204", async () => {
    expectNavigationRedirect(
      await navigation(makeRouter(returnsRedirect, { placement: "orphan" })),
    );
  });
});

describe("a slot handler's thrown redirect (serveShellRequest)", () => {
  it("document: answers 302 with Location", async () => {
    expectDocumentRedirect(await document(makeRouter(throwsRedirect)));
  });

  it("document: thrown after an await answers 302 too", async () => {
    expectDocumentRedirect(await document(makeRouter(throwsRedirectLater)));
  });

  it("navigation: answers 204 with X-RSC-Redirect", async () => {
    expectNavigationRedirect(await navigation(makeRouter(throwsRedirect)));
  });

  it("navigation: thrown after an await answers 204 too", async () => {
    expectNavigationRedirect(await navigation(makeRouter(throwsRedirectLater)));
  });
});

describe("a slot handler's redirect under a declared loading()", () => {
  it("document: a synchronous return still answers 302", async () => {
    expectDocumentRedirect(
      await document(makeRouter(returnsRedirect, { loading: true })),
    );
  });

  it("navigation: a synchronous return still answers 204", async () => {
    expectNavigationRedirect(
      await navigation(makeRouter(returnsRedirect, { loading: true })),
    );
  });

  it("document: a redirect after an await rides the stream, as a route handler's does", async () => {
    expectStreamedRedirect(
      await document(makeRouter(returnsRedirectLater, { loading: true })),
    );
  });

  it("navigation: a redirect after an await rides the stream", async () => {
    expectStreamedRedirect(
      await navigation(makeRouter(returnsRedirectLater, { loading: true })),
    );
  });
});

describe("a slot's redirect on a `ppr` route", () => {
  it("document: answers 302 and stores no shell", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({}).routes(
      urls(({ path, layout, parallel }) => [
        layout(Chrome, () => [
          parallel({ "@aside": returnsRedirect }),
          path("/page", () => page("page"), {
            name: "page",
            ppr: { ttl: 300, swr: 120 },
          }),
          path(TARGET, () => page("target"), { name: "target" }),
        ]),
      ]),
    );
    const res = await serveShellRequest(router, "/page", { cacheStore });
    expectDocumentRedirect(res);
    // A redirect is never stored: the next request redirects too.
    expect(await res.readEntry()).toBeNull();
    expectDocumentRedirect(
      await serveShellRequest(router, "/page", { cacheStore }),
    );
  });
});

describe("an intercept handler's redirect", () => {
  // The neighbouring kind: intercepts already funnel their handler result
  // (intercept-resolution.ts). Pinned so the slot's funnel stays the only
  // difference between the two.
  it("navigation: answers 204 with X-RSC-Redirect", async () => {
    const router = createRouter({}).routes(
      urls(({ path, layout, parallel, intercept }) => [
        layout(Chrome, () => [
          parallel({ "@modal": () => <p>default modal</p> }),
          path("/list", () => page("list"), { name: "list" }),
          path("/item/:id", () => page("item"), { name: "item" }),
          intercept("@modal", ".item", returnsRedirect),
        ]),
      ]),
    );
    const res = await serveShellRequest(router, "/item/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/list" },
    });
    expectNavigationRedirect(res);
  });
});

/** Set once the page has been stored, so the next refresh redirects. */
let moving = false;

const ON_DEMAND_PAGE = "on-demand page body";

/** The slot redirects once `moving` is set; before that it renders. */
function movingSlot(): React.ReactNode {
  return moving
    ? (redirect(TARGET, 302) as unknown as React.ReactNode)
    : (React.createElement("aside", null, "aside body") as React.ReactNode);
}

/** The slot throws once `moving` is set. */
function movingThrowingSlot(): React.ReactNode {
  if (moving) throw redirect(TARGET, 302);
  return React.createElement("aside", null, "aside body");
}

/** The route handler redirects once `moving` is set: the expected answer. */
async function movingRouteHandler(): Promise<React.ReactNode> {
  if (moving) return redirect(TARGET, 302) as unknown as React.ReactNode;
  return <h1>{ON_DEMAND_PAGE}</h1>;
}

/**
 * An on-demand page whose slot (or whose own handler) redirects on the second
 * render: the page is stored first, then a refresh meets the redirect.
 */
function makePrerenderedRouter(
  prerender: PrerenderConfig,
  shape: "slot-returns" | "slot-throws" | "route-returns",
) {
  const Def =
    shape === "route-returns"
      ? Prerender<{}>(async () => [], movingRouteHandler, { onDemand: true })
      : Prerender<{}>(
          async () => [],
          async () => <h1>{ON_DEMAND_PAGE}</h1>,
          {
            onDemand: true,
          },
        );
  return createRouter({ prerender }).routes(
    urls(({ path, layout, parallel }) => [
      layout(Chrome, () => [
        ...(shape === "route-returns"
          ? []
          : [
              parallel({
                "@aside":
                  shape === "slot-throws" ? movingThrowingSlot : movingSlot,
              }),
            ]),
        path("/page", Def, { name: "page" }),
      ]),
    ]),
  );
}

describe("a slot handler's redirect on an on-demand refresh", () => {
  let store: MemoryPrerenderStore;

  beforeEach(() => {
    store = createMemoryPrerenderStore();
    moving = false;
  });

  /**
   * Store the page, then refresh it with the redirect in place: what the
   * refresh reports, and what a visitor gets before and after.
   */
  async function refreshOf(
    shape: "slot-returns" | "slot-throws" | "route-returns",
  ) {
    const router = makePrerenderedRouter({ store }, shape);
    const prerender = router.prerender({ env: {} });
    const first = await prerender("/page");
    const before = await serveShellRequest(router, "/page");
    moving = true;
    const refresh = await prerender("/page");
    const after = await serveShellRequest(router, "/page");
    return { first, refresh, before, after };
  }

  /** The outcome a refresh answers with, with the error it carries. */
  function outcome(refresh: PrerenderResult) {
    return {
      ok: refresh.ok,
      status: refresh.status,
      error: refresh.ok === false ? refresh.error : undefined,
    };
  }

  it("stores nothing and keeps serving the page stored before", async () => {
    const { first, refresh, before, after } = await refreshOf("slot-returns");

    expect(first).toMatchObject({ ok: true, status: "rendered" });
    expect(before.flight).toContain(ON_DEMAND_PAGE);
    // The redirect is reported as itself, not as a Flight serialization error.
    expect(outcome(refresh)).toMatchObject({
      ok: false,
      status: "render-failed",
    });
    expect(refresh.ok === false && refresh.error).toBeInstanceOf(Response);
    // The page stored before keeps serving, and nothing replaced it.
    expect(after.response.status).toBe(200);
    expect(after.flight).toContain(ON_DEMAND_PAGE);
    expect(store.size).toBe(1);
  });

  it("answers as a route handler's redirect does", async () => {
    const fromRoute = await refreshOf("route-returns");
    moving = false;
    const fromSlot = await refreshOf("slot-returns");
    expect(outcome(fromSlot.refresh)).toEqual(outcome(fromRoute.refresh));
    expect(outcome(fromSlot.refresh)).toMatchObject({
      ok: false,
      status: "render-failed",
    });
    expect(fromSlot.after.flight).toContain(ON_DEMAND_PAGE);
    expect(fromRoute.after.flight).toContain(ON_DEMAND_PAGE);
  });

  it("a slot handler that throws one is reported the same way", async () => {
    const { refresh, after } = await refreshOf("slot-throws");
    expect(outcome(refresh)).toMatchObject({
      ok: false,
      status: "render-failed",
    });
    expect(refresh.ok === false && refresh.error).toBeInstanceOf(Response);
    expect(after.flight).toContain(ON_DEMAND_PAGE);
    expect(store.size).toBe(1);
  });
});
