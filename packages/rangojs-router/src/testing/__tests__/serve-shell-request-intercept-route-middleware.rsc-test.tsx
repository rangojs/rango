/**
 * An intercept has no middleware of its own: intercept() rejects
 * middleware() in its use() (and in its handler's .use), and the target
 * route's middleware runs for the modal on every pass, a cache() hit and a
 * Prerender() target included. Through the public serveShellRequest
 * primitive: a client navigation (`partial: { from }`) runs the production
 * match.
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
import {
  Prerender,
  createLoader,
  createRouter,
  createVar,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const Viewer = createVar<string>();

let runs: Record<string, number> = {};
const ran = (name: string): number => (runs[name] = (runs[name] ?? 0) + 1);
let deny = false;

const ViewerLoader = createLoader(async (ctx) => ({
  viewer: `viewer-${ctx.get(Viewer) ?? "unset"}`,
}));

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }],
  () => <article>item</article>,
);

/** The target route behind a runtime cache() or as a Prerender(). */
function makeRouter(target: "cache" | "prerender" = "cache") {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loader, middleware, cache }) => {
      const item = () =>
        path(
          "/item/:id",
          target === "prerender"
            ? PrerenderedItem
            : () => <article>item</article>,
          { name: "item" },
          () => [
            middleware(async (ctx, next) => {
              ran("route-middleware");
              if (deny) return new Response("denied", { status: 403 });
              ctx.set(Viewer, "from-route-middleware");
              await next();
            }),
          ],
        );
      return [
        layout(
          () => <main>shell</main>,
          () => [
            path("/list", () => <ul>list</ul>, { name: "list" }),
            target === "prerender"
              ? item()
              : cache({ ttl: 300 }, () => [item()]),
            intercept(
              "@modal",
              ".item",
              () => <dialog>{`modal-run-${ran("modal")}`}</dialog>,
              () => [loader(ViewerLoader)],
            ),
          ],
        ),
      ];
    }),
  );
}

beforeEach(async () => {
  await resetShellTestState();
  runs = {};
  deny = false;
});

describe("intercept() and middleware", () => {
  it("rejects middleware() in the intercept's use() when the routes are defined", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, intercept, middleware }) => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            () => <dialog>modal</dialog>,
            // @ts-expect-error middleware() is not an intercept use item
            () => [
              middleware(async (_ctx, next) => {
                await next();
              }),
            ],
          ),
        ]),
      ),
    ).toThrow(
      `middleware() is not valid inside intercept("@modal", ".item") use() (including the handler's .use): move it to the route's middleware() (it runs for the modal too) or into the loaders.`,
    );
  });

  it("runs the target route's middleware for the modal on a live pass and on a cache() hit", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const open = () =>
      serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list" },
      });

    const live = await open();
    const hit = await open();

    // The modal handler ran once: the second pass is a cache() hit.
    expect(runs.modal).toBe(1);
    expect(runs["route-middleware"]).toBe(2);
    for (const result of [live, hit]) {
      expect(result.flight).toContain("modal-run-1");
      expect(result.flight).toContain("viewer-from-route-middleware");
    }
  });

  it("runs the target route's middleware for the modal over a Prerender() target", async () => {
    const router = makeRouter("prerender");
    const cacheStore = new MemorySegmentCacheStore();
    const open = () =>
      serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list" },
      });

    const first = await open();
    const second = await open();

    // The bake rendered the modal; neither request ran its handler.
    expect(runs.modal).toBe(1);
    expect(runs["route-middleware"]).toBe(2);
    for (const result of [first, second]) {
      expect(result.flight).toContain("modal-run-1");
      expect(result.flight).toContain("viewer-from-route-middleware");
    }

    deny = true;
    const guarded = await open();
    expect(guarded.response.status).toBe(403);
    expect(guarded.flight ?? "").not.toContain("modal-run-1");
  });

  it("a route-middleware guard short-circuits the modal on a cache() hit", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const open = () =>
      serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list" },
      });

    await open();
    deny = true;
    const guarded = await open();

    expect(guarded.response.status).toBe(403);
    expect(guarded.flight ?? "").not.toContain("modal-run-1");
  });
});
