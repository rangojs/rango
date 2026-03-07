import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// -- Dev mode --

test.describe("action location state (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("action sets location state without redirect", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-location-state"));
    await waitForHydration(page);

    // Let the page fully settle (dev overlay, network, etc.)
    await page.waitForLoadState("networkidle");

    // Before action: no flash state
    await expect(testId(page, "flash-message")).toHaveText("none");

    // Click the action that sets location state
    await testId(page, "set-location-state-btn").click();

    // After revalidation, the client should receive location state
    await expect(testId(page, "flash-message")).toHaveText(
      "saved-from-action",
      { timeout: 10000 },
    );
  });
});

// -- Production mode --

test.describe("action location state (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("action sets location state without redirect (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-location-state"));
    await waitForHydration(page);

    // Before action: no flash state
    await expect(testId(page, "flash-message")).toHaveText("none");

    // Click the action that sets location state
    await testId(page, "set-location-state-btn").click();

    // After revalidation, the client should receive location state
    await expect(testId(page, "flash-message")).toHaveText(
      "saved-from-action",
      { timeout: 10000 },
    );
  });
});
