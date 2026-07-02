import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, expectNoPageError } from "./helper";

/**
 * Streaming on a cold client navigation with a component-placed <Suspense>
 * (no router loading()). Mirrors the user's repro: the route handler returns
 * immediately, pushes a Meta handle derived from the streamed data, and passes
 * a server promise into a <Suspense> rendered by the route component; a client
 * component use()s the promise.
 *
 * Contract: the <Suspense> fallback must appear during the navigation (the
 * route streams), then the resolved content replaces it. STREAM_DELAY is
 * 3000ms; the fallback must show well before that on a cold nav.
 *
 * Two navigation shapes are exercised because they hit different reconcile
 * paths:
 *   - cross-route: /stream-test (index) -> /stream-test/1
 *   - same-route param change: /stream-test/1 -> /stream-test/2
 */

// Cross-route nav: index -> detail. Fallback must stream before content.
async function crossRoute(url: (u?: string) => string, page: Page) {
  await page.goto(url("/stream-test"));
  await waitForHydration(page);
  await expect(testId(page, "stream-test-index")).toBeVisible();

  await page.getByRole("link", { name: "Go to stream-test/1" }).click();

  await expect(testId(page, "stream-test-fallback")).toBeVisible({
    timeout: 2000,
  });
  await expect(testId(page, "stream-test-content")).toHaveText(
    "Test: resolved 1",
    { timeout: 6000 },
  );
  await expect(testId(page, "stream-test-fallback")).toBeHidden();
}

// Same-route param change: /stream-test/1 -> /stream-test/2. Fallback must
// stream before the new content; the old content must not be held.
async function sameRouteParam(url: (u?: string) => string, page: Page) {
  await page.goto(url("/stream-test/1"));
  await waitForHydration(page);
  await expect(testId(page, "stream-test-content")).toHaveText(
    "Test: resolved 1",
    { timeout: 6000 },
  );

  await page.getByRole("link", { name: "Go to stream-test/2" }).click();

  await expect(testId(page, "stream-test-fallback")).toBeVisible({
    timeout: 2000,
  });
  await expect(testId(page, "stream-test-content")).toHaveText(
    "Test: resolved 2",
    { timeout: 6000 },
  );
}

test.describe("stream-suspense", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("cross-route: component Suspense streams its fallback on cold nav", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await crossRoute(f.url, page);
  });

  test("same-route param: component Suspense streams its fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await sameRouteParam(f.url, page);
  });
});

test.describe("stream-suspense (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("cross-route: component Suspense streams its fallback on cold nav", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await crossRoute(f.url, page);
  });

  test("same-route param: component Suspense streams its fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await sameRouteParam(f.url, page);
  });
});
