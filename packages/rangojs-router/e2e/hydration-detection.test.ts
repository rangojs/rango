import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Tests for hydration error detection in waitForHydration helper
 */
test.describe("hydration-error-detection", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("waitForHydration should catch hydration mismatch errors", async ({
    page,
  }) => {
    // Navigate to page with intentional hydration mismatch (uses Date.now())
    await page.goto(f.url("/hydration-test"));

    // waitForHydration should throw due to hydration mismatch
    await expect(waitForHydration(page)).rejects.toThrow(/[Hh]ydration/);
  });

  test("waitForHydration should pass on pages without hydration errors", async ({
    page,
  }) => {
    // Navigate to a normal page without hydration issues
    await page.goto(f.url("/"));

    // waitForHydration should complete without throwing
    await expect(waitForHydration(page)).resolves.toBeUndefined();
  });
});
