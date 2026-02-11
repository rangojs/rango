import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Pre-render handler tests in dev mode.
 * Verifies that prerender handlers using node:fs work correctly in Cloudflare
 * dev where the RSC environment runs in workerd. The handler reads
 * content/releases.json via node:fs — this works because the cache-lookup
 * middleware fetches pre-rendered data from the Vite dev server's
 * /__rsc_prerender endpoint (Node.js) instead of running the handler in workerd.
 */
test.describe("prerender (dev mode)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render releases page with node:fs handler on direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Releases");

    // Verify at least one release entry rendered from content/releases.json
    await expect(testId(page, "release-2.0.0")).toBeVisible();
    await expect(testId(page, "release-1.0.0")).toBeVisible();
  });

  test("should render releases page on subsequent direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Second direct visit should also work (prerender store is already initialized)
    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-page")).toBeVisible();
    await expect(testId(page, "release-2.0.0")).toBeVisible();
  });
});
