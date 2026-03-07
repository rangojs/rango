import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * HMR on an open intercept route should preserve intercept context.
 *
 * Without the interceptSourceUrl threading in the HMR refetch path,
 * the server resolves the fetch as the full target page instead of
 * the intercept tree, collapsing the modal into the full page view.
 */

test.describe.serial("intercept-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  const urlsPath = path.resolve("./e2e/test-app/src/urls.tsx");
  let originalContent: string;

  test.beforeAll(async () => {
    originalContent = fs.readFileSync(urlsPath, "utf-8");
  });

  test.afterEach(async () => {
    fs.writeFileSync(urlsPath, originalContent);
    // Wait for HMR to process the restore
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("HMR preserves intercept modal instead of collapsing to full page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to product index and open intercept modal
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("product-link-1").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("intercept-indicator")).toHaveText(
      "Intercepted",
    );

    // Modify the intercept handler to trigger RSC HMR
    const modified = originalContent.replace(
      '<span data-testid="intercept-indicator">Intercepted</span>',
      '<span data-testid="intercept-indicator">Intercepted-HMR</span>',
    );
    fs.writeFileSync(urlsPath, modified);

    // After HMR, the modal should still render as intercept (not full page)
    await expect(page.getByTestId("intercept-indicator")).toHaveText(
      "Intercepted-HMR",
      { timeout: 15000 },
    );
    // The modal wrapper should still be visible (intercept tree preserved)
    await expect(page.getByTestId("product-modal")).toBeVisible();
    // The full page view should NOT appear
    await expect(page.getByTestId("product-detail-page")).not.toBeVisible();
  });
});
