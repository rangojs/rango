import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  writeFileAndAwaitHmr,
} from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * HMR on an open intercept route:
 * 1. Should preserve intercept context when the route still matches.
 * 2. Should transition to full page when the intercept guard changes
 *    to no longer match (intercept -> non-intercept).
 */

test.describe.serial("intercept-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(60000);

  const configPath = path.resolve("./e2e/test-app/src/intercept-hmr-config.ts");
  const configUpdatePattern = /RSC module changed, version updated/;
  let originalContent: string;

  test.beforeAll(async () => {
    originalContent = fs.readFileSync(configPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(configPath, originalContent);
  });

  test("HMR preserves intercept modal instead of collapsing to full page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to product index and open intercept modal
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("product-link-product-a").click();
    await expect(page.getByTestId("product-modal")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("intercept-indicator")).toHaveText(
      "Intercepted",
    );

    // Modify the intercept handler to trigger RSC HMR
    const modified = originalContent.replace(
      'export const interceptIndicatorText = "Intercepted";',
      'export const interceptIndicatorText = "Intercepted-HMR";',
    );
    await writeFileAndAwaitHmr(page, configPath, modified, {
      totalTimeoutMs: 25000,
      retryIntervalMs: 8000,
      getServerOutput: () => f.proc().stdout(),
      serverOutputPattern: configUpdatePattern,
      waitForApplied: async () => {
        await expect(page.getByTestId("intercept-indicator")).toHaveText(
          "Intercepted-HMR",
          { timeout: 12000 },
        );
      },
    });

    // After HMR, the modal should still render as intercept (not full page)
    await expect(page.getByTestId("intercept-indicator")).toHaveText(
      "Intercepted-HMR",
    );
    // The modal wrapper should still be visible (intercept tree preserved)
    await expect(page.getByTestId("product-modal")).toBeVisible();
    // The full page view should NOT appear
    await expect(page.getByTestId("product-detail-page")).not.toBeVisible();
  });
});
