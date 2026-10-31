/**
 * The group a prefetch answer is shared by when a revalidate() rule read the
 * page being left and kept a segment (rango-t242), through the public
 * serveShellRequest primitive (@rangojs/router/testing/flight): the
 * response's `x-rsc-prefetch-scope: params; <label>` names the pages with
 * equal values of what the kept rules read, and pageMatchesParamsLabel is
 * the browser's own test of whether the page on screen is one of them
 * (browser/prefetch/cache.ts).
 *
 * The locale, category and #1331 cases are in
 * kept-layout-source-prefetch.rsc-test.tsx; the property over every
 * (source, adopter, target) in source-independence.rsc-test.tsx.
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
import { createLoader, createRouter, rewrite, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { pageMatchesParamsLabel } from "../../browser/prefetch/cache.js";
import { paramsScopeLabel } from "../../prefetch-source-scope.js";

const kindOf = (name: string | undefined): string =>
  name === "rnC" ? "c" : "ab";

const ItemLoader = createLoader(async (ctx) => ({ id: ctx.params.id }));

async function save(): Promise<{ ok: true }> {
  return { ok: true };
}

const router = createRouter({}).routes(
  urls(({ layout, loader, middleware, path, revalidate }) => [
    layout(
      () => <main>chrome</main>,
      () => [
        // A fromRouteName rule: grouped by the source's route name.
        layout(
          (ctx) => <section>{`kind:${kindOf(ctx.routeName)}`}</section>,
          () => [
            revalidate(
              ({ fromRouteName, toRouteName }) =>
                kindOf(fromRouteName) !== kindOf(toRouteName) || undefined,
            ),
            path("/rn/a", () => <p>a</p>, { name: "rnA" }),
            path("/rn/b", () => <p>b</p>, { name: "rnB" }),
            path("/rn/c", () => <p>c</p>, { name: "rnC" }),
          ],
        ),
        // A rule that spreads currentParams: grouped by every param.
        layout(
          (ctx) => <section>{`org:${ctx.params.org}`}</section>,
          () => [
            revalidate(
              ({ currentParams, nextParams }) =>
                ({ ...currentParams }).org !== nextParams.org || undefined,
            ),
            path(
              "/sp/:org/:project",
              (ctx) => <p>{`project:${ctx.params.project}`}</p>,
              { name: "spProject" },
            ),
          ],
        ),
        // Nested layouts and a route loader, each with a rule reading one
        // param of the source: one request unions what every kept rule read.
        layout(
          (ctx) => <section>{`locale:${ctx.params.locale}`}</section>,
          () => [
            revalidate(
              ({ currentParams, nextParams }) =>
                currentParams.locale !== nextParams.locale || undefined,
            ),
            layout(
              (ctx) => <section>{`section:${ctx.params.section}`}</section>,
              () => [
                revalidate(
                  ({ currentParams, nextParams }) =>
                    currentParams.section !== nextParams.section || undefined,
                ),
                path(
                  "/n/:locale/:section/:id",
                  (ctx) => <p>{`item:${ctx.params.id}`}</p>,
                  { name: "nItem" },
                  () => [
                    loader(ItemLoader, () => [
                      revalidate(
                        ({ currentParams, nextParams, isAction }) =>
                          isAction() ||
                          currentParams.locale !== nextParams.locale,
                      ),
                    ]),
                  ],
                ),
              ],
            ),
          ],
        ),
        // A rule on the route itself that falls back to the route's default,
        // under a layout that always re-renders so the answer sends a
        // segment; /rw/deals renders /rw/en/p/1 through a rewrite.
        layout(
          () => <aside>offers</aside>,
          () => [
            revalidate(() => true),
            path(
              "/rw/:locale/p/:id",
              (ctx) => <p>{`product:${ctx.params.id}`}</p>,
              { name: "rwProduct" },
              () => [
                revalidate(({ currentParams, nextParams }) =>
                  currentParams.locale !== nextParams.locale ? true : undefined,
                ),
              ],
            ),
            path(
              "/rw/deals",
              () => <p>deals</p>,
              { name: "rwDeals" },
              () => [
                middleware(() => {
                  throw rewrite("/rw/en/p/1");
                }),
              ],
            ),
          ],
        ),
        // A param value with characters the label encodes.
        layout(
          (ctx) => <section>{`q:${ctx.params.q}`}</section>,
          () => [
            revalidate(
              ({ currentParams, nextParams }) =>
                currentParams.q !== nextParams.q || undefined,
            ),
            path("/q/:q/:page", (ctx) => <p>{ctx.params.page}</p>, {
              name: "qPage",
            }),
          ],
        ),
      ],
    ),
  ]),
);

interface Metadata {
  matched: string[];
  diff: string[];
  params: Record<string, string>;
  routeName?: string;
}

const cacheStore = new MemorySegmentCacheStore();

async function standingOn(at: string): Promise<Metadata> {
  const result = await serveShellRequest(router, at, {
    cacheStore,
    partial: { from: "/elsewhere" },
  });
  return (await deserializeResult<{ metadata: Metadata }>(result.flight!))
    .metadata;
}

const prefetch = (from: string, held: Metadata, to: string) =>
  serveShellRequest(router, to, {
    cacheStore,
    partial: { from, segments: held.matched, prefetch: true },
  });

const scopeOf = (result: ServeShellRequestResult) =>
  result.response.headers.get("x-rsc-prefetch-scope");

const sharedWith = (result: ServeShellRequestResult, page: Metadata) =>
  pageMatchesParamsLabel(paramsScopeLabel(scopeOf(result))!, {
    params: page.params,
    routeName: page.routeName,
  });

beforeEach(async () => {
  await resetShellTestState();
});

describe("x-rsc-prefetch-scope through serveShellRequest (rango-t242)", () => {
  it("a fromRouteName rule groups by the source's route: another visit of that route shares it, another route does not", async () => {
    const a = await standingOn("/rn/a");
    const aAgain = await standingOn("/rn/a?tab=2");
    const c = await standingOn("/rn/c");

    const fromA = await prefetch("/rn/a", a, "/rn/b");
    expect(scopeOf(fromA)).toBe("params; $r=rnA");
    expect(sharedWith(fromA, aAgain)).toBe(true);
    expect(sharedWith(fromA, c)).toBe(false);
  });

  it("a rule that spreads currentParams groups by every param: another project of the org does not share it", async () => {
    const p1 = await standingOn("/sp/acme/p1");
    const p1Tab = await standingOn("/sp/acme/p1?tab=2");
    const p2 = await standingOn("/sp/acme/p2");

    const fromP1 = await prefetch("/sp/acme/p1", p1, "/sp/acme/p3");
    expect(scopeOf(fromP1)).toBe("params; $k=org,project&org=acme&project=p1");
    expect(sharedWith(fromP1, p1Tab)).toBe(true);
    expect(sharedWith(fromP1, p2)).toBe(false);
  });

  it("nested layouts and a route loader kept in one request: the union of what each rule read", async () => {
    const one = await standingOn("/n/en/audio/1");
    const two = await standingOn("/n/en/audio/2");
    const otherSection = await standingOn("/n/en/video/2");

    const fromOne = await prefetch("/n/en/audio/1", one, "/n/en/audio/3");
    expect(scopeOf(fromOne)).toBe(
      "params; $k=id,locale,section&locale=en&section=audio",
    );
    expect(sharedWith(fromOne, two)).toBe(true);
    expect(sharedWith(fromOne, otherSection)).toBe(false);
  });

  it("a re-rendered segment's reads do not narrow the group: only the kept rules' reads", async () => {
    const one = await standingOn("/n/en/audio/1");
    // The section changes: that layout re-renders, the locale layout and the
    // loader stay kept.
    const toVideo = await prefetch("/n/en/audio/1", one, "/n/en/video/3");
    expect(scopeOf(toVideo)).toBe("params; $k=id,locale,section&locale=en");
    expect(sharedWith(toVideo, await standingOn("/n/en/video/9"))).toBe(true);
  });

  it("a param value with =, &, ; and unicode is encoded in the header and matched by the browser", async () => {
    const raw = "a=b&c;d ü";
    const href = `/q/${encodeURIComponent(raw)}`;
    const page1 = await standingOn(`${href}/1`);
    const page2 = await standingOn(`${href}/2`);
    expect(page1.params.q).toBe(raw);

    const fromPage1 = await prefetch(`${href}/1`, page1, `${href}/3`);
    expect(scopeOf(fromPage1)).toBe(
      `params; $k=page,q&q=${encodeURIComponent(raw)}`,
    );
    expect(sharedWith(fromPage1, page2)).toBe(true);
    expect(sharedWith(fromPage1, await standingOn("/q/other/2"))).toBe(false);
  });

  it("a rule on the route that reads currentParams and falls back to the route's default keep, to a target a rewrite renders: the exact page's (source)", async () => {
    // /rw/deals renders /rw/en/p/1: from /rw/en/p/1 its params and search
    // equal the source's, so the route's default keeps product 1, and the
    // offers layout is sent.
    const p1 = await standingOn("/rw/en/p/1");
    const toDeals = await prefetch("/rw/en/p/1", p1, "/rw/deals");
    const answer = (
      await deserializeResult<{ metadata: Metadata }>(toDeals.flight!)
    ).metadata;
    const productId = p1.matched[p1.matched.length - 1]!;
    expect(answer.matched).toContain(productId);
    expect(answer.diff).not.toContain(productId);
    expect(answer.diff.length).toBeGreaterThan(0);
    // Grouped by locale (`params; $k=id,locale&locale=en`), /rw/en/p/2 would
    // adopt it and keep product 2 at /rw/deals.
    expect(scopeOf(toDeals)).toBe("source");
  });

  it("an action request is not a prefetch: its response carries no prefetch scope", async () => {
    const page = await standingOn("/n/en/audio/1");
    const result = await serveShellRequest(router, "/n/en/audio/1", {
      cacheStore,
      action: { ref: save, id: "scope-test#save", segments: page.matched },
    });
    expect(scopeOf(result)).toBeNull();
  });
});
