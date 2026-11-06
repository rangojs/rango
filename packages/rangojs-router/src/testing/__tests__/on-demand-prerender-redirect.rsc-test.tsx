/**
 * A redirecting on-demand refresh stores nothing and keeps the page, through
 * the public testing primitives: `router.prerender()` runs the real
 * requestless producer and `serveShellRequest` serves the route through the
 * production request handler.
 *
 * A redirect can depend on the request (a session or auth check), so a refresh
 * that answers one does not show the page is gone. The result is
 * `skipped-redirect`, nothing is written (neither the redirect nor a "removed"
 * marker), and the entry stored before keeps serving to documents and client
 * navigations and revalidates on its own ttl and tags. Every handler kind that
 * can redirect is covered: the route handler, a layout handler, a parallel-slot
 * handler, a `Passthrough` route's build handler, and a handler streaming behind
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
import { createMemoryPrerenderStore } from "../index.js";
import {
  createRouter,
  loading,
  layout,
  notFound,
  parallel,
  Passthrough,
  Prerender,
  redirect,
  urls,
  type Handler,
  type HandlerContext,
} from "../../index.rsc.js";
import { PrerenderError } from "../../prerender/create-prerender-trigger.js";
import type {
  MemoryPrerenderStore,
  PrerenderResult,
} from "../../prerender/index.js";

/** Which kind answers `redirect()` on its next render. */
const redirecting = {
  route: false,
  layout: false,
  slot: false,
  passthrough: false,
  stream: false,
};
/** Renders per handler, so a served page names the render that produced it. */
const renders = {
  route: 0,
  layoutPage: 0,
  slotPage: 0,
  pass: 0,
  stream: 0,
  live: 0,
};

/** Set to make the redirect target off-host (`{ external: true }`). */
let externalRedirect = false;

function answerRedirect(redirects: boolean): void {
  if (!redirects) return;
  throw externalRedirect
    ? redirect("https://accounts.example.com/oauth", { external: true })
    : redirect("/login");
}

const RouteDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.route += 1;
    answerRedirect(redirecting.route);
    return <h1>{`route:${ctx.params.slug}:render-${renders.route}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`od:${params.slug}`] } },
);

const LayoutHandler = async (): Promise<React.ReactNode> => {
  answerRedirect(redirecting.layout);
  return <header>chrome</header>;
};

const LayoutPage = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.layoutPage += 1;
    return <h1>{`layout:${ctx.params.slug}:render-${renders.layoutPage}`}</h1>;
  },
  { onDemand: true },
);

const SlotHandler = async (): Promise<React.ReactNode> => {
  answerRedirect(redirecting.slot);
  return <aside>aside</aside>;
};

const SlotPage = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.slotPage += 1;
    return <h1>{`slot:${ctx.params.slug}:render-${renders.slotPage}`}</h1>;
  },
  { onDemand: true },
);

const PassBuildDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.pass += 1;
    answerRedirect(redirecting.passthrough);
    return <h1>{`pass:${ctx.params.slug}:render-${renders.pass}`}</h1>;
  },
  { onDemand: true },
);

const PassLive: Handler<{ slug: string }> = async (
  ctx: HandlerContext<{ slug: string }>,
) => {
  renders.live += 1;
  return <h1>{`pass-live:${ctx.params.slug}`}</h1>;
};

const PassDef = Passthrough(PassBuildDef, PassLive);

const StreamDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    renders.stream += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    answerRedirect(redirecting.stream);
    return <h1>{`stream:${ctx.params.slug}:render-${renders.stream}`}</h1>;
  },
  { onDemand: true },
);

/** A redirect from a component the handler returns, not from a handler. */
async function DeepRedirect(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login");
}

async function DeepFailure(): Promise<never> {
  await Promise.resolve();
  throw new Error("upstream 500");
}

async function DeepNotFound(): Promise<never> {
  await Promise.resolve();
  notFound();
}

const DeepDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div>
      <h1>{`deep:${ctx.params.slug}`}</h1>
      <DeepRedirect />
    </div>
  ),
  { onDemand: true },
);

const DeepBothDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div>
      <h1>{`deep-both:${ctx.params.slug}`}</h1>
      <DeepRedirect />
      <DeepFailure />
    </div>
  ),
  { onDemand: true },
);

const DeepBothReversedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div>
      <h1>{`deep-both-rev:${ctx.params.slug}`}</h1>
      <DeepFailure />
      <DeepRedirect />
    </div>
  ),
  { onDemand: true },
);

const DeepNotFoundThenRedirectDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div>
      <h1>{`deep-gone:${ctx.params.slug}`}</h1>
      <DeepNotFound />
      <DeepRedirect />
    </div>
  ),
  { onDemand: true },
);

const DeepRedirectThenNotFoundDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => (
    <div>
      <h1>{`deep-gone-rev:${ctx.params.slug}`}</h1>
      <DeepRedirect />
      <DeepNotFound />
    </div>
  ),
  { onDemand: true },
);

function makeRouter(
  prerender: { store: MemoryPrerenderStore },
  options: { basename?: string } = {},
) {
  return createRouter({ ...options, prerender }).routes(
    urls(({ path }) => [
      path("/route/:slug", RouteDef, { name: "route" }),
      layout(LayoutHandler, () => [
        path("/layout/:slug", LayoutPage, { name: "layoutPage" }),
      ]),
      layout(
        () => <main>shell</main>,
        () => [
          parallel({ "@aside": SlotHandler }),
          path("/slot/:slug", SlotPage, { name: "slotPage" }),
        ],
      ),
      path("/pass/:slug", PassDef, { name: "pass" }),
      path("/stream/:slug", StreamDef, { name: "stream" }, () => [
        loading(<p>loading</p>),
      ]),
      path("/deep/:slug", DeepDef, { name: "deep" }),
      path("/deep-both/:slug", DeepBothDef, { name: "deepBoth" }),
      path("/deep-both-rev/:slug", DeepBothReversedDef, {
        name: "deepBothRev",
      }),
      path("/deep-gone/:slug", DeepNotFoundThenRedirectDef, {
        name: "deepGone",
      }),
      path("/deep-gone-rev/:slug", DeepRedirectThenNotFoundDef, {
        name: "deepGoneRev",
      }),
    ]),
  );
}

type TestRouter = ReturnType<typeof makeRouter>;

/** The keys the store holds, so a write is visible without reading payloads. */
function storedKeys(store: MemoryPrerenderStore): string[] {
  return store.entries().map(([key]) => key);
}

/** The `render-N` stamp of the page a request served. */
function servedStamp(flight: string | undefined): string {
  const stamp = flight?.match(
    /(?:route|layout|slot|pass|stream):[^"]*render-\d+/,
  );
  expect(stamp, `no render stamp in the served payload: ${flight}`).not.toBe(
    null,
  );
  return stamp![0]!;
}

const KINDS = ["route", "layout", "slot", "passthrough", "stream"] as const;
type Kind = (typeof KINDS)[number];

const KIND_URLS: Record<Kind, string> = {
  route: "/route/a",
  layout: "/layout/a",
  slot: "/slot/a",
  passthrough: "/pass/a",
  stream: "/stream/a",
};

/**
 * Store a page for the kind, make the kind's handler redirect, and check the
 * refresh against what a visitor gets afterwards.
 */
async function expectRedirectingRefreshKeepsThePage(
  router: TestRouter,
  store: MemoryPrerenderStore,
  kind: Kind,
): Promise<void> {
  const url = KIND_URLS[kind];
  const prerender = router.prerender({ env: {} });

  const first = await prerender(url);
  expect(first).toMatchObject({ ok: true, status: "rendered" });
  const before = servedStamp((await serveShellRequest(router, url)).flight);
  const keysBefore = storedKeys(store);
  expect(keysBefore).toHaveLength(1);

  redirecting[kind] = true;
  const skipped = await prerender(url);
  expect(skipped).toMatchObject({
    ok: false,
    path: "on-demand",
    status: "skipped-redirect",
    target: url,
  });
  // Nothing written: the page is still the one entry, not a marker, not a redirect.
  expect(storedKeys(store)).toEqual(keysBefore);
  expect(store.entries().every(([, entry]) => entry.removed !== true)).toBe(
    true,
  );

  // The page stored before keeps serving, to a document and to a navigation.
  const document = await serveShellRequest(router, url);
  expect(document.response.status).toBe(200);
  expect(servedStamp(document.flight)).toBe(before);
  const navigation = await serveShellRequest(router, url, {
    partial: { from: "/" },
  });
  expect(navigation.response.status).toBe(200);
  expect(servedStamp(navigation.flight)).toBe(before);

  // A refresh that renders a page replaces the entry.
  redirecting[kind] = false;
  const rendered = await prerender(url);
  expect(rendered).toMatchObject({ ok: true, status: "rendered" });
  expect(servedStamp((await serveShellRequest(router, url)).flight)).not.toBe(
    before,
  );
}

describe("on-demand prerender: a redirecting refresh stores nothing", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    for (const key of Object.keys(redirecting) as (keyof typeof redirecting)[])
      redirecting[key] = false;
    for (const key of Object.keys(renders) as (keyof typeof renders)[])
      renders[key] = 0;
    externalRedirect = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const kind of KINDS) {
    it(`the ${kind} handler's redirect is skipped-redirect, and the stored page keeps serving`, async () => {
      await expectRedirectingRefreshKeepsThePage(
        makeRouter({ store }),
        store,
        kind,
      );
    });
  }

  it("a layout handler's redirect never renders the page below it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/layout/a");
    expect(renders.layoutPage).toBe(1);

    redirecting.layout = true;
    expect(await prerender("/layout/a")).toMatchObject({
      ok: false,
      status: "skipped-redirect",
    });
    expect(renders.layoutPage).toBe(1);
  });

  it("a Passthrough route's build handler redirect writes nothing, so its live handler still answers", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    redirecting.passthrough = true;
    expect(await prerender("/pass/fresh")).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "skipped-redirect",
    });
    expect(store.size).toBe(0);

    const served = await serveShellRequest(router, "/pass/fresh");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("pass-live:fresh");
    expect(renders.live).toBe(1);
  });

  it("a redirect thrown by a deep async component is skipped-redirect too", async () => {
    const router = makeRouter({ store });
    expect(await router.prerender({ env: {} })("/deep/a")).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "skipped-redirect",
      target: "/deep/a",
      routeName: "deep",
    });
    expect(store.size).toBe(0);
  });

  it("markStale(tags) then an onlyIfStale refresh renders it again, and keeps the page when it redirects", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    await prerender("/route/a");
    const before = servedStamp(
      (await serveShellRequest(router, "/route/a")).flight,
    );
    // Fresh: a sweep renders nothing.
    expect(await prerender("/route/a", { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "already-fresh",
    });

    await prerender.markStale(["od:a"]);
    redirecting.route = true;
    expect(await prerender("/route/a", { onlyIfStale: true })).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "skipped-redirect",
    });
    // The stale entry still serves: a redirect stores nothing, not a recheck marker.
    expect(
      servedStamp((await serveShellRequest(router, "/route/a")).flight),
    ).toBe(before);

    // The entry is still stale, so the next sweep renders it again and replaces it.
    redirecting.route = false;
    expect(await prerender("/route/a", { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "rendered",
    });
    expect(
      servedStamp((await serveShellRequest(router, "/route/a")).flight),
    ).not.toBe(before);
  });

  it("a render that redirects and fails another way stays render-failed, in either order", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    // A page stored before is kept by the failure, not replaced and not removed.
    await prerender("/route/a");
    const before = servedStamp(
      (await serveShellRequest(router, "/route/a")).flight,
    );

    for (const url of ["/deep-both/a", "/deep-both-rev/a"]) {
      const failed = await prerender(url);
      expect(failed).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "render-failed",
        target: url,
      });
      expect((failed as Extract<PrerenderResult, { ok: false }>).error).toEqual(
        new Error("upstream 500"),
      );
    }
    expect(store.size).toBe(1);
    expect(
      servedStamp((await serveShellRequest(router, "/route/a")).flight),
    ).toBe(before);
  });

  it("a redirect beside a notFound() stores nothing: neither removes the page", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    for (const url of ["/deep-gone/a", "/deep-gone-rev/a"]) {
      expect(await prerender(url)).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
        target: url,
      });
    }
    expect(store.size).toBe(0);
  });

  it("throwOnError rejects a redirecting refresh, naming skipped-redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/route/a");

    redirecting.route = true;
    await expect(
      prerender("/route/a", { throwOnError: true }),
    ).rejects.toBeInstanceOf(PrerenderError);
    await expect(prerender("/route/a", { throwOnError: true })).rejects.toThrow(
      'router.prerender("/route/a") failed: skipped-redirect',
    );
  });

  it('a redirecting refresh leaves a "removed" marker: it does not bring a removed page back', async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/route/a");

    redirecting.route = true;
    await prerender.remove("/route/a");
    expect(store.entries()[0]?.[1].removed).toBe(true);
    expect(await prerender("/route/a")).toMatchObject({
      ok: false,
      status: "skipped-redirect",
    });

    expect(store.entries()[0]?.[1].removed).toBe(true);
    expect((await serveShellRequest(router, "/route/a")).response.status).toBe(
      404,
    );
  });

  it("a basename and an off-host redirect leave the page too", async () => {
    const router = makeRouter({ store }, { basename: "/app" });
    const prerender = router.prerender({ env: {} });
    const url = "/app/route/a";
    await prerender(url);
    const before = servedStamp((await serveShellRequest(router, url)).flight);

    redirecting.route = true;
    for (const external of [false, true]) {
      externalRedirect = external;
      expect(await prerender(url)).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
        target: url,
      });
      expect(servedStamp((await serveShellRequest(router, url)).flight)).toBe(
        before,
      );
    }
    // The entry itself is untouched: same key, same ttl and tags.
    expect(store.size).toBe(1);
    expect(store.entries()[0]?.[1].meta).toMatchObject({
      ttl: 3600,
      tags: ["od:a"],
    });
  });

  it("many() reports one result per target and does not stop at a redirecting one", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    redirecting.route = true;

    const results = await prerender.many(["/route/a", "/route/b"]);
    expect(results.map((result) => [result.ok, result.status])).toEqual([
      [false, "skipped-redirect"],
      [false, "skipped-redirect"],
    ]);
    expect(store.size).toBe(0);
  });
});
