import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A layout after a bare cache() wraps every route of the enclosing layout
 * (issue #918): it renders live on the route before the cache(), and on the
 * route after it a CFCacheStore HIT replays it while the layout above stays
 * live. Before, it never rendered on the route before the cache(). Fixture:
 * /marker-before and /marker-after in src/urls.tsx.
 */

type Render = {
  shell: string | null;
  route: string | null;
  promo: string | null;
};

async function render(page: Page, url: string): Promise<Render> {
  await page.goto(url);
  await waitForHydration(page);
  return {
    shell: await testId(page, "marker-shell-token").textContent(),
    route: await testId(page, "marker-route-token").textContent(),
    promo: await testId(page, "marker-promo-token").textContent(),
  };
}

async function expectPromoLiveBeforeMarker(
  page: Page,
  url: (path: string) => string,
): Promise<void> {
  const first = await render(page, url("/marker-before"));
  const second = await render(page, url("/marker-before"));
  expect(first.promo).not.toBeNull();
  expect(second.route).not.toBe(first.route);
  expect(second.promo).not.toBe(first.promo);
}

/**
 * Render until two consecutive loads show the same route token: the second
 * one is a cache HIT (a MISS re-runs the route handler and mints a new one).
 */
async function expectPromoReplayedAfterMarker(
  page: Page,
  url: (path: string) => string,
): Promise<void> {
  let before = await render(page, url("/marker-after"));
  let result: { before: Render; hit: Render } | undefined;
  await expect
    .poll(
      async () => {
        const next = await render(page, url("/marker-after"));
        if (next.route === before.route) result = { before, hit: next };
        before = next;
        return result !== undefined;
      },
      {
        timeout: 15000,
        message: "Expected the route after cache() to replay from the store",
      },
    )
    .toBe(true);
  expect(result!.hit.promo).toBe(result!.before.promo);
  expect(result!.hit.shell).not.toBe(result!.before.shell);
}

test.describe("layout after a bare cache() (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("renders live on the route before the cache()", async ({ page }) => {
    using _ = expectNoPageError(page);
    await expectPromoLiveBeforeMarker(page, f.url);
  });

  test("replays with the route after the cache() on a document HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPromoReplayedAfterMarker(page, f.url);
  });
});

test.describe("layout after a bare cache() (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("renders live on the route before the cache()", async ({ page }) => {
    using _ = expectNoPageError(page);
    await expectPromoLiveBeforeMarker(page, f.url);
  });

  test("replays with the route after the cache() on a document HIT", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectPromoReplayedAfterMarker(page, f.url);
  });
});
