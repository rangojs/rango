import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, blockPrefetch } from "./helper";

/**
 * A cache() among a path's own children caches that path (issue #912): on a
 * HIT the route and the layout declared after the cache() replay from the
 * cache, and the layout above the path renders again. Before, the layout
 * after the cache() never rendered and nothing was cached. Fixture:
 * e2e/test-app/src/urls/cache.tsx (/cache-test/path-children).
 */

type Render = {
  shell: string | null;
  route: string | null;
  chrome: string | null;
};

async function readCounts(page: Page): Promise<Render> {
  return {
    shell: await page.getByTestId("path-children-shell-count").textContent(),
    route: await page.getByTestId("path-children-route-count").textContent(),
    chrome: await page.getByTestId("path-children-chrome-count").textContent(),
  };
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
      {
        timeout: 10000,
        message: "Expected the path with cache() among its children to HIT",
      },
    )
    .toBe(true);
  return result!;
}

async function documentRender(
  page: Page,
  url: (path: string) => string,
): Promise<Render> {
  await page.goto(url("/cache-test/path-children"));
  await waitForHydration(page);
  return readCounts(page);
}

async function partialRender(
  page: Page,
  url: (path: string) => string,
): Promise<Render> {
  await page.goto(url("/cache-test/path-children-entry"));
  await waitForHydration(page);
  await page.getByTestId("path-children-link").click();
  await expect(page.getByTestId("path-children-route-count")).toBeVisible();
  return readCounts(page);
}

function expectPathCachedAndShellLive(before: Render, hit: Render): void {
  expect(hit.chrome).not.toBeNull();
  expect(hit.chrome).toBe(before.chrome);
  expect(Number(hit.shell)).toBeGreaterThan(Number(before.shell));
}

test.describe("cache() among a path's children", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("document HIT replays the path and the layout after the cache()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const { before, hit } = await untilHit(() => documentRender(page, f.url));
    expectPathCachedAndShellLive(before, hit);
  });

  test("partial HIT replays the path and the layout after the cache()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await blockPrefetch(page);
    const { before, hit } = await untilHit(() => partialRender(page, f.url));
    expectPathCachedAndShellLive(before, hit);
  });
});

test.describe("cache() among a path's children (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("document HIT replays the path and the layout after the cache()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const { before, hit } = await untilHit(() => documentRender(page, f.url));
    expectPathCachedAndShellLive(before, hit);
  });

  test("partial HIT replays the path and the layout after the cache()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await blockPrefetch(page);
    const { before, hit } = await untilHit(() => partialRender(page, f.url));
    expectPathCachedAndShellLive(before, hit);
  });
});
