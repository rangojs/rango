/**
 * A `{ ...ctx }` copy of a handler's ctx carries what a copy of the request's
 * one does, for every handler kind that gets its own ctx: a layout, a
 * parallel slot, an intercept's handler and its layout, at request time and
 * at build time.
 *
 * The segment a push files under rides the object (`withSegmentScope`), and a
 * prototype child exposes only its own fields to a spread, so the fields the
 * handler's ctx inherits have to be forwarded onto it. A copy that drops
 * `params`, `url`, `get` or the `"use cache"` taint symbol is a ctx a
 * consumer passes on to a cached function that then keys and behaves as if it
 * were called outside the request.
 *
 * The build pass is the case a getter breaks: a Prerender ctx's `request`,
 * `env`, `res` and `headers` throw, so forwarding must copy the descriptors
 * without reading them.
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
import { Prerender } from "../../prerender.js";
import { createRouter, urls, type HandlerContext } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import {
  CachedCrumbs,
  cachedCrumb,
  cachedCrumbRuns,
} from "./fixtures/streamed-handle-owner-data.js";

type Copy = Record<string, any>;

const copies: Record<string, Copy> = {};

/** A route, a layout, a slot and a route with a slot, each spreading its ctx. */
function copyRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path(
            "/copy-route/:id",
            (ctx) => {
              copies.route = { ...ctx };
              return <p>route</p>;
            },
            { name: "copyRoute" },
          ),
          layout(
            (ctx) => {
              copies.layout = { ...ctx };
              return <div>layout</div>;
            },
            () => [
              path("/copy-layout/:id", () => <p>page</p>, {
                name: "copyLayout",
              }),
            ],
          ),
          layout(
            () => <section>frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => {
                  copies.slot = { ...ctx };
                  return <aside>panel</aside>;
                },
              }),
              path("/copy-slot/:id", () => <p>page</p>, { name: "copySlot" }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** An intercept handler and its layout, each spreading its ctx. */
function interceptCopyRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loading }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            (ctx) => {
              copies.intercept = { ...ctx };
              return <dialog>modal</dialog>;
            },
            () => [
              layout((ctx) => {
                copies.interceptLayout = { ...ctx };
                return <section>frame</section>;
              }),
              loading(<p>modal-loading</p>),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** The public fields a copy carries, and the request's values for them. */
function describeCopy(name: string) {
  const copy = copies[name]!;
  return {
    keys: Object.keys(copy).filter((key) => key[0] !== "_"),
    params: copy.params,
    url: copy.url instanceof URL,
    searchParams: copy.searchParams instanceof URLSearchParams,
    get: typeof copy.get,
    set: typeof copy.set,
    env: typeof copy.env,
    headers: typeof copy.headers,
    reverse: typeof copy.reverse,
    brand: Object.getOwnPropertySymbols(copy).length,
    theme: Object.hasOwn(copy, "theme"),
  };
}

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

async function serve(url: string, router = copyRouter()) {
  await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
}

beforeEach(async () => {
  await resetShellTestState();
  for (const key of Object.keys(copies)) delete copies[key];
});

describe("a copy of a handler's ctx carries the request's fields", () => {
  it("a layout's and a slot's copy match the route's, field for field", async () => {
    await serve("/copy-route/7");
    await serve("/copy-layout/7");
    await serve("/copy-slot/7");

    const route = describeCopy("route");
    expect(route.params).toEqual({ id: "7" });
    expect(route.get).toBe("function");
    expect(route.brand).toBeGreaterThan(0);
    for (const name of ["layout", "slot"]) {
      expect(describeCopy(name)).toEqual(route);
    }
  });

  it("an intercept handler's and its layout's copy carry them too", async () => {
    const router = interceptCopyRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const { metadata } = await deserializeResult<{
      metadata: { matched: string[] };
    }>(list.flight!);
    await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: metadata.matched },
    });

    const handler = describeCopy("intercept");
    expect(handler.params).toEqual({ id: "1" });
    expect(handler.get).toBe("function");
    expect(handler.brand).toBeGreaterThan(0);
    expect(describeCopy("interceptLayout")).toEqual(handler);
  });
});

describe('a copy handed to a "use cache" call', () => {
  it("a layout's copy is tainted, so the call is cached and pushes under the layout", async () => {
    const router = createRouter({}).routes(
      urls(({ path, layout }) => [
        layout(
          async (ctx) => {
            const crumb = await cachedCrumb({ ...ctx }, "layout");
            ctx.set("crumb", crumb);
            return <main>{crumb}</main>;
          },
          () => [
            path("/cached-copy", () => <p>page</p>, { name: "cachedCopy" }),
          ],
        ),
      ]),
    );
    const cacheStore = new MemorySegmentCacheStore();
    const runs = cachedCrumbRuns.count;
    const first = await serveShellRequest(router, "/cached-copy", {
      cacheStore,
    });
    const second = await serveShellRequest(router, "/cached-copy", {
      cacheStore,
    });
    expect(cachedCrumbRuns.count - runs).toBe(1);
    const matched = await matchedOf(first.flight);
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    const { hydration } = (await first.readHandles())!;
    expect(hydration[CachedCrumbs.$$id]).toEqual({ [layout]: ["layout"] });
    expect(second.flight).toContain("layout");
  });
});

type InternalRouter = {
  matchForPrerender: (
    pathname: string,
    params: Record<string, string>,
  ) => Promise<unknown>;
};

describe("a handler's ctx at build time", () => {
  it("an intercept's carries the Prerender ctx's fields, its throwing getters included", async () => {
    const shop = urls(({ path }) => [
      path(
        "/item/:id",
        Prerender(
          async () => [{ id: "1" }],
          () => "item page",
        ),
        { name: "item" },
      ),
    ]);
    const router = createRouter({}).routes(
      urls(({ layout, intercept, include }) => [
        layout(
          () => "shell",
          () => [
            intercept("@modal", "shop.item", (ctx: HandlerContext) => {
              copies.build = ctx as unknown as Copy;
              return "modal body";
            }),
            include("/shop", shop, { name: "shop" }),
          ],
        ),
      ]),
    );
    const baked = await (router as unknown as InternalRouter).matchForPrerender(
      "/shop/item/1",
      { id: "1" },
    );
    expect(baked).not.toBeNull();

    // Forwarding the build ctx's fields must not read them: request, env, res
    // and headers throw on a Prerender ctx. The intercept's ctx keeps them.
    const ctx = copies.build!;
    expect(ctx.params).toEqual({ id: "1" });
    expect(ctx.pathname).toBe("/shop/item/1");
    expect(typeof ctx.get).toBe("function");
    expect(typeof ctx.reverse).toBe("function");
    expect(ctx.use).toBeTypeOf("function");
    expect(() => ctx.request).toThrow(/not available during pre-rendering/);
  });
});
