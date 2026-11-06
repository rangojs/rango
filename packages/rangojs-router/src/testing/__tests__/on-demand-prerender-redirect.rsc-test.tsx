/**
 * A refresh whose render answers `redirect()` (docs/design/ondemand-prerender.md,
 * "A Redirecting Refresh"), through the public testing primitives:
 * `router.prerender()` runs the real requestless producer, and
 * `serveShellRequest` serves the page through the production request handler,
 * as a document request and as the client navigation the browser sends.
 *
 * The owner's decision: a redirect during a refresh's render stores nothing,
 * neither the redirect nor a "removed" marker, because a redirect can depend on
 * the request (a session, an auth check) and so does not show the page is gone.
 * The page stored before keeps serving and revalidates on its own schedule. The
 * result is `skipped-redirect`, distinct from `render-failed` (a crash) and from
 * a stored outcome, the way a request-dependent render is already reported as
 * `skipped-personalized`.
 *
 * Every handler kind that can redirect is a case here: the route handler, a
 * layout handler, a parallel-slot handler, a `Passthrough` build handler, and a
 * handler streamed behind `loading()`.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createMemoryPrerenderStore } from "../index.js";
import {
  createRouter,
  Passthrough,
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import type { MemoryPrerenderStore } from "../../prerender/index.js";

/** The handler kinds the cases below redirect from. */
type RedirectFrom = "route" | "layout" | "slot" | "passthrough" | "loading";

/**
 * The kinds whose render redirects right now. Kept while a case serves, so the
 * page a refresh stored proves it answers and not a fresh render (a live render
 * would redirect).
 */
const redirecting = new Set<RedirectFrom>();

/** Producer renders per route, so a served page names the render it came from. */
const renders = { route: 0, layout: 0, slot: 0, passthrough: 0, loading: 0 };

function stamp(kind: RedirectFrom): string {
  return `${kind}-render-${renders[kind]}`;
}

function Page(
  kind: RedirectFrom,
  ctx: { params: { slug: string } },
): React.ReactNode {
  // Counted after the redirect, so a redirecting refresh does not look like a
  // render: the stamp a served page carries names the render that produced it.
  if (redirecting.has(kind)) throw redirect("/login");
  renders[kind] += 1;
  return <p data-testid={`od-${kind}`}>{stamp(kind)}</p>;
}

// One route per kind: a layout and a slot are shared by all of them, and each
// redirects only while its own case runs (the file's cases are sequential).
const RouteDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => Page("route", ctx),
  { onDemand: { ttl: 3600, tags: ["od-route"] } },
);

const LayoutDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => Page("layout", ctx),
  { onDemand: true },
);

const SlotDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => Page("slot", ctx),
  { onDemand: true },
);

const PassthroughDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => Page("passthrough", ctx),
  { onDemand: true },
);

const LoadingDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => Page("loading", ctx),
  { onDemand: true },
);

/** A child that answers a redirect, beside another that fails. */
async function Redirecting(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login");
}
async function Broken(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw new Error("upstream 500");
}

// A redirect thrown by a child, beside a failure: Flight reports both, in the
// order the tree lists them, so the failure decides whichever order that is.
const MixedDef = Prerender<{ slug: string }>(
  async () => [],
  async () => (
    <div>
      <Redirecting />
      <Broken />
    </div>
  ),
  { onDemand: true },
);

function makeRouter(store: MemoryPrerenderStore) {
  return createRouter({ prerender: { store } }).routes(
    urls(({ path, layout, parallel, loading }) => [
      layout(
        (ctx) => {
          if (redirecting.has("layout")) throw redirect("/login");
          return <main>{`layout:${ctx.params.slug}`}</main>;
        },
        () => [
          parallel({
            "@aside": (ctx) => {
              if (redirecting.has("slot")) throw redirect("/login");
              return <aside>{`aside:${ctx.params.slug}`}</aside>;
            },
          }),
          path("/od-route/:slug", RouteDef, { name: "odRoute" }),
          path("/od-layout/:slug", LayoutDef, { name: "odLayout" }),
          path("/od-slot/:slug", SlotDef, { name: "odSlot" }),
          path(
            "/od-passthrough/:slug",
            Passthrough(PassthroughDef, async (ctx) => (
              <p data-testid="od-passthrough-live">{`live:${ctx.params.slug}`}</p>
            )),
            { name: "odPassthrough" },
          ),
          path("/od-loading/:slug", LoadingDef, { name: "odLoading" }, () => [
            loading(<p>Loading</p>),
          ]),
          path("/od-mixed/:slug", MixedDef, { name: "odMixed" }, () => [
            loading(<p>Loading</p>),
          ]),
        ],
      ),
    ]),
  );
}

const cases: ReadonlyArray<{
  kind: RedirectFrom;
  path: string;
  routeName: string;
}> = [
  { kind: "route", path: "/od-route/a", routeName: "odRoute" },
  { kind: "layout", path: "/od-layout/a", routeName: "odLayout" },
  { kind: "slot", path: "/od-slot/a", routeName: "odSlot" },
  {
    kind: "passthrough",
    path: "/od-passthrough/a",
    routeName: "odPassthrough",
  },
  { kind: "loading", path: "/od-loading/a", routeName: "odLoading" },
];

describe("on-demand prerender: a redirecting refresh", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    redirecting.clear();
    for (const kind of Object.keys(renders) as RedirectFrom[]) {
      renders[kind] = 0;
    }
  });

  for (const { kind, path, routeName } of cases) {
    describe(kind, () => {
      it("stores nothing and the page stored before keeps serving to a document request and to a client navigation", async () => {
        const router = makeRouter(store);
        const prerender = router.prerender({ env: {} });

        expect(await prerender(path)).toMatchObject({
          ok: true,
          status: "rendered",
        });
        const stored = JSON.stringify(store.entries());
        expect(store.size).toBe(1);

        // The render redirects now. The refresh writes neither the redirect
        // nor a "removed" marker: the entry is byte for byte what it was.
        redirecting.add(kind);
        const result = await prerender(path);
        expect(result).toEqual({
          ok: false,
          path: "on-demand",
          status: "skipped-redirect",
          target: path,
          routeName,
        });
        expect(JSON.stringify(store.entries())).toBe(stored);

        // The stored page answers, though a live render would redirect.
        const document = await serveShellRequest(router, path);
        expect(document.response.status).toBe(200);
        expect(document.flight).toContain(stamp(kind));
        const navigation = await serveShellRequest(router, path, {
          partial: true,
        });
        expect(navigation.response.status).toBe(200);
        expect(navigation.flight).toContain(stamp(kind));

        // A refresh that renders again replaces it.
        redirecting.delete(kind);
        expect(await prerender(path)).toMatchObject({
          ok: true,
          status: "rendered",
        });
        expect((await serveShellRequest(router, path)).flight).toContain(
          stamp(kind),
        );
      });
    });
  }

  it("a Passthrough route's redirecting refresh leaves the stored page to answer, not the live handler", async () => {
    const router = makeRouter(store);
    const prerender = router.prerender({ env: {} });
    const path = "/od-passthrough/p";

    await prerender(path);
    redirecting.add("passthrough");
    expect(await prerender(path)).toMatchObject({
      status: "skipped-redirect",
    });

    const document = await serveShellRequest(router, path);
    expect(document.flight).toContain(stamp("passthrough"));
    expect(document.flight).not.toContain("live:p");
  });

  it("markStale(tags) then an onlyIfStale refresh renders the page again", async () => {
    const router = makeRouter(store);
    const prerender = router.prerender({ env: {} });
    const path = "/od-route/stale";

    await prerender(path);
    redirecting.add("route");
    expect(await prerender(path)).toMatchObject({
      status: "skipped-redirect",
    });
    redirecting.delete("route");

    // The stored entry is still fresh: the sweep leaves it alone.
    expect(await prerender(path, { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "already-fresh",
    });

    // markStale() reaches it: the sweep renders it again.
    await prerender.markStale(["od-route"]);
    expect(await prerender(path, { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "rendered",
    });
  });

  it("a render that redirects and also fails some other way stays render-failed", async () => {
    const router = makeRouter(store);
    const prerender = router.prerender({ env: {} });
    const path = "/od-mixed/x";

    await prerender("/od-route/x");
    const stored = JSON.stringify(store.entries());

    // Flight collects the redirect thrown by one child and the failure thrown
    // by another; the failure decides, so a redirect never reports a crash as
    // a skip (the notFound() rule, extended).
    const result = await prerender(path);
    expect(result).toMatchObject({ ok: false, status: "render-failed" });
    expect((result as { error: Error }).error.message).toBe("upstream 500");
    expect(JSON.stringify(store.entries())).toBe(stored);
  });

  it("a redirecting refresh of a param with no stored page stores nothing either", async () => {
    const router = makeRouter(store);
    const prerender = router.prerender({ env: {} });

    redirecting.add("route");
    expect(await prerender("/od-route/cold")).toMatchObject({
      ok: false,
      status: "skipped-redirect",
    });
    expect(store.size).toBe(0);
  });
});
