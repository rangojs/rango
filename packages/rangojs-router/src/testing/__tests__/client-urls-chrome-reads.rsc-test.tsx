/**
 * A clientUrls() group route ships, as ClientUrlsRoot's `chrome` prop, which
 * destinations the server segments above the group stay right for, through
 * a public primitive: serveShellRequest's document and partial navigation.
 * The browser declines an optimistic frame for any other destination
 * (client-urls-chrome-frame.test.tsx): the canonical commit would re-render
 * that chrome, so a frame would show the destination under the committed
 * page's chrome for a round trip.
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
import { createRouter, urls, type Revalidate } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
// /, /:slug and /detail/:id, with a module-local intercept: the group's
// routes sit under its materialized group layout.
import interceptGroup from "./fixtures/client-urls-param-mount.js";
// A group whose own layout() loaders declare revalidate() rules: those are
// the group's, not chrome.
import loaderRuleGroup from "./fixtures/client-urls-layout-revalidate.js";

// The #1331 template rule, by the group's product param.
const bySlug: Revalidate = ({ currentParams, nextParams }) =>
  (currentParams.slug ?? null) !== (nextParams.slug ?? null) || undefined;

function routerWith(
  rule: Revalidate | undefined,
  group: typeof interceptGroup,
  mount: string,
) {
  return createRouter({}).routes(
    urls(({ path, layout, include, revalidate }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/about/us", () => <p>about</p>, { name: "about" }),
          layout(
            () => <section>template</section>,
            () => [
              ...(rule ? [revalidate(rule)] : []),
              include(mount, group, { name: "shop" }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** The `chrome` prop of the group's ClientUrlsRoot in the payload. */
function chromeOf(result: ServeShellRequestResult): unknown {
  expect(result.flight, "a Flight payload").toBeDefined();
  const found = /"chrome":("any"|\{"params":\{[^}]*\}(?:,"keys":true)?\})/.exec(
    result.flight!,
  );
  return found ? JSON.parse(found[1]!) : undefined;
}

async function serving(
  rule: Revalidate | undefined,
  group = interceptGroup,
  mount = "/shop",
) {
  const router = routerWith(rule, group, mount);
  const cacheStore = new MemorySegmentCacheStore();
  const document = (to: string) =>
    serveShellRequest(router, to, { cacheStore });
  const navigate = (to: string, from: string) =>
    serveShellRequest(router, to, { cacheStore, partial: { from } });
  // A router's first request matches before its trie is built; warm it.
  await document("/about/us");
  return { document, navigate };
}

beforeEach(() => resetShellTestState());

describe("clientUrls() group routes ship the chrome reads of their page", () => {
  it("a rule reading the destination's param: this page's value of it", async () => {
    const { document, navigate } = await serving(bySlug);
    expect(chromeOf(await document("/shop/shoe"))).toEqual({
      params: { slug: "shoe" },
    });
    // The index has no slug: null.
    expect(chromeOf(await document("/shop"))).toEqual({
      params: { slug: null },
    });
    // A partial navigation's render of the route ships its own page's.
    expect(chromeOf(await navigate("/shop/boot", "/shop/shoe"))).toEqual({
      params: { slug: "boot" },
    });
    expect(chromeOf(await navigate("/shop/detail/1", "/about/us"))).toEqual({
      params: { slug: null },
    });
  });

  it("a mount param the URL leaves out: null", async () => {
    const { document } = await serving(
      ({ nextParams }) => nextParams.locale === "?",
      interceptGroup,
      "/:locale?",
    );
    expect(chromeOf(await document("/shoe"))).toEqual({
      params: { locale: null },
    });
    expect(chromeOf(await document("/en/shoe"))).toEqual({
      params: { locale: "en" },
    });
  });

  it("a rule that re-renders on every navigation: any", async () => {
    const { document } = await serving(() => true);
    expect(chromeOf(await document("/shop/shoe"))).toBe("any");
  });

  it("a rule reading the destination URL: any", async () => {
    const { document } = await serving(({ nextUrl }) =>
      nextUrl.searchParams.has("tab"),
    );
    expect(chromeOf(await document("/shop/shoe"))).toBe("any");
  });

  it("no rule above the group: no prop", async () => {
    const { document } = await serving(undefined);
    expect(chromeOf(await document("/shop/shoe"))).toBeUndefined();
  });

  it("the group's own layout() loader rules are not chrome", async () => {
    const { document } = await serving(undefined, loaderRuleGroup);
    expect(chromeOf(await document("/shop/items/1"))).toBeUndefined();
  });
});
