/**
 * A parallel slot handler's returned or thrown `redirect()` short-circuits as
 * a route's or a layout's does, through the public testing primitives.
 *
 * A slot handler's result never passed through `handleHandlerResult`
 * (`resolveParallelSlotComponent`), so a returned Response was used as the
 * slot's component: a document request answered 200 with the Response
 * rendered into the RSC stream, a client navigation rendered it into the
 * partial payload, and an on-demand prerender refresh failed with Flight's
 * "Only plain objects ... can be passed to Client Components" instead of the
 * Response a route handler reports. A thrown Response already short-circuited;
 * a synchronous return under the slot's `loading()` did not.
 *
 * What must hold, on every lane a visitor reaches the slot through: the
 * document answers the redirect's status with its Location (basename-prefixed,
 * an `external: true` target kept), the client navigation answers the soft
 * redirect the browser follows (204 + `X-RSC-Redirect`), and a redirect is
 * never stored: a cache() entry stays unwritten, and an on-demand refresh is
 * `render-failed` with the Response as its error, leaving the page stored
 * before serving until a later refresh replaces it.
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
  cache,
  createRouter,
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { PrerenderResult } from "../../prerender/index.js";

/** What the slot handler does on the next request. */
type SlotMode = "page" | "return" | "throw" | "external";

let slotMode: SlotMode = "page";
let slotRuns = 0;

function slotHandler(): React.ReactNode {
  slotRuns += 1;
  switch (slotMode) {
    case "return":
      return redirect(
        "/slot-redirect/target",
        302,
      ) as unknown as React.ReactNode;
    case "throw":
      throw redirect("/slot-redirect/target", 302);
    case "external":
      return redirect("https://accounts.example.com/login", {
        external: true,
      }) as unknown as React.ReactNode;
    default:
      return <aside data-testid="slot">aside</aside>;
  }
}

function makeRouter(options: { basename?: string } = {}) {
  const router = createRouter({
    ...options,
    prerender: { store: createMemoryPrerenderStore() },
  }).routes(
    urls(({ path, layout, parallel, loading }) => [
      // The reported case: a layout's slot returns a redirect.
      layout(
        () => <main>shell</main>,
        () => [
          parallel({ "@aside": () => slotHandler() }),
          path("/slot-redirect", () => <p>page</p>, { name: "slotPage" }),
          path(
            "/slot-redirect/loading",
            () => <p>loading page</p>,
            { name: "slotLoading" },
            () => [loading(<p>loading</p>)],
          ),
          path("/slot-redirect/target", () => <p>target</p>, {
            name: "slotTarget",
          }),
        ],
      ),
      // A redirect is never stored: a cache() boundary around the slot and
      // the page records nothing for it.
      cache({ ttl: 300 }, () => [
        layout(
          () => <main>cached shell</main>,
          () => [
            parallel({ "@aside": () => slotHandler() }),
            path("/slot-redirect/cached", () => <p>cached page</p>, {
              name: "slotCached",
            }),
          ],
        ),
      ]),
      // The on-demand page keeps serving the entry stored before a refresh
      // whose slot redirects.
      layout(
        () => <main>on-demand shell</main>,
        () => [
          parallel({ "@aside": () => slotHandler() }),
          path(
            "/slot-redirect/on-demand",
            Prerender(() => <p>on-demand body</p>, { onDemand: true }),
            { name: "slotOnDemand" },
          ),
        ],
      ),
    ]),
  );
  return router;
}

beforeEach(async () => {
  await resetShellTestState();
  slotMode = "page";
  slotRuns = 0;
});

describe("a slot handler's redirect", () => {
  it("a returned redirect answers the document as a 302 with its Location", async () => {
    const router = makeRouter();
    slotMode = "return";
    const result = await serveShellRequest(router, "/slot-redirect");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("Location")).toBe(
      "/slot-redirect/target",
    );
    // Nothing was rendered: the Response short-circuited before the tree.
    expect(result.flight).toBeUndefined();
    expect(result.body).toBe("");
  });

  it("a thrown redirect answers the document as a 302 with its Location", async () => {
    const router = makeRouter();
    slotMode = "throw";
    const result = await serveShellRequest(router, "/slot-redirect");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("Location")).toBe(
      "/slot-redirect/target",
    );
  });

  it("a synchronous return under the slot's loading() short-circuits too", async () => {
    const router = makeRouter();
    slotMode = "return";
    const result = await serveShellRequest(router, "/slot-redirect/loading");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("Location")).toBe(
      "/slot-redirect/target",
    );
    expect(result.flight).toBeUndefined();
  });

  it("a client navigation answers the soft redirect the browser follows", async () => {
    const router = makeRouter();
    slotMode = "return";
    const result = await serveShellRequest(router, "/slot-redirect", {
      partial: { from: "/" },
    });
    expect(result.response.status).toBe(204);
    expect(result.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/slot-redirect/target",
    );
    // The Response is not in the payload for the browser to render.
    expect(result.flight).toBeUndefined();
  });

  it("prefixes a root-relative Location with the basename", async () => {
    const router = makeRouter({ basename: "/app" });
    slotMode = "return";
    const result = await serveShellRequest(router, "/app/slot-redirect");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("Location")).toBe(
      "/app/slot-redirect/target",
    );
  });

  it("keeps an external redirect's off-host Location", async () => {
    const router = makeRouter();
    slotMode = "external";
    const result = await serveShellRequest(router, "/slot-redirect");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("Location")).toBe(
      "https://accounts.example.com/login",
    );
  });

  it("writes nothing to a cache() entry: the page is not stored as a redirect", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();

    slotMode = "return";
    const first = await serveShellRequest(router, "/slot-redirect/cached", {
      cacheStore,
    });
    const second = await serveShellRequest(router, "/slot-redirect/cached", {
      cacheStore,
    });
    expect(first.response.status).toBe(302);
    expect(second.response.status).toBe(302);
    expect(slotRuns).toBe(2);

    // The slot stops redirecting: the page renders, and its next request is
    // the HIT the redirecting requests did not store.
    slotMode = "page";
    const miss = await serveShellRequest(router, "/slot-redirect/cached", {
      cacheStore,
    });
    expect(miss.response.status).toBe(200);
    expect(slotRuns).toBe(3);
    const hit = await serveShellRequest(router, "/slot-redirect/cached", {
      cacheStore,
    });
    expect(hit.response.status).toBe(200);
    expect(slotRuns).toBe(3);
  });

  it("an on-demand refresh reports the redirect and keeps the page stored before", async () => {
    const router = makeRouter();
    const prerender = router.prerender({ env: {} });

    const warmed = await prerender("/slot-redirect/on-demand");
    expect(warmed).toMatchObject({ ok: true, status: "rendered" });
    const before = await serveShellRequest(router, "/slot-redirect/on-demand");
    expect(before.response.status).toBe(200);
    expect(before.body).toContain("on-demand body");

    slotMode = "return";
    const refresh = (await prerender("/slot-redirect/on-demand")) as Extract<
      PrerenderResult,
      { ok: false }
    >;
    expect(refresh.ok).toBe(false);
    expect(refresh.status).toBe("render-failed");
    // The redirect itself, not a Flight serialization error: the slot's
    // Response is thrown, as a route handler's is.
    expect(refresh.error).toBeInstanceOf(Response);
    const thrown = refresh.error as Response;
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("Location")).toBe("/slot-redirect/target");

    // The page stored before still serves; the refresh replaced nothing.
    const after = await serveShellRequest(router, "/slot-redirect/on-demand");
    expect(after.response.status).toBe(200);
    expect(after.body).toContain("on-demand body");

    // A later refresh with no redirect replaces it.
    slotMode = "page";
    const replaced = await prerender("/slot-redirect/on-demand");
    expect(replaced).toMatchObject({ ok: true, status: "rendered" });
  });
});
