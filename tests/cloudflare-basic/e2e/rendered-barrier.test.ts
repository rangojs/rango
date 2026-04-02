import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, expectNoPageError } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Rendered barrier on Cloudflare Workers (workerd runtime).
 * Validates that ctx.rendered() + ctx.use(handle) works with
 * AsyncLocalStorage in the workerd environment.
 */
test.describe("rendered-barrier", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("loader reads handle data after rendered()", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/rendered-barrier"));
    await waitForHydration(page);

    await expect(testId(page, "rendered-barrier-title")).toHaveText(
      "Rendered Barrier",
    );

    // Loader read 3 product IDs from handle and returned prices
    await expect(testId(page, "rendered-barrier-price-count")).toHaveText("3");
    await expect(testId(page, "rendered-barrier-price-widget-a")).toContainText(
      "$9.99",
    );
    await expect(testId(page, "rendered-barrier-price-widget-b")).toContainText(
      "$19.99",
    );
    await expect(testId(page, "rendered-barrier-price-widget-c")).toContainText(
      "$29.99",
    );
  });
});

test.describe("rendered-barrier (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("loader reads handle data after rendered()", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/rendered-barrier"));
    await waitForHydration(page);

    await expect(testId(page, "rendered-barrier-title")).toHaveText(
      "Rendered Barrier",
    );

    await expect(testId(page, "rendered-barrier-price-count")).toHaveText("3");
    await expect(testId(page, "rendered-barrier-price-widget-a")).toContainText(
      "$9.99",
    );
    await expect(testId(page, "rendered-barrier-price-widget-b")).toContainText(
      "$19.99",
    );
    await expect(testId(page, "rendered-barrier-price-widget-c")).toContainText(
      "$29.99",
    );
  });
});
