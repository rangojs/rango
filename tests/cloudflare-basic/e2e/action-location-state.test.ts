import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Concurrent server-action location state (dual-app coverage of the test-app
 * suite). Distinct keys must both survive consolidation; a same-key collision
 * resolves to the last-INITIATED action in both settlement orders. The
 * "both settled" marker keeps the assertion from racing the later action.
 */
function concurrentSuite(f: ReturnType<typeof useFixture>) {
  test("concurrent distinct keys both survive consolidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-location-state"));
    await waitForHydration(page);

    await expect(testId(page, "concurrent-a")).toHaveText("none");
    await expect(testId(page, "concurrent-b")).toHaveText("none");

    await testId(page, "concurrent-distinct-btn").click();

    await expect(testId(page, "concurrent-settled")).toHaveText("a,b", {
      timeout: 10000,
    });
    await expect(testId(page, "concurrent-a")).toHaveText("A-from-action");
    await expect(testId(page, "concurrent-b")).toHaveText("B-from-action");
  });

  for (const variant of [
    {
      title: "settles first (slow first)",
      btn: "concurrent-samekey-slowfirst-btn",
    },
    {
      title: "settles last (fast first)",
      btn: "concurrent-samekey-fastfirst-btn",
    },
  ]) {
    test(`concurrent same-key: last-initiated wins, ${variant.title}`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/action-location-state"));
      await waitForHydration(page);

      await testId(page, variant.btn).click();

      await expect(testId(page, "concurrent-settled")).toHaveText(
        "first,second",
        { timeout: 10000 },
      );
      await expect(testId(page, "concurrent-a")).toHaveText("second-initiated");
    });
  }
}

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

  concurrentSuite(f);
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

  concurrentSuite(f);
});
