import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

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
    await page.request.get(f.url("/__test/last-error?reset"));

    // Trigger action that throws an error
    await page.locator('[data-testid="throw-error-btn"]').click();

    // Poll until onError captures the error
    await expect
      .poll(
        async () => {
          const res = await page.request.get(f.url("/__test/last-error"));
          const json = await res.json();
          return json.data;
        },
        { timeout: 5000 },
      )
      .toEqual(
        expect.objectContaining({
          phase: "action",
          message: "Action error for onError test",
        }),
      );
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
    await page.request.get(f.url("/__test/last-error?reset"));

    // Trigger action that throws an error
    await page.locator('[data-testid="throw-error-btn"]').click();

    // Poll until onError captures the error
    await expect
      .poll(
        async () => {
          const res = await page.request.get(f.url("/__test/last-error"));
          const json = await res.json();
          return json.data;
        },
        { timeout: 5000 },
      )
      .toEqual(
        expect.objectContaining({
          phase: "action",
        }),
      );
  });
});
