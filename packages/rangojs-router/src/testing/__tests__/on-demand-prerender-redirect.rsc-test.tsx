/**
 * A redirecting on-demand refresh, through the public testing primitives:
 * `router.prerender()` runs the real requestless producer (real Flight
 * serializer) and `serveShellRequest` serves the route through the production
 * request handler, for a document and for the client navigation the browser
 * sends (`partial`).
 *
 * The rule (docs/design/ondemand-prerender.md, "A render that redirects"): a
 * redirect can depend on the request (a session or auth check), so it says
 * nothing about the page being gone. A refresh that answers one stores
 * nothing — no page, no "removed" marker — reports `skipped-redirect`, and the
 * page stored before keeps serving until its own ttl/tags, a later refresh or
 * a sweep replaces it. It holds for every handler kind that can redirect: the
 * route handler, a layout handler, a parallel-slot handler (streamed or not),
 * a `Passthrough` route's build handler, and a handler streaming behind
 * `loading()`.
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
import { createMemoryPrerenderStore, setBuildVersions } from "../index.js";
import {
  createRouter,
  notFound,
  Passthrough,
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderTargetObject,
} from "../../prerender/index.js";

/** Every producer entry, whichever handler kind ran it. */
const renders = { count: 0 };

/** Which handler kinds answer a redirect right now. */
const redirecting = {
  route: false,
  layout: false,
  slot: false,
  streamedSlot: false,
  passthrough: false,
  streamed: false,
};

type Kind = keyof typeof redirecting;

/** Set to make the page tree of the two precedence fixtures fail. */
const tree = { failing: false, gone: false };

const ON_DEMAND = {
  onDemand: {
    ttl: 3600,
    tags: ({ params }: { params: Record<string, string> }) => [
      `od:${params.slug}`,
    ],
  },
};

/** A page that never redirects: the layout or slot around it does. */
const page = (name: string) =>
  Prerender<{ slug: string }>(
    async () => [],
    async (ctx) => {
      renders.count += 1;
      return (
        <h1>{`page:${name}:${ctx.params.slug}:render-${renders.count}`}</h1>
      );
    },
    ON_DEMAND,
  );

/** The route handler itself. */
const RouteDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.count += 1;
    if (redirecting.route) return redirect(`/login?from=${ctx.params.slug}`);
    return <h1>{`page:route:${ctx.params.slug}:render-${renders.count}`}</h1>;
  },
  ON_DEMAND,
);

/** Behind `loading()`: the handler's result is deferred, so its Response
 *  surfaces during serialization instead of short-circuiting the walk. */
const StreamedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.count += 1;
    await Promise.resolve();
    if (redirecting.streamed) return redirect("/login?streamed");
    return (
      <h1>{`page:streamed:${ctx.params.slug}:render-${renders.count}`}</h1>
    );
  },
  ON_DEMAND,
);

/** A `Passthrough` route: the same definition is its build handler. */
const PassthroughDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.count += 1;
    if (redirecting.passthrough) return redirect("/login?passthrough");
    return <h1>{`frozen:${ctx.params.slug}:render-${renders.count}`}</h1>;
  },
  ON_DEMAND,
);
const PassthroughRoute = Passthrough(PassthroughDef, async (ctx) => (
  <h1>{`live:${ctx.params.slug}`}</h1>
));

/** An async component that throws, or calls notFound(), while a slot redirects. */
async function Failing(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw new Error("upstream 500");
}
async function Gone(): Promise<React.ReactNode> {
  await Promise.resolve();
  notFound();
}

const PrecedenceDef = (name: string) =>
  Prerender<{ slug: string }>(
    async () => [],
    async (ctx) => (
      <>
        <h1>{`page:${name}:${ctx.params.slug}`}</h1>
        {tree.failing ? <Failing /> : null}
        {tree.gone ? <Gone /> : null}
      </>
    ),
    ON_DEMAND,
  );
const FailingDef = PrecedenceDef("failing");
const GoneDef = PrecedenceDef("gone");

function makeRouter(prerender: PrerenderConfig) {
  return createRouter({ prerender }).routes(
    urls(({ path, layout, parallel, loading }) => [
      path("/route/:slug", RouteDef, { name: "route" }),
      path("/passthrough/:slug", PassthroughRoute, { name: "passthrough" }),
      path("/streamed/:slug", StreamedDef, { name: "streamed" }, () => [
        loading(<p>loading</p>),
      ]),
      layout(
        () =>
          redirecting.layout ? (
            redirect("/login?layout")
          ) : (
            <header>chrome</header>
          ),
        () => [path("/in-layout/:slug", page("layout"), { name: "inLayout" })],
      ),
      layout(
        () => <header>chrome</header>,
        () => [
          parallel({
            "@aside": () =>
              redirecting.slot ? redirect("/login?slot") : <aside>side</aside>,
          }),
          path("/with-slot/:slug", page("slot"), { name: "withSlot" }),
        ],
      ),
      // The same slot, streamed behind loading(): its redirect is a Flight
      // error, not a value in the tree.
      layout(
        () => <header>chrome</header>,
        () => [
          parallel(
            {
              "@aside": async () => {
                await Promise.resolve();
                return redirecting.streamedSlot ? (
                  redirect("/login?streamed-slot")
                ) : (
                  <aside>side</aside>
                );
              },
            },
            () => [loading(<p>loading</p>)],
          ),
          path("/with-streamed-slot/:slug", page("streamedSlot"), {
            name: "withStreamedSlot",
          }),
        ],
      ),
      layout(
        () => <header>chrome</header>,
        () => [
          parallel({
            "@aside": () =>
              redirecting.slot ? redirect("/login?slot") : <aside>side</aside>,
          }),
          path("/failing/:slug", FailingDef, { name: "failing" }),
          path("/gone/:slug", GoneDef, { name: "gone" }),
        ],
      ),
    ]),
  );
}

/**
 * Each kind's URL, route name, and the text its stored page renders (so a serve
 * can be told from a render and from a redirect).
 */
const KINDS: {
  kind: Kind;
  url: string;
  routeName: string;
  page: string;
}[] = [
  { kind: "route", url: "/route/a", routeName: "route", page: "page:route:" },
  {
    kind: "layout",
    url: "/in-layout/a",
    routeName: "inLayout",
    page: "page:layout:",
  },
  {
    kind: "slot",
    url: "/with-slot/a",
    routeName: "withSlot",
    page: "page:slot:",
  },
  {
    kind: "streamedSlot",
    url: "/with-streamed-slot/a",
    routeName: "withStreamedSlot",
    page: "page:streamedSlot:",
  },
  {
    kind: "passthrough",
    url: "/passthrough/a",
    routeName: "passthrough",
    page: "frozen:",
  },
  {
    kind: "streamed",
    url: "/streamed/a",
    routeName: "streamed",
    page: "page:streamed:",
  },
];

describe("a redirecting on-demand refresh", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    renders.count = 0;
    for (const kind of Object.keys(redirecting) as Kind[]) {
      redirecting[kind] = false;
    }
    tree.failing = false;
    tree.gone = false;
  });

  afterEach(() => {
    setBuildVersions();
    vi.restoreAllMocks();
  });

  for (const { kind, url, routeName, page: pageText } of KINDS) {
    describe(`from a ${kind} handler`, () => {
      it("is skipped-redirect, stores nothing, and the stored page keeps serving to a document and to a navigation", async () => {
        const router = makeRouter({ store });
        const prerender = router.prerender({ env: {} });

        // The page stored before the render starts redirecting.
        expect(await prerender(url)).toMatchObject({
          ok: true,
          status: "rendered",
        });
        const stored = store.entries();
        expect(stored).toHaveLength(1);
        const document = await serveShellRequest(router, url);
        expect(document.response.status).toBe(200);

        redirecting[kind] = true;
        const result = await prerender(url);

        // A render ran (it is not `already-fresh`), and it reports the skip
        // rather than a failure: nothing is written.
        expect(result).toEqual({
          ok: false,
          path: "on-demand",
          status: "skipped-redirect",
          target: url,
          routeName,
        });
        expect(store.entries()).toEqual(stored);

        // Both delivery paths still get the page stored before.
        const after = await serveShellRequest(router, url);
        expect(after.response.status).toBe(200);
        expect(after.flight).toBe(document.flight);
        expect(after.flight).toContain(pageText);
        const navigation = await serveShellRequest(router, url, {
          partial: { from: "/" },
        });
        expect(navigation.response.status).toBe(200);
        expect(navigation.flight).toContain(pageText);
        expect(navigation.flight).not.toContain("login");

        // A refresh that renders a page later replaces the entry.
        redirecting[kind] = false;
        expect(await prerender(url)).toMatchObject({
          ok: true,
          status: "rendered",
        });
        expect(store.entries()).not.toEqual(stored);
        const replaced = await serveShellRequest(router, url);
        expect(replaced.flight).not.toBe(document.flight);
      });

      it("still renders on an onlyIfStale sweep after markStale(tags)", async () => {
        const router = makeRouter({ store });
        const prerender = router.prerender({ env: {} });
        await prerender(url);
        redirecting[kind] = true;

        await prerender.markStale(["od:a"]);
        // Not `already-fresh`: the stale entry was rendered again, and that
        // render redirected.
        expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
          ok: false,
          status: "skipped-redirect",
        });
        expect(store.size).toBe(1);

        // The page comes back through the same sweep once the render does.
        redirecting[kind] = false;
        expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
          ok: true,
          status: "rendered",
        });
      });

      it("stores nothing for a page that was never rendered", async () => {
        const router = makeRouter({ store });
        redirecting[kind] = true;

        expect(await router.prerender({ env: {} })(url)).toMatchObject({
          ok: false,
          status: "skipped-redirect",
        });
        expect(store.size).toBe(0);
      });
    });
  }

  it("is the same result for a URL and for an object target", async () => {
    const router = makeRouter({ store });
    redirecting.route = true;
    const prerender = router.prerender({ env: {} });

    // The object target as a queue message carries it (a JSON round trip).
    const queued = JSON.parse(
      JSON.stringify({ route: "route", params: { slug: "a" } }),
    ) as PrerenderTargetObject;
    for (const target of [new URL("http://shop.example/route/a"), queued]) {
      expect(await prerender(target)).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
        routeName: "route",
      });
    }
    expect(store.size).toBe(0);
  });

  it("many() reports one skipped-redirect per target and keeps the batch going", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    redirecting.route = true;

    const results = await prerender.many(["/route/a", "/plain/b"]);
    expect(results.map((r) => [r.ok, r.status])).toEqual([
      [false, "skipped-redirect"],
      [false, "no-match"],
    ]);
    expect(store.size).toBe(0);
  });

  it("throws a PrerenderError under throwOnError, like any other refusal", async () => {
    const router = makeRouter({ store });
    redirecting.route = true;

    await expect(
      router.prerender({ env: {} })("/route/a", { throwOnError: true }),
    ).rejects.toMatchObject({
      name: "PrerenderError",
      result: { ok: false, status: "skipped-redirect" },
    });
  });

  // The refresh's own report: a redirect is an outcome, not a crash, but it
  // never hides a real failure, and it outranks a notFound() (which would
  // store a "removed" marker for a page that is fine).
  describe("beside another outcome", () => {
    it("a render that redirects and also fails is render-failed, and the page keeps serving", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      await prerender("/failing/a");
      const stored = store.entries();
      const document = await serveShellRequest(router, "/failing/a");

      redirecting.slot = true;
      tree.failing = true;
      expect(await prerender("/failing/a")).toMatchObject({
        ok: false,
        status: "render-failed",
        error: expect.any(Error),
      });
      expect(store.entries()).toEqual(stored);
      expect((await serveShellRequest(router, "/failing/a")).flight).toBe(
        document.flight,
      );
    });

    it("a redirect outranks a notFound(): skipped-redirect, and no 'removed' marker is stored", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      await prerender("/gone/a");
      const stored = store.entries();

      redirecting.slot = true;
      tree.gone = true;
      expect(await prerender("/gone/a")).toMatchObject({
        ok: false,
        status: "skipped-redirect",
      });
      // The marker a notFound() alone would have stored is not written.
      expect(store.entries()).toEqual(stored);
      expect((await serveShellRequest(router, "/gone/a")).response.status).toBe(
        200,
      );
    });
  });
});
