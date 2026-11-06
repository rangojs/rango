/**
 * On-demand prerender: a refresh whose render answers `redirect()`.
 *
 * A redirect can depend on the request (a session or auth check), so it says
 * nothing about the page being gone: the refresh stores nothing, neither a
 * redirect nor a "removed" marker, and reports `skipped-redirect` instead of
 * `render-failed` (it used to report the redirect Response as a render
 * failure, so a sweep logged a failure on every pass for a page that was
 * fine). The page stored before keeps serving to documents and client
 * navigations, and revalidates on its own schedule.
 *
 * Every handler kind that can redirect is covered, through the public testing
 * primitives (`router.prerender()` runs the real requestless producer, and
 * `serveShellRequest` serves the production request handler): a route
 * handler, a layout handler, a parallel-slot handler, a `Passthrough` route's
 * build handler, and a handler streaming behind `loading()`.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createMemoryPrerenderStore } from "../index.js";
import {
  createRouter,
  notFound,
  Passthrough,
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import type { MemoryPrerenderStore } from "../../prerender/index.js";

/** The handler kind the fixtures below are switched to redirect on. */
let redirecting: string | null = null;

/** Render stamps: a stored page replays its stamp, a later render a new one. */
let renders = 0;
const stamp = (kind: string): string => `${kind}-${++renders}`;

/** On-demand config shared by every fixture: the tag markStale() targets. */
const onDemand = {
  ttl: 3600,
  tags: ({ params }: { params: Record<string, string> }) => [
    `od:${params.slug}`,
  ],
};

function Page({ children }: { children?: React.ReactNode }): React.ReactNode {
  return <div>{children}</div>;
}

const RouteRedirectDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    // A Prerender handler cannot return a Response (the type has no such
    // arm): a redirect is thrown, as the router's handlers document.
    if (redirecting === "route") throw redirect("/login");
    return <p data-testid="stamp">{stamp(`route:${ctx.params.slug}`)}</p>;
  },
  { onDemand },
);

// A layout handler may return the Response (a Handler's return type carries
// one): the router treats it as control flow, as it does a thrown one.
const LayoutRedirect = async () =>
  redirecting === "layout" ? (
    redirect("/login")
  ) : (
    <main data-testid="layout">layout</main>
  );

// Returned, not thrown: a slot handler's Response is control flow too.
const SlotRedirect = async () =>
  redirecting === "slot" ? (
    redirect("/login")
  ) : (
    <aside data-testid="slot">slot</aside>
  );

const PassthroughRedirectDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    if (redirecting === "passthrough") throw redirect("/login");
    return <p data-testid="stamp">{stamp(`passthrough:${ctx.params.slug}`)}</p>;
  },
  { onDemand },
);

const StreamedRedirectDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    // A real suspension so the handler's result is streamed behind loading().
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (redirecting === "streamed") throw redirect("/login");
    return <p data-testid="stamp">{stamp(`streamed:${ctx.params.slug}`)}</p>;
  },
  { onDemand },
);

/** One router per test: route entries are cached per router id. */
function makeRouter(store: MemoryPrerenderStore, id: string) {
  return createRouter({ id, prerender: { store } }).routes(
    urls(({ path, layout, parallel, loading }) => [
      path("/", async () => <p>home</p>, { name: "home" }),
      path("/route-redirect/:slug", RouteRedirectDef, {
        name: "routeRedirect",
      }),
      layout(LayoutRedirect, () => [
        path("/layout-redirect/:slug", RouteRedirectDef, {
          name: "layoutRedirect",
        }),
      ]),
      path(
        "/slot-redirect/:slug",
        RouteRedirectDef,
        { name: "slotRedirect" },
        () => [parallel({ "@side": SlotRedirect })],
      ),
      path(
        "/passthrough-redirect/:slug",
        Passthrough(PassthroughRedirectDef, async (ctx) => (
          <p data-testid="stamp">{`live:${ctx.params.slug}`}</p>
        )),
        { name: "passthroughRedirect" },
      ),
      path(
        "/streamed-redirect/:slug",
        StreamedRedirectDef,
        { name: "streamedRedirect" },
        () => [loading(<p>loading</p>)],
      ),
    ]),
  );
}

/** The URL of each handler kind's on-demand route. */
const kinds = [
  ["route handler", "/route-redirect"],
  ["layout handler", "/layout-redirect"],
  ["parallel slot handler", "/slot-redirect"],
  ["Passthrough build handler", "/passthrough-redirect"],
  ["handler behind loading()", "/streamed-redirect"],
] as const;

/** The kind key each fixture's render reads. */
const kindKeys: Record<string, string> = {
  "route handler": "route",
  "layout handler": "layout",
  "parallel slot handler": "slot",
  "Passthrough build handler": "passthrough",
  "handler behind loading()": "streamed",
};

describe("on-demand prerender: a redirecting refresh", () => {
  let store: MemoryPrerenderStore;
  let router: ReturnType<typeof makeRouter>;
  let id = 0;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    redirecting = null;
    renders = 0;
    id += 1;
    router = makeRouter(store, `od-redirect-${id}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The page a document request serves: its stamp, or null. */
  async function documentStamp(url: string): Promise<{
    status: number;
    location: string | null;
    stamp: string | null;
  }> {
    const served = await serveShellRequest(router, url);
    const match = /(?:route|passthrough|streamed):[^"<]+/.exec(
      served.flight ?? "",
    );
    return {
      status: served.response.status,
      location: served.response.headers.get("Location"),
      stamp: match?.[0] ?? null,
    };
  }

  /** The page a client navigation (`?_rsc_partial` from "/") is served. */
  async function navigationStamp(url: string): Promise<{
    status: number;
    stamp: string | null;
  }> {
    const served = await serveShellRequest(router, url, {
      partial: { from: "/", segments: [] },
    });
    const match = /(?:route|passthrough|streamed):[^"<]+/.exec(
      served.flight ?? "",
    );
    return { status: served.response.status, stamp: match?.[0] ?? null };
  }

  for (const [name, base] of kinds) {
    it(`${name}: the stored page keeps serving and nothing is written`, async () => {
      const url = `${base}/a`;
      const prerender = router.prerender({ env: {} });

      const first = await prerender(url);
      expect(first).toMatchObject({ ok: true, status: "rendered" });
      const stored = JSON.stringify(store.entries());
      const before = await documentStamp(url);
      expect(before.status).toBe(200);
      expect(before.stamp).not.toBeNull();

      redirecting = kindKeys[name]!;
      const refresh = await prerender(url);
      // Its own outcome, not a failure of the page: the redirect Response is
      // not reported as an error, and a sweep can tell it apart.
      expect(refresh).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
        target: url,
        routeName: expect.any(String),
      });
      expect(refresh).not.toHaveProperty("error");
      // Neither a redirect nor a "removed" marker: the entry is untouched.
      expect(JSON.stringify(store.entries())).toBe(stored);

      // The stored page keeps serving, to a document and to a navigation.
      expect(await documentStamp(url)).toEqual(before);
      expect(await navigationStamp(url)).toEqual({
        status: 200,
        stamp: before.stamp,
      });

      // A refresh that renders a page replaces the entry.
      redirecting = null;
      expect(await prerender(url)).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const after = await documentStamp(url);
      expect(after.status).toBe(200);
      expect(after.stamp).not.toBe(before.stamp);

      // And it is revalidated on its own schedule: a markStale() makes the
      // next onlyIfStale sweep render it again.
      await prerender.markStale([`od:a`]);
      const swept = await prerender(url, { onlyIfStale: true });
      expect(swept).toMatchObject({ ok: true, status: "rendered" });
      expect((await documentStamp(url)).stamp).not.toBe(after.stamp);
    });
  }

  it("a fresh entry's sweep is already-fresh: a redirecting refresh marked nothing", async () => {
    const url = "/route-redirect/sweep";
    const prerender = router.prerender({ env: {} });
    await prerender(url);

    redirecting = "route";
    await prerender(url);
    redirecting = null;

    // The entry was never written by the redirecting refresh, so its ttl
    // still stands: the sweep leaves it alone.
    expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "already-fresh",
    });

    // A stale entry a sweep renders into a redirect stays stale: the sweep
    // reported no render, so it wrote nothing to refresh it.
    await prerender.markStale(["od:sweep"]);
    redirecting = "route";
    expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
      ok: false,
      status: "skipped-redirect",
    });
    expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
      ok: false,
      status: "skipped-redirect",
    });
  });

  describe("a render that redirects and also reports something else", () => {
    /**
     * A slot handler that streams behind its own loading() and rejects with
     * `report`: the route handler's redirect and the slot's outcome are both
     * settled when the producer decides, so neither segment's position picks
     * the outcome.
     */
    function bothRouter(report: () => never) {
      const ReportingSlot = async (): Promise<React.ReactNode> => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        report();
      };
      return createRouter({
        id: `od-redirect-both-${++id}`,
        prerender: { store },
      }).routes(
        urls(({ path, parallel, loading }) => [
          path(
            "/both/:slug",
            Prerender<{ slug: string }>(
              async () => [],
              async () => {
                await new Promise((resolve) => setTimeout(resolve, 1));
                throw redirect("/login");
              },
              { onDemand: true },
            ),
            { name: "both" },
            () => [
              parallel({
                "@side": {
                  handler: ReportingSlot,
                  use: () => [loading(<p>slot loading</p>)],
                },
              }),
              loading(<p>loading</p>),
            ],
          ),
        ]),
      );
    }

    it("a failure the render reported wins: render-failed", async () => {
      const result = await bothRouter(() => {
        throw new Error("upstream down");
      }).prerender({ env: {} })("/both/a");
      expect(result).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "render-failed",
      });
      expect((result as { error?: Error }).error?.message).toBe(
        "upstream down",
      );
      expect(store.size).toBe(0);
    });

    it("a notFound() the render reported loses to the redirect: skipped-redirect", async () => {
      const result = await bothRouter(() => notFound()).prerender({ env: {} })(
        "/both/a",
      );
      // A redirect can depend on the request, so it does not show the page is
      // gone: nothing is stored, not even the "removed" marker.
      expect(result).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
      });
      expect(store.size).toBe(0);
    });
  });

  describe("a component that throws redirect()", () => {
    /** A deep async component: Flight reports its throw through onError. */
    function childRouter(...children: Array<() => Promise<React.ReactNode>>) {
      return createRouter({
        id: `od-redirect-child-${++id}`,
        prerender: { store },
      }).routes(
        urls(({ path }) => [
          path(
            "/child/:slug",
            Prerender<{ slug: string }>(
              async () => [],
              async () => (
                <div>
                  {children.map((Child, i) => (
                    <Child key={i} />
                  ))}
                </div>
              ),
              { onDemand: true },
            ),
            { name: "child" },
          ),
        ]),
      );
    }

    const throwRedirect = async (): Promise<React.ReactNode> => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw redirect("/login");
    };
    const throwNotFound = async (): Promise<React.ReactNode> => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      notFound();
    };
    const throwFailure = async (): Promise<React.ReactNode> => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      throw new Error("upstream down");
    };

    it("is skipped-redirect, ahead of a notFound() it reported too", async () => {
      const result = await childRouter(throwRedirect, throwNotFound).prerender({
        env: {},
      })("/child/a");
      expect(result).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
      });
      expect(store.size).toBe(0);
    });

    it("loses to a failure the same render reported", async () => {
      const result = await childRouter(throwRedirect, throwFailure).prerender({
        env: {},
      })("/child/a");
      expect(result).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "render-failed",
      });
      expect((result as { error?: Error }).error?.message).toBe(
        "upstream down",
      );
      expect(store.size).toBe(0);
    });
  });

  it("a live request's parallel-slot handler redirect short-circuits, as a route or layout handler's does", async () => {
    const live = createRouter({ id: `od-redirect-live-${++id}` }).routes(
      urls(({ path, parallel }) => [
        path(
          "/live/:slug",
          async () => <p>page</p>,
          { name: "live" },
          () => [parallel({ "@side": async () => redirect("/login") })],
        ),
      ]),
    );
    const served = await serveShellRequest(live, "/live/a");
    expect(served.response.status).toBe(302);
    expect(served.response.headers.get("Location")).toBe("/login");
  });
});
