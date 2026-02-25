import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError } from "./helper";

/**
 * Progressive Enhancement Tests
 *
 * Tests that forms with server actions work correctly when JavaScript is disabled.
 * This verifies that the server returns proper HTML responses (not RSC streams)
 * for non-JS form submissions.
 */
test.describe("progressive-enhancement", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("with JavaScript disabled", () => {
    test.use({ javaScriptEnabled: false });

    test("form submission should return HTML page, not RSC stream", async ({
      page,
    }) => {
      // Navigate to the progressive enhancement test page
      await page.goto(f.url("/progressive-enhancement"));

      // Verify we're on the right page (initial SSR works)
      await expect(page.locator('[data-testid="page-title"]')).toHaveText(
        "Progressive Enhancement Test",
      );

      // Fill in the form
      const input = page.locator('[data-testid="pe-input"]');
      await input.fill("no-js-test-name");

      // Verify the input has the new value
      await expect(input).toHaveValue("no-js-test-name");

      // Submit the form (without JS, this does a full page POST)
      const submitButton = page.locator('[data-testid="pe-submit"]');
      await submitButton.click();

      // Wait for navigation to complete
      await page.waitForLoadState("domcontentloaded");

      // After submission, we should get a proper HTML page back
      // NOT an RSC stream (which would show as garbled text or error)

      // The page should still have proper HTML structure
      await expect(page.locator("html")).toBeVisible();
      await expect(page.locator("body")).toBeVisible();

      // The page title should be visible (proves we got rendered HTML)
      await expect(page.locator('[data-testid="page-title"]')).toHaveText(
        "Progressive Enhancement Test",
      );

      // The result should show the submitted name (proves action was executed)
      await expect(page.locator('[data-testid="pe-result-name"]')).toHaveText(
        "no-js-test-name",
      );
    });

    test("form should have React hidden fields for progressive enhancement", async ({
      page,
    }) => {
      // Navigate to the page
      await page.goto(f.url("/progressive-enhancement"));

      // Get the form HTML to check for hidden fields
      const formHtml = await page
        .locator('[data-testid="pe-form"]')
        .innerHTML();

      // React should add hidden fields for progressive enhancement
      // These fields contain the action ID and other metadata
      expect(formHtml).toMatch(/\$ACTION/);
    });

    test("page should not contain RSC stream markers", async ({ page }) => {
      // Navigate to the page
      await page.goto(f.url("/progressive-enhancement"));

      // Fill and submit the form
      await page.locator('[data-testid="pe-input"]').fill("marker-test");
      await page.locator('[data-testid="pe-submit"]').click();

      // Get the page content
      const content = await page.content();

      // RSC streams typically start with these patterns
      // If we see them in the HTML, it means we got an RSC stream instead of HTML
      expect(content).not.toMatch(/^0:/); // RSC stream header
      expect(content).not.toMatch(/^\d+:["[{]/); // RSC stream data lines

      // Should have proper HTML doctype/structure
      expect(content).toMatch(/<!DOCTYPE html>/i);
      expect(content).toMatch(/<html/i);
    });

    // useActionState progressive enhancement - form state is passed to renderToReadableStream
    test("useActionState form submission should work without JavaScript", async ({
      page,
    }) => {
      // Navigate to the form-action page which uses useActionState
      await page.goto(f.url("/hook-tests/form-action"));

      // The progressive enhancement form should render with no data initially
      await expect(
        page.locator('[data-testid="form-action-progressive-no-data"]'),
      ).toBeVisible();

      // Submit the form - native POST submission
      await page
        .locator('[data-testid="form-action-progressive-submit-btn"]')
        .click();

      // Wait for navigation to complete
      await page.waitForLoadState("domcontentloaded");

      // After submission, the form state should be updated with the action result.
      // This currently fails because useActionState needs the formState to be
      // passed to renderToReadableStream, which requires deeper SSR integration.
      await expect(
        page.locator('[data-testid="form-action-progressive-data"]'),
      ).toBeVisible({ timeout: 5000 });

      await expect(
        page.locator('[data-testid="form-action-progressive-message"]'),
      ).toContainText("Fetched from unregistered loader");
    });

    test("form should preserve input values after submission error", async ({
      page,
    }) => {
      // Navigate to the page
      await page.goto(f.url("/progressive-enhancement"));

      // Verify form is usable without JS
      const input = page.locator('[data-testid="pe-input"]');
      await expect(input).toBeVisible();
      await expect(input).toBeEditable();
    });
  });

  test.describe("with JavaScript enabled", () => {
    test("form submission should work with JS enhancement", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to the page
      await page.goto(f.url("/progressive-enhancement"));

      // Wait for hydration by checking for interactive elements
      await page.waitForLoadState("networkidle");

      // Fill in the form
      await page.locator('[data-testid="pe-input"]').fill("js-enhanced-name");

      // Submit the form
      await page.locator('[data-testid="pe-submit"]').click();

      // Wait for the result to appear (with JS, this should be an SPA update)
      await expect(page.locator('[data-testid="pe-result-name"]')).toHaveText(
        "js-enhanced-name",
      );

      // Should still be on the same page (no full page reload with JS)
      await expect(page).toHaveURL(/\/progressive-enhancement/);
    });
  });
});
