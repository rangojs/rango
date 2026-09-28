import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, blockPrefetch } from "./helper";

/**
 * Layouts nested under a routeless entry render, and cache() caches what its
 * scope covers (issue #918). Fixture: e2e/test-app/src/urls/cache.tsx.
 *
 * - /cache-test/marker-before and /cache-test/marker-after share a layout
 *   whose children are [path(before), cache(), layout(Promo), path(after)].
 *   Promo wraps both routes: live on the route before the marker (outside its
 *   scope), cached with the route after it. Before, Promo never rendered on
 *   the route before the marker.
 * - /cache-test/layout-cache is path(..., () => [layout(Chrome, () =>
 *   [cache()])]): the cache() caches the path. Before, nothing was cached.
 */

type Render = {
  shell: string | null;
  route: string | null;
  inner: string | null;
};

const MARKER = {
  shell: "marker-shell-count",
  route: "marker-route-count",
  inner: "marker-promo-count",
};
const LAYOUT_CACHE = {
  shell: "layout-cache-shell-count",
  route: "layout-cache-route-count",
  inner: "layout-cache-chrome-count",
};

async function readCounts(page: Page, ids: typeof MARKER): Promise<Render> {
  return {
    shell: await page.getByTestId(ids.shell).textContent(),
    route: await page.getByTestId(ids.route).textContent(),
    inner: await page.getByTestId(ids.inner).textContent(),
  };
}

async function documentRender(
  page: Page,
  url: string,
  ids: typeof MARKER,
): Promise<Render> {
  await page.goto(url);
  await waitForHydration(page);
  return readCounts(page, ids);
}

async function partialRender(
  page: Page,
  entryUrl: string,
  link: string,
  ids: typeof MARKER,
): Promise<Render> {
  await page.goto(entryUrl);
  await waitForHydration(page);
  await page.getByTestId(link).click();
  await expect(page.getByTestId(ids.route)).toBeVisible();
  return readCounts(page, ids);
}

/**
 * Render until two consecutive renders show the same route count: the second
 * one is a cache HIT (a MISS re-runs the route handler and advances it).
 */
async function untilHit(
  render: () => Promise<Render>,
): Promise<{ before: Render; hit: Render }> {
  let before = await render();
  let result: { before: Render; hit: Render } | undefined;
  await expect
    .poll(
      async () => {
        const next = await render();
        if (next.route === before.route) result = { before, hit: next };
        before = next;
        return result !== undefined;
      },
      { timeout: 10000, message: "Expected a cache HIT" },
    )
    .toBe(true);
  return result!;
}

function expectReplayedAndShellLive(before: Render, hit: Render): void {
  expect(hit.inner).not.toBeNull();
  expect(hit.inner).toBe(before.inner);
  expect(Number(hit.shell)).toBeGreaterThan(Number(before.shell));
}

function defineSpec(f: { url: (path: string) => string }): void {
  test("a layout after a bare cache() renders live on the route before it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/cache-test/marker-before");
    const first = await documentRender(page, url, MARKER);
    const second = await documentRender(page, url, MARKER);
    expect(first.inner).not.toBeNull();
    expect(Number(second.route)).toBeGreaterThan(Number(first.route));
    expect(Number(second.inner)).toBeGreaterThan(Number(first.inner));

    await blockPrefetch(page);
    const nav = await partialRender(
      page,
      f.url("/cache-test/orphan-entry"),
      "marker-before-link",
      MARKER,
    );
    expect(nav.inner).not.toBeNull();
  });

  test("a layout after a bare cache() replays with the route after it on a document HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/cache-test/marker-after");
    const { before, hit } = await untilHit(() =>
      documentRender(page, url, MARKER),
    );
    expectReplayedAndShellLive(before, hit);
  });

  test("a layout after a bare cache() replays with the route after it on a partial HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await blockPrefetch(page);
    const entry = f.url("/cache-test/orphan-entry");
    const { before, hit } = await untilHit(() =>
      partialRender(page, entry, "marker-after-link", MARKER),
    );
    expectReplayedAndShellLive(before, hit);
  });

  test("a cache() inside a routeless layout in a path caches the path on a document HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/cache-test/layout-cache");
    const { before, hit } = await untilHit(() =>
      documentRender(page, url, LAYOUT_CACHE),
    );
    expectReplayedAndShellLive(before, hit);
  });

  test("a cache() inside a routeless layout in a path caches the path on a partial HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await blockPrefetch(page);
    const entry = f.url("/cache-test/orphan-entry");
    const { before, hit } = await untilHit(() =>
      partialRender(page, entry, "layout-cache-link", LAYOUT_CACHE),
    );
    expectReplayedAndShellLive(before, hit);
  });
}

test.describe("layouts nested under a routeless entry", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineSpec(f);
});

test.describe("layouts nested under a routeless entry (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineSpec(f);
});
