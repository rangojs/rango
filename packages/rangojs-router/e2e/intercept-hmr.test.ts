import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";
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

    await page.getByTestId("product-link-product-a").click();
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

  test("HMR transitions from intercept to full page when guard changes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to product index and open intercept modal
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("product-link-product-a").click();
    await expect(page.getByTestId("product-modal")).toBeVisible();
    await expect(page.getByTestId("intercept-indicator")).toHaveText(
      "Intercepted",
    );

    // Change the when() guard so the intercept no longer matches navigations from "/"
    const modified = originalContent.replace(
      'when(({ from }) => from.pathname === "/")',
      'when(({ from }) => from.pathname === "/never-match")',
    );
    fs.writeFileSync(urlsPath, modified);

    // After HMR, the intercept guard no longer matches, so the server
    // resolves /product/1 as the full page route instead of the intercept tree.
    await expect(page.getByTestId("product-detail-page")).toBeVisible({
      timeout: 15000,
    });
    // The intercept modal should no longer be visible
    await expect(page.getByTestId("product-modal")).not.toBeVisible();
  });
});
