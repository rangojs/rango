/**
 * A parallel slot handler's redirect() behaves as a route or layout handler's:
 * returned or thrown, it short-circuits the document into a 3xx with its
 * Location and a navigation into the Flight redirect, through the production
 * request handler (serveShellRequest). A slot that declares loading() streams
 * an async handler, as a route with loading() does, so only its synchronous
 * redirect short-circuits.
 *
 * A redirect is never stored: a cache() MISS that redirects leaves nothing
 * behind, a stale record's background re-render that redirects keeps the
 * record, and an on-demand prerender refresh reports `render-failed` with the
 * redirect and keeps serving the page stored before.
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createMemoryPrerenderStore } from "../index.js";
import { createRouter, Prerender, redirect, urls } from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import type { PrerenderResult } from "../../prerender/index.js";

/** Set to make the switchable handlers below redirect. */
let redirecting = false;
let renders = 0;

const toTarget = (): Response => redirect("/target", 302);
const handlers = {
  returned: () => toTarget(),
  resolved: async () => toTarget(),
  thrown: () => {
    throw toTarget();
  },
  rejected: async () => {
    await Promise.resolve();
    throw toTarget();
  },
};

function Shell({ children }: { children?: React.ReactNode }): React.ReactNode {
  return <main>{children}</main>;
}
function Page(): React.ReactNode {
  renders += 1;
  return <h1>{`page-${renders}`}</h1>;
}
function SwitchableSlot(): React.ReactNode | Response {
  return redirecting ? toTarget() : <aside>aside</aside>;
}

const OnDemandPage = Prerender(
  async () => [],
  async () => {
    renders += 1;
    return <h1>{`stored-${renders}`}</h1>;
  },
  { onDemand: { ttl: 0 } },
);

function vercelCache(): VercelRuntimeCache {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
}

function makeRouter(options: Parameters<typeof createRouter>[0] = {}) {
  return createRouter(options).routes(
    urls(({ path, layout, parallel, loading, cache }) => [
      path("/target", () => <p>target</p>, { name: "target" }),
      path("/from", () => <p>from</p>, { name: "from" }),
      // The references: a layout and a route handler that redirect.
      layout(toTarget, () => [path("/layout", Page, { name: "layout" })]),
      path("/route", toTarget, { name: "route" }),
      path(
        "/route-loading",
        handlers.resolved,
        { name: "routeLoading" },
        () => [loading(<p>loading</p>)],
      ),
      ...Object.entries(handlers).flatMap(([kind, handler]) => [
        layout(Shell, () => [
          parallel({ "@aside": handler }),
          path(`/slot/${kind}`, Page, { name: `slot.${kind}` }),
        ]),
        // The slot is the route's own, not a layout's.
        path(`/route-slot/${kind}`, Page, { name: `routeSlot.${kind}` }, () => [
          parallel({ "@aside": handler }),
        ]),
        // A layout among the route's children (an orphan) owns the slot.
        path(
          `/orphan-slot/${kind}`,
          Page,
          { name: `orphanSlot.${kind}` },
          () => [layout(Shell, () => [parallel({ "@aside": handler })])],
        ),
        layout(Shell, () => [
          parallel({ "@aside": handler }, () => [loading(<p>loading</p>)]),
          path(`/slot-loading/${kind}`, Page, { name: `slotLoading.${kind}` }),
        ]),
      ]),
      cache({ ttl: 300 }, () => [
        layout(Shell, () => [
          parallel({ "@aside": SwitchableSlot }),
          path("/cached", Page, { name: "cached" }),
        ]),
      ]),
      // Stale from the start, servable for 60 s.
      cache({ ttl: 0, swr: 60 }, () => [
        layout(Shell, () => [
          parallel({ "@aside": SwitchableSlot }),
          path("/swr", Page, { name: "swr" }),
        ]),
      ]),
      layout(Shell, () => [
        parallel({ "@aside": SwitchableSlot }),
        path("/on-demand", OnDemandPage, { name: "onDemand" }),
      ]),
      layout(Shell, () => [
        parallel({ "@aside": toTarget }),
        path("/based", Page, { name: "based" }),
      ]),
    ]),
  );
}

/** What a visitor gets: the status and where it sends them, if anywhere. */
function answer(result: ServeShellRequestResult): {
  status: number;
  location: string | null;
} {
  const { headers, status } = result.response;
  return {
    status,
    location: headers.get("location") ?? headers.get("x-rsc-redirect"),
  };
}

const REDIRECTED_DOCUMENT = { status: 302, location: "/target" };
const REDIRECTED_NAVIGATION = {
  status: 204,
  location: "http://localhost/target",
};

function serve(
  router: ReturnType<typeof makeRouter>,
  url: string,
  kind: "document" | "navigation",
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(kind === "navigation" && { partial: { from: "/from" } }),
  });
}

beforeEach(async () => {
  await resetShellTestState();
  redirecting = false;
  renders = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a parallel slot handler's redirect()", () => {
  for (const kind of ["document", "navigation"] as const) {
    describe(`on a ${kind}`, () => {
      const expected =
        kind === "document" ? REDIRECTED_DOCUMENT : REDIRECTED_NAVIGATION;

      it("redirects, as a layout or route handler's does", async () => {
        const router = makeRouter();
        expect(answer(await serve(router, "/layout", kind))).toEqual(expected);
        expect(answer(await serve(router, "/route", kind))).toEqual(expected);
      });

      for (const kind_ of Object.keys(handlers)) {
        it(`${kind_}: from a layout's slot, a route's own slot and an orphan layout's slot`, async () => {
          const router = makeRouter();
          for (const owner of ["slot", "route-slot", "orphan-slot"]) {
            expect(
              answer(await serve(router, `/${owner}/${kind_}`, kind)),
            ).toEqual(expected);
          }
        });
      }

      it("under loading(): a synchronous redirect redirects; an async one streams, as a route's with loading() does", async () => {
        const router = makeRouter();
        for (const sync of ["returned", "thrown"]) {
          expect(
            answer(await serve(router, `/slot-loading/${sync}`, kind)),
          ).toEqual(expected);
        }
        const streamedRoute = answer(
          await serve(router, "/route-loading", kind),
        );
        expect(streamedRoute).toEqual({ status: 200, location: null });
        for (const streamed of ["resolved", "rejected"]) {
          expect(
            answer(await serve(router, `/slot-loading/${streamed}`, kind)),
          ).toEqual(streamedRoute);
        }
      });
    });
  }

  it("keeps the router's basename, as a route's redirect does", async () => {
    const router = makeRouter({ basename: "/app" });
    for (const url of ["/app/based", "/app/route"]) {
      expect(answer(await serveShellRequest(router, url))).toEqual({
        status: 302,
        location: "/app/target",
      });
    }
  });
});

describe("a slot's redirect is never stored", () => {
  it("cache(): a MISS that redirects leaves no record; the next request renders the page", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    redirecting = true;
    expect(
      answer(await serveShellRequest(router, "/cached", { cacheStore })),
    ).toEqual(REDIRECTED_DOCUMENT);

    redirecting = false;
    const page = await serveShellRequest(router, "/cached", { cacheStore });
    expect(answer(page)).toEqual({ status: 200, location: null });
    expect(page.body).toContain("page-1");
  });

  it("cache(): a stale record whose background re-render redirects keeps serving the record", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const router = makeRouter();
    const cacheStore = new VercelCacheStore({ cache: vercelCache() });
    const stored = await serveShellRequest(router, "/swr", { cacheStore });
    expect(stored.body).toContain("page-1");

    offset += 1_100;
    redirecting = true;
    for (let i = 0; i < 2; i++) {
      const stale = await serveShellRequest(router, "/swr", { cacheStore });
      expect(answer(stale)).toEqual({ status: 200, location: null });
      expect(stale.body).toContain("page-1");
    }
  });

  it("on-demand refresh: render-failed with the redirect, and the page stored before keeps serving and revalidating", async () => {
    const onRevalidate = vi.fn();
    const store = createMemoryPrerenderStore();
    const router = makeRouter({ prerender: { store, onRevalidate } });
    const prerender = router.prerender({ env: {} });
    expect(await prerender("/on-demand")).toMatchObject({
      ok: true,
      status: "rendered",
    });

    redirecting = true;
    const refresh = (await prerender("/on-demand")) as Extract<
      PrerenderResult,
      { ok: false }
    >;
    expect(refresh).toMatchObject({ ok: false, status: "render-failed" });
    expect(refresh.error).toBeInstanceOf(Response);
    expect((refresh.error as Response).headers.get("location")).toBe("/target");

    onRevalidate.mockClear();
    for (const kind of ["document", "navigation"] as const) {
      const served = await serve(router, "/on-demand", kind);
      expect(answer(served)).toEqual({ status: 200, location: null });
      expect(served.flight).toContain("stored-1");
    }
    // The stored page is stale (ttl 0): each request schedules its refresh.
    expect(onRevalidate).toHaveBeenCalledTimes(2);
  });
});
