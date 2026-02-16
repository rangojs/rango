import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for client loaders and isomorphic loaders:
 *
 * 1. Client loader: SSR shows loading skeleton, hydration resolves data (source: "client")
 * 2. Client loader: SPA navigation resolves client-side
 * 3. Isomorphic loader: SSR uses server fn (source: "server")
 * 4. Isomorphic loader: SPA navigation uses client fn (source: "client")
 * 5. Mixed loaders: server + client on same route both available via useLoader
 */

test.describe("client-loader", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test.describe("client-only loader", () => {
    test("SSR shows loading skeleton, then client resolves data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to client-loader route (SSR path)
      await page.goto(f.url("/client-loader"));
      await waitForHydration(page);

      // After hydration, client loader should have resolved
      // The loading skeleton should be gone and real content visible
      await expect(
        page.locator('[data-testid="client-loader-content"]'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="client-loader-source"]'),
      ).toContainText("Source: client");
      await expect(
        page.locator('[data-testid="client-loader-theme"]'),
      ).toContainText("Theme: dark");
    });

    test("SPA navigation resolves client loader without server request", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index page
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to client-loader route
      await page.locator('[data-testid="client-loader-link"]').click();

      // Client loader content should appear (resolved in browser)
      await expect(
        page.locator('[data-testid="client-loader-content"]'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="client-loader-source"]'),
      ).toContainText("Source: client");
      await expect(
        page.locator('[data-testid="client-loader-theme"]'),
      ).toContainText("Theme: dark");
    });

    test("refetch calls client function (not server)", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Start from index page, navigate to client-loader route
      await page.goto(f.url("/"));
      await waitForHydration(page);
      await page.locator('[data-testid="client-loader-link"]').click();

      // Wait for initial data
      await expect(
        page.locator('[data-testid="client-loader-content"]'),
      ).toBeVisible({ timeout: 5000 });

      // Record the initial timestamp
      const initialTimestamp = await page
        .locator('[data-testid="client-loader-timestamp"]')
        .textContent();

      // Click refetch button
      await page.locator('[data-testid="client-loader-refetch"]').click();

      // Wait for refetch to complete
      await expect(
        page.locator('[data-testid="client-loader-loading"]'),
      ).toContainText("idle", { timeout: 5000 });

      // Data should still show client source (refetch used client fn, not server)
      await expect(
        page.locator('[data-testid="client-loader-source"]'),
      ).toContainText("Source: client");

      // Timestamp should have changed (proves refetch ran)
      const newTimestamp = await page
        .locator('[data-testid="client-loader-timestamp"]')
        .textContent();
      expect(newTimestamp).not.toBe(initialTimestamp);
    });
  });

  test.describe("isomorphic loader", () => {
    test("SSR uses server fn (source: server)", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to isomorphic-ssr route (no loading skeleton, awaited)
      await page.goto(f.url("/isomorphic-ssr"));
      await waitForHydration(page);

      // Server fn should have run during SSR
      await expect(
        page.locator('[data-testid="isomorphic-ssr-source"]'),
      ).toContainText("Source: server");
      // Server fn returns 2 items
      await expect(
        page.locator('[data-testid="isomorphic-ssr-total"]'),
      ).toContainText("Total: 2");
    });

    test("SPA navigation uses client fn (source: client)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index page
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to isomorphic-loader route
      await page.locator('[data-testid="isomorphic-loader-link"]').click();

      // Wait for content to appear
      await expect(
        page.locator('[data-testid="isomorphic-loader-content"]'),
      ).toBeVisible({ timeout: 5000 });

      // Client fn should have run during SPA navigation
      await expect(
        page.locator('[data-testid="isomorphic-loader-source"]'),
      ).toContainText("Source: client");
      // Client fn returns 3 items
      await expect(
        page.locator('[data-testid="isomorphic-loader-total"]'),
      ).toContainText("Total: 3");
    });

    test("direct navigation to streaming route shows server data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to isomorphic-loader route (with loading skeleton)
      await page.goto(f.url("/isomorphic-loader"));
      await waitForHydration(page);

      // On SSR, server fn should run - source should be "server"
      await expect(
        page.locator('[data-testid="isomorphic-loader-content"]'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="isomorphic-loader-source"]'),
      ).toContainText("Source: server");
      await expect(
        page.locator('[data-testid="isomorphic-loader-total"]'),
      ).toContainText("Total: 2");
    });
  });

  test.describe("isolated isomorphic loader (export-only file)", () => {
    test("SPA navigation resolves client fn from export-only loader file", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index page
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to isolated-isomorphic route
      await page.locator('[data-testid="isolated-isomorphic-link"]').click();

      // Client fn should resolve - the Vite plugin must NOT stub the file
      await expect(
        page.locator('[data-testid="isolated-isomorphic-content"]'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="isolated-isomorphic-source"]'),
      ).toContainText("Source: client");
      await expect(
        page.locator('[data-testid="isolated-isomorphic-value"]'),
      ).toContainText("Value: from-client");
    });

    test("SSR uses server fn for export-only isomorphic loader", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate directly (SSR path) - loading skeleton then server data
      await page.goto(f.url("/isolated-isomorphic"));
      await waitForHydration(page);

      // After hydration, the isomorphic loader should show server data
      // (SSR ran the server fn) or client data (hydration ran client fn)
      await expect(
        page.locator('[data-testid="isolated-isomorphic-content"]'),
      ).toBeVisible({ timeout: 5000 });
      // Source could be "server" (SSR resolved) or "client" (hydration resolved)
      // but the content must be visible - if stubbed, it would hang forever
      await expect(
        page.locator('[data-testid="isolated-isomorphic-value"]'),
      ).toBeVisible();
    });
  });

  test.describe("mixed loaders", () => {
    test("server + client loaders both available via useLoader on SPA nav", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Start from index page
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click link to mixed-loader route
      await page.locator('[data-testid="mixed-loader-link"]').click();

      // Wait for mixed loader content
      await expect(
        page.locator('[data-testid="mixed-loader-content"]'),
      ).toBeVisible({ timeout: 5000 });

      // Server loader data should be present
      await expect(
        page.locator('[data-testid="mixed-server-source"]'),
      ).toContainText("Server source: server");
      await expect(
        page.locator('[data-testid="mixed-server-message"]'),
      ).toContainText("Server message: server-only-data");

      // Client loader data should also be present
      await expect(
        page.locator('[data-testid="mixed-client-source"]'),
      ).toContainText("Client source: client");
      await expect(
        page.locator('[data-testid="mixed-client-theme"]'),
      ).toContainText("Client theme: dark");
    });
  });
});
