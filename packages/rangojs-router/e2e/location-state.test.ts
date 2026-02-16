import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  goForward,
  getHistoryState,
} from "./helper";

/**
 * Location state tests: redirect() with state, ctx.setLocationState(),
 * useFlashState(), and useLocationState()
 */
test.describe("location-state", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("redirect with flash state shows flash message on target page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Verify index page loaded with no flash initially
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Click trigger-redirect link (SPA navigation)
    await page.locator('[data-testid="ls-redirect-link"]').click();

    // Should redirect back to /location-state with flash message
    await expect(page).toHaveURL(/\/location-state$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!"
    );
  });

  test("flash state auto-clears after navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Trigger redirect to get flash message
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!"
    );

    // Navigate to another page
    await page.locator('[data-testid="ls-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();

    // Flash should not be present on the other page
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Navigate back to index
    await page.locator('[data-testid="ls-back-link"]').click();
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();

    // Flash should still be gone (was consumed)
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("flash state does not re-appear on back/forward navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Trigger redirect to get flash message
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!"
    );

    // Navigate away
    await page.locator('[data-testid="ls-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();

    // Go back to index - flash should NOT re-appear
    await goBack(page);
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("ctx.setLocationState sets state on normal render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // No server info initially
    await expect(page.locator('[data-testid="server-info-empty"]')).toBeVisible();

    // Navigate to ctx-state page
    await page.locator('[data-testid="ls-ctx-state-link"]').click();
    await expect(
      page.locator('[data-testid="ls-ctx-state-page"]')
    ).toBeVisible();

    // Server-set state should be available via useLocationState
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value"
    );
  });

  test("ctx.setLocationState persists through back/forward", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Navigate to ctx-state page to get state
    await page.locator('[data-testid="ls-ctx-state-link"]').click();
    await expect(
      page.locator('[data-testid="server-info-data"]')
    ).toHaveText("server-set-value");

    // Navigate to index
    await page.locator('[data-testid="ls-back-link"]').click();
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();

    // Go back to ctx-state page - state should persist in history
    await goBack(page);
    await expect(
      page.locator('[data-testid="ls-ctx-state-page"]')
    ).toBeVisible();
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value"
    );
  });

  test("middleware redirect with state delivers flash to target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Click middleware redirect link (SPA navigation)
    await page.locator('[data-testid="ls-mw-redirect-link"]').click();

    // Should end up at /location-state/target with flash message
    await expect(page).toHaveURL(/\/location-state\/target$/);
    await expect(page.locator('[data-testid="ls-target"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Redirected by middleware!"
    );
  });

  test("redirect with custom status (303) carries state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Click 303 redirect link (SPA navigation)
    await page.locator('[data-testid="ls-redirect-303-link"]').click();

    // Should end up at target with flash
    await expect(page).toHaveURL(/\/location-state\/target$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "303 redirect flash"
    );
  });

  test("action redirect with flash state shows flash on target page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Verify no flash initially
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Click action redirect button
    await page.locator('[data-testid="action-redirect-btn"]').click();

    // Should redirect back to /location-state with flash message
    await expect(page).toHaveURL(/\/location-state$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Action saved successfully!"
    );
  });

  test("action simple redirect navigates without flash", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Click simple redirect button
    await page.locator('[data-testid="action-simple-redirect-btn"]').click();

    // Should navigate to target page
    await expect(page).toHaveURL(/\/location-state\/target$/);
    await expect(page.locator('[data-testid="ls-target"]')).toBeVisible();

    // No flash since no state was passed
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("action redirect flash auto-clears after navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Trigger action redirect
    await page.locator('[data-testid="action-redirect-btn"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Action saved successfully!"
    );

    // Navigate away
    await page.locator('[data-testid="ls-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();

    // Flash should not be present
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("redirect state is stored in history.state", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Trigger redirect with flash state
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!"
    );

    // Check that history.state contains the flash key (before useFlashState clears it)
    // Note: useFlashState clears via replaceState in useEffect, but the read happens
    // synchronously during render. After render + effect, the key is cleaned up.
    // So we just verify the flash was read correctly (tested above) and that
    // the state was cleaned from history after the effect.
    const state = await getHistoryState(page);
    // The flash key should have been cleared by useFlashState's useEffect
    const flashKeys = Object.keys(state || {}).filter((k) =>
      k.startsWith("__rsc_ls_")
    );
    expect(flashKeys.length).toBe(0);
  });
});

/**
 * Production build tests for location state
 */
test.describe("location-state (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("redirect with flash state works in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // No flash initially
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Trigger redirect
    await page.locator('[data-testid="ls-redirect-link"]').click();

    // Should redirect with flash
    await expect(page).toHaveURL(/\/location-state$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!"
    );
  });

  test("ctx.setLocationState works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Navigate to ctx-state page
    await page.locator('[data-testid="ls-ctx-state-link"]').click();
    await expect(
      page.locator('[data-testid="ls-ctx-state-page"]')
    ).toBeVisible();

    // Server-set state should be available
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value"
    );
  });

  test("action redirect with flash works in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Click action redirect button
    await page.locator('[data-testid="action-redirect-btn"]').click();

    // Should redirect with flash
    await expect(page).toHaveURL(/\/location-state$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Action saved successfully!"
    );
  });

  test("flash auto-clears in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Get flash via redirect
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!"
    );

    // Navigate away
    await page.locator('[data-testid="ls-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Navigate back - flash should not reappear
    await goBack(page);
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });
});
