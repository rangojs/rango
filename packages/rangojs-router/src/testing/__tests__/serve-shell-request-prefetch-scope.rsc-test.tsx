/**
 * The prefetch scope a client navigation's response carries, through a public
 * primitive (issue #1007): a response for a route an intercept targets is
 * `x-rsc-prefetch-scope: source` whether or not the intercept applied from
 * this source, so the browser never stores the full page a non-matching
 * source got in the slot every source reuses. A route no intercept targets
 * carries no scope header (the shared slot) and keeps its prefetch
 * `cache-control`.
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
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

// An unprefixed name inside a named include is stored as written ("item")
// while the route matches as "shop.item": resolution reaches it only through
// the match's localRouteName (match-api.ts).
const shop = urls(({ path, layout, intercept }) => [
  layout(
    () => <section>shop</section>,
    () => [
      path("/", () => <ul>shop</ul>, { name: "index" }),
      path("/item/:id", () => <article>shop item</article>, { name: "item" }),
      intercept("@modal", "item", () => <dialog>shop modal</dialog>, {
        when: ({ from }) => from.url.pathname === "/shop",
      }),
    ],
  ),
]);

const router = createRouter({ prefetchCacheTTL: 60 }).routes(
  urls(({ path, layout, include, intercept }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/", () => <ul>home</ul>, { name: "home" }),
        path("/elsewhere", () => <p>elsewhere</p>, { name: "elsewhere" }),
        path("/item/:id", () => <article>item</article>, { name: "item" }),
        path("/plain/:id", () => <article>plain</article>, { name: "plain" }),
        include("/shop", shop, { name: "shop" }),
        intercept("@modal", ".item", () => <dialog>modal</dialog>, {
          when: ({ from }) => from.url.pathname === "/",
        }),
      ],
    ),
  ]),
);

async function prefetch(url: string, from: string) {
  const { response, flight } = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from },
    headers: { "X-Rango-Prefetch": "1" },
  });
  return {
    modal: flight?.includes("modal") ?? false,
    scope: response.headers.get("x-rsc-prefetch-scope"),
    cacheControl: response.headers.get("cache-control"),
  };
}

beforeEach(() => resetShellTestState());

describe("x-rsc-prefetch-scope on a client navigation", () => {
  it("is source when the intercept applies from the source", async () => {
    expect(await prefetch("/item/1", "/")).toEqual({
      modal: true,
      scope: "source",
      cacheControl: null,
    });
  });

  it("is source when the intercept does not apply from the source", async () => {
    expect(await prefetch("/item/1", "/elsewhere")).toEqual({
      modal: false,
      scope: "source",
      cacheControl: null,
    });
  });

  it("is source for an include-scoped target whose intercept is stored under its local name", async () => {
    expect(await prefetch("/shop/item/1", "/shop")).toEqual({
      modal: true,
      scope: "source",
      cacheControl: null,
    });
    expect(await prefetch("/shop/item/1", "/elsewhere")).toEqual({
      modal: false,
      scope: "source",
      cacheControl: null,
    });
  });

  it("is absent for a route no intercept targets, from any source", async () => {
    for (const from of ["/", "/elsewhere"]) {
      const result = await prefetch("/plain/1", from);
      expect(result.scope).toBeNull();
      expect(result.cacheControl).toMatch(/max-age=/);
    }
  });
});
