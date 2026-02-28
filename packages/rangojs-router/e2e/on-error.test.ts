import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests that onError callback receives correct phase and context
 * when errors are thrown from server actions.
 */
test.describe("onError", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("thrown error from action reports phase as 'action' to onError", async ({
    page,
  }) => {
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Reset any previous error
    await page.request.get(f.url("/__test/last-error"));

    // Trigger action that throws an error
    await page.locator('[data-testid="throw-error-btn"]').click();

    // Wait for the action to complete (error is swallowed client-side)
    await page.waitForTimeout(1000);

    // Fetch the last onError call from the server
    const response = await page.request.get(f.url("/__test/last-error"));
    const data = await response.json();

    expect(data.data).not.toBeNull();
    expect(data.data.phase).toBe("action");
    expect(data.data.message).toBe("Action error for onError test");
  });
});

test.describe("onError (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("thrown error from action reports phase as 'action' to onError in production", async ({
    page,
  }) => {
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Reset any previous error
    await page.request.get(f.url("/__test/last-error"));

    // Trigger action that throws an error
    await page.locator('[data-testid="throw-error-btn"]').click();

    // Wait for the action to complete
    await page.waitForTimeout(1000);

    // Fetch the last onError call from the server
    const response = await page.request.get(f.url("/__test/last-error"));
    const data = await response.json();

    expect(data.data).not.toBeNull();
    expect(data.data.phase).toBe("action");
    // Production sanitizes error messages
    expect(data.data.message).toBeTruthy();
  });
});
