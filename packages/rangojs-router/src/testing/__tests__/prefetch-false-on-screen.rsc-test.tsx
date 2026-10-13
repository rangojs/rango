/**
 * `prefetch: false` skips a loader in a prefetch only when it is new to the
 * page. A loader already on screen is never deferred: when its revalidation
 * (its revalidate() or the default) re-runs it, it runs in the prefetch with
 * the rest of the destination; otherwise it is held. One case per loader
 * kind, through serveShellRequest prefetch requests
 * (docs/design/prefetch-false.md R14; defersLoader in
 * router/segment-resolution/prefetch-deferral.ts never defers a held id).
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
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { clientUrls } from "../../client-urls/client-urls.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const runs: Record<string, number> = {};
const count = (name: string): number => runs[name] ?? 0;

function counted(name: string) {
  return createLoader(async () => {
    runs[name] = count(name) + 1;
    return { value: `${name}-run-${runs[name]}` };
  });
}

const ProductLoader = counted("product");
const TeamLoader = counted("team");
const RuleLoader = counted("rule");
const DefaultLoader = counted("default");
const ModalLoader = counted("modal");

function Empty(): null {
  return null;
}

const shop = clientUrls(({ layout, path, loader, revalidate }) => [
  layout(Empty, () => [
    loader(RuleLoader, { prefetch: false }, () => [revalidate(() => true)]),
    loader(DefaultLoader, { prefetch: false }),
    path("/", Empty, { name: "index" }),
    path("/items/:id", Empty, { name: "item" }),
  ]),
]);

const router = createRouter({}).routes(
  urls(({ path, layout, loader, intercept, include, revalidate }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/", () => <p>home</p>, { name: "home" }),
        path(
          "/product/:slug",
          () => <article>product</article>,
          {
            name: "product",
          },
          () => [loader(ProductLoader, { prefetch: false })],
        ),
        layout(
          () => <section>team</section>,
          () => [
            loader(TeamLoader, { prefetch: false }, () => [
              revalidate(
                ({ currentParams, nextParams }) =>
                  currentParams.team !== nextParams.team,
              ),
            ]),
            path("/team/:team", () => <p>team</p>, { name: "team" }),
            path("/team/:team/members", () => <p>members</p>, {
              name: "members",
            }),
          ],
        ),
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/photo/:id", () => <article>photo</article>, { name: "photo" }),
        path("/photo-b/:id", () => <article>photo b</article>, {
          name: "photoB",
        }),
        intercept(
          "@modal",
          ".photo",
          () => <dialog>photo</dialog>,
          () => [loader(ModalLoader, { prefetch: false })],
        ),
        intercept(
          "@modal",
          ".photoB",
          () => <dialog>photo b</dialog>,
          () => [loader(ModalLoader, { prefetch: false })],
        ),
        include("/shop", shop, { name: "shop" }),
      ],
    ),
  ]),
);

function matchedOf(result: ServeShellRequestResult): string[] {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return JSON.parse(row!.slice(2)).metadata.matched;
}

const cacheStore = new MemorySegmentCacheStore();
const serve = (
  url: string,
  partial: { from: string; segments?: readonly string[]; prefetch?: boolean },
) => serveShellRequest(router, url, { cacheStore, partial });

/** The segment ids a page holds after a navigation to it; runs reset. */
async function standingOn(at: string, from = "/"): Promise<string[]> {
  const matched = matchedOf(await serve(at, { from }));
  for (const key of Object.keys(runs)) delete runs[key];
  return matched;
}

/** A prefetch of `to` from the page at `from`: what it deferred. */
async function prefetch(
  from: string,
  held: readonly string[],
  to: string,
): Promise<string[]> {
  const result = await serve(to, { from, segments: held, prefetch: true });
  return (await result.readDeferred()) ?? [];
}

beforeEach(async () => {
  for (const key of Object.keys(runs)) delete runs[key];
  await resetShellTestState();
});

describe("prefetch: false defers only a loader new to the page", () => {
  it("a route's own loader: on screen on a same-route param navigation, it runs; entering, it is deferred", async () => {
    const onA = await standingOn("/product/a");
    expect(await prefetch("/product/a", onA, "/product/b")).toEqual([]);
    expect(count("product")).toBe(1);

    const home = await standingOn("/");
    const deferred = await prefetch("/", home, "/product/a");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toContain(ProductLoader.$$id);
    expect(count("product")).toBe(0);
  });

  it("a server layout() loader: on screen, it runs when its revalidate() re-runs it and is held otherwise; entering, it is deferred", async () => {
    let held = await standingOn("/team/a");
    expect(await prefetch("/team/a", held, "/team/b")).toEqual([]);
    expect(count("team")).toBe(1);

    held = await standingOn("/team/a");
    expect(await prefetch("/team/a", held, "/team/a/members")).toEqual([]);
    expect(count("team")).toBe(0);

    const home = await standingOn("/");
    const deferred = await prefetch("/", home, "/team/a");
    expect(deferred.filter((id) => id.includes(TeamLoader.$$id))).toHaveLength(
      1,
    );
    expect(count("team")).toBe(0);
  });

  it("a clientUrls() layout() loader: between the layout's routes it runs when its revalidate() re-runs it and is held with no rule; entering, both are deferred", async () => {
    const held = await standingOn("/shop/items/a");
    expect(await prefetch("/shop/items/a", held, "/shop")).toEqual([]);
    expect({ rule: count("rule"), default: count("default") }).toEqual({
      rule: 1,
      default: 0,
    });

    const home = await standingOn("/");
    const deferred = await prefetch("/", home, "/shop");
    expect(
      [RuleLoader, DefaultLoader].map(
        (loader) => deferred.filter((id) => id.includes(loader.$$id)).length,
      ),
    ).toEqual([1, 1]);
    expect({ rule: count("rule"), default: count("default") }).toEqual({
      rule: 0,
      default: 0,
    });
  });

  it("an intercept() loader: with the modal open it runs when it revalidates; opening the modal, it is deferred", async () => {
    const list = await standingOn("/list");
    const deferred = await prefetch("/list", list, "/photo/1");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatch(/\.@modalD0\./);
    expect(count("modal")).toBe(0);

    // A link in the open modal to another intercepted route whose modal has
    // the same loader: the prefetch is sent from the modal's URL.
    const opened = matchedOf(
      await serve("/photo/1", { from: "/list", segments: list }),
    );
    for (const key of Object.keys(runs)) delete runs[key];
    expect(await prefetch("/photo/1", opened, "/photo-b/2")).toEqual([]);
    expect(count("modal")).toBe(1);
  });
});
