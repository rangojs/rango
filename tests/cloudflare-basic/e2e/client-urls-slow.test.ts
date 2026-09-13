import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * clientUrls() optimistic destination vs a 5s server middleware over the group
 * (src/urls.tsx, src/client-urls/slow.tsx). The middleware gates EVERY canonical request — hard loads,
 * in-group navigations, prefetches, redirects — so the timings below separate
 * what the browser presents locally from what the server delivers. Contract:
 * docs/design/client-urls-optimistic-destination.md.
 */

const MIDDLEWARE_MS = 5000;
// Anything under this is "before the gated response could have arrived".
const IMMEDIATE_MS = 1500;
const GATED_TIMEOUT = MIDDLEWARE_MS + 10_000;

function clientUrlsSlowTests(f: ReturnType<typeof useFixture>): void {
  test("A to B: B presents immediately with its own route identity; loader data and app location land after the middleware", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/client-urls-slow"), { timeout: GATED_TIMEOUT });
    await waitForHydration(page);
    await expect(testId(page, "cus-a")).toBeVisible();

    const start = Date.now();
    await testId(page, "cus-a-to-b").click();

    // Optimistic branch: B's component, its params/pathname from the local
    // match, the loader read behind B's inline boundary.
    await expect(testId(page, "cus-b")).toBeVisible({ timeout: IMMEDIATE_MS });
    const presentedAt = Date.now() - start;
    await expect(testId(page, "cus-b-skeleton")).toBeVisible();
    await expect(testId(page, "cus-b-param")).toHaveText("first");
    await expect(testId(page, "cus-b-pathname")).toHaveText(
      "/client-urls-slow/b/first",
    );
    await expect(testId(page, "cus-a")).toHaveCount(0);
    await expect(testId(page, "cus-layout")).toHaveAttribute(
      "data-pending",
      "true",
    );
    // App-level location waits for the server: chrome outside the group and
    // the URL bar still say A.
    await expect(testId(page, "cus-chrome-pathname")).toHaveText(
      "/client-urls-slow",
    );
    await expect(page).toHaveURL(f.url("/client-urls-slow"));
    // State entered during the window rides through the commit: the group
    // segment reconciles in place, so this input instance is not remounted.
    await testId(page, "cus-b-input").fill("typed during the wait");

    await expect(testId(page, "cus-b-loader")).toHaveText("slow-data", {
      timeout: GATED_TIMEOUT,
    });
    await expect(testId(page, "cus-b-input")).toHaveValue(
      "typed during the wait",
    );
    const dataAt = Date.now() - start;
    await expect(page).toHaveURL(f.url("/client-urls-slow/b/first"));
    await expect(testId(page, "cus-chrome-pathname")).toHaveText(
      "/client-urls-slow/b/first",
    );
    await expect(testId(page, "cus-b-param")).toHaveText("first");
    await expect(testId(page, "cus-layout")).toHaveAttribute(
      "data-pending",
      "false",
    );

    expect(presentedAt).toBeLessThan(IMMEDIATE_MS);
    expect(dataAt).toBeGreaterThanOrEqual(MIDDLEWARE_MS - 500);
  });

  test("B to C: a completed hover prefetch commits the full page immediately", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/client-urls-slow/b/first"), {
      timeout: GATED_TIMEOUT,
    });
    await waitForHydration(page);
    await expect(testId(page, "cus-b-loader")).toHaveText("slow-data");

    // The prefetch goes through the same 5s middleware; wait for its body to
    // drain so the click lands on a fully decoded payload.
    const prefetched = page.waitForResponse(
      (resp) => {
        const u = new URL(resp.url());
        return (
          u.pathname.endsWith("/client-urls-slow/c") &&
          u.searchParams.has("_rsc_partial")
        );
      },
      { timeout: GATED_TIMEOUT },
    );
    await testId(page, "cus-b-to-c").hover();
    const resp = await prefetched;
    await resp.finished();

    const start = Date.now();
    await testId(page, "cus-b-to-c").click();
    await expect(testId(page, "cus-c-loader")).toHaveText("slow-data", {
      timeout: IMMEDIATE_MS,
    });
    const contentAt = Date.now() - start;
    await expect(page).toHaveURL(f.url("/client-urls-slow/c"));

    expect(contentAt).toBeLessThan(IMMEDIATE_MS);
  });

  test("C to D: D presents immediately, then the loader redirect lands after the middleware", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/client-urls-slow/c"), { timeout: GATED_TIMEOUT });
    await waitForHydration(page);
    await expect(testId(page, "cus-c-loader")).toHaveText("slow-data");

    const start = Date.now();
    await testId(page, "cus-c-to-d").click();
    await expect(testId(page, "cus-d")).toBeVisible({ timeout: IMMEDIATE_MS });
    const presentedAt = Date.now() - start;
    await expect(testId(page, "cus-d-skeleton")).toBeVisible();
    await expect(page).toHaveURL(f.url("/client-urls-slow/c"));

    await expect(testId(page, "cus-landing")).toBeVisible({
      timeout: GATED_TIMEOUT,
    });
    const landedAt = Date.now() - start;
    await expect(page).toHaveURL(f.url("/client-urls-slow-landing"));
    await expect(testId(page, "cus-d")).toHaveCount(0);

    expect(presentedAt).toBeLessThan(IMMEDIATE_MS);
    expect(landedAt).toBeGreaterThanOrEqual(MIDDLEWARE_MS - 500);
  });

  test("C to E without any boundary: C stays visible and pending until E commits with data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/client-urls-slow/c"), { timeout: GATED_TIMEOUT });
    await waitForHydration(page);
    await expect(testId(page, "cus-c-loader")).toHaveText("slow-data");

    const start = Date.now();
    await testId(page, "cus-c-to-e").click();
    // The optimistic render suspends with nothing to catch it: React holds
    // the current content in the transition lane; only pending flips.
    await expect(testId(page, "cus-layout")).toHaveAttribute(
      "data-pending",
      "true",
      { timeout: IMMEDIATE_MS },
    );
    await expect(testId(page, "cus-c")).toBeVisible();
    await expect(testId(page, "cus-e")).toHaveCount(0);

    await expect(testId(page, "cus-e")).toHaveText("slow-data", {
      timeout: GATED_TIMEOUT,
    });
    const dataAt = Date.now() - start;
    await expect(page).toHaveURL(f.url("/client-urls-slow/e"));
    await expect(testId(page, "cus-c")).toHaveCount(0);

    expect(dataAt).toBeGreaterThanOrEqual(MIDDLEWARE_MS - 500);
  });
}

test.describe("clientUrls slow middleware", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  clientUrlsSlowTests(f);
});

test.describe("clientUrls slow middleware (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  clientUrlsSlowTests(f);
});
