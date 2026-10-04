import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A layout above a route-level cache() boundary is live (issue #906): on a
 * CFCacheStore HIT it renders again and its response header lands, while the
 * route inside the boundary replays from the store. Fixture: /outer-live in
 * src/urls.tsx.
 */

type Render = {
  layout: string | null;
  route: string | null;
  header: string | null;
};

async function render(
  page: Page,
  url: (path: string) => string,
): Promise<Render> {
  const response = await page.goto(url("/outer-live"));
  await waitForHydration(page);
  return {
    layout: await testId(page, "outer-live-layout-token").textContent(),
    route: await testId(page, "outer-live-route-token").textContent(),
    header: response?.headers()["x-outer-live-layout"] ?? null,
  };
}

/**
 * Render until two consecutive loads show the same route token: the second
 * one is a cache HIT (a MISS re-runs the route handler and mints a new one).
 */
async function expectLiveLayoutOnHit(
  page: Page,
  url: (path: string) => string,
): Promise<void> {
  let before = await render(page, url);
  let result: { before: Render; hit: Render } | undefined;
  await expect
    .poll(
      async () => {
        const next = await render(page, url);
        if (next.route === before.route) result = { before, hit: next };
        before = next;
        return result !== undefined;
      },
      {
        timeout: 15000,
        message: "Expected the route inside cache() to replay from the store",
      },
    )
    .toBe(true);
  expect(result!.hit.layout).not.toBe(result!.before.layout);
  expect(result!.hit.header).toBe(result!.hit.layout);
}

test.describe("cache() outer layout stays live (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("document HIT re-renders the layout above the boundary and keeps its header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLiveLayoutOnHit(page, f.url);
  });
});

test.describe("cache() outer layout stays live (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("document HIT re-renders the layout above the boundary and keeps its header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectLiveLayoutOnHit(page, f.url);
  });
});
