import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, blockPrefetch } from "./helper";

/**
 * A layout above a route-level cache() boundary is live (issue #906): on a
 * cache HIT it renders again and its response header lands, while the route
 * inside the boundary replays from the cache. Fixture:
 * e2e/test-app/src/urls/cache.tsx (/cache-test/outer-live).
 */

type Render = { layout: string | null; route: string | null };

async function readCounts(page: Page): Promise<Render> {
  return {
    layout: await page.getByTestId("outer-live-layout-count").textContent(),
    route: await page.getByTestId("outer-live-route-count").textContent(),
  };
}

/**
 * Render until two consecutive renders show the same route count: the second
 * one is a cache HIT (a MISS re-runs the route handler and advances it).
 */
async function untilHit<T extends Render>(
  render: () => Promise<T>,
): Promise<{ before: T; hit: T }> {
  let before = await render();
  let result: { before: T; hit: T } | undefined;
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
        message: "Expected the route inside cache() to replay from the cache",
      },
    )
    .toBe(true);
  return result!;
}

async function documentRender(
  page: Page,
  url: (path: string) => string,
): Promise<Render & { header: string | null }> {
  const response = await page.goto(url("/cache-test/outer-live"));
  await waitForHydration(page);
  return {
    ...(await readCounts(page)),
    header: response?.headers()["x-outer-live-layout"] ?? null,
  };
}

async function partialRender(
  page: Page,
  url: (path: string) => string,
): Promise<Render> {
  await page.goto(url("/cache-test/outer-live-entry"));
  await waitForHydration(page);
  await page.getByTestId("outer-live-link").click();
  await expect(page.getByTestId("outer-live-route-count")).toBeVisible();
  return readCounts(page);
}

async function expectLiveLayoutOnDocumentHit(
  page: Page,
  url: (path: string) => string,
): Promise<void> {
  const { before, hit } = await untilHit(() => documentRender(page, url));
  expect(Number(hit.layout)).toBeGreaterThan(Number(before.layout));
  expect(hit.header).toBe(hit.layout);
}

async function expectLiveLayoutOnPartialHit(
  page: Page,
  url: (path: string) => string,
): Promise<void> {
  await blockPrefetch(page);
  const { before, hit } = await untilHit(() => partialRender(page, url));
  expect(Number(hit.layout)).toBeGreaterThan(Number(before.layout));
}

test.describe("cache() outer layout stays live", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("document HIT re-renders the layout above the boundary and keeps its header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLiveLayoutOnDocumentHit(page, f.url);
  });

  test("partial HIT renders the layout above the boundary fresh for a client without it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLiveLayoutOnPartialHit(page, f.url);
  });
});

test.describe("cache() outer layout stays live (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("document HIT re-renders the layout above the boundary and keeps its header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLiveLayoutOnDocumentHit(page, f.url);
  });

  test("partial HIT renders the layout above the boundary fresh for a client without it", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLiveLayoutOnPartialHit(page, f.url);
  });
});
