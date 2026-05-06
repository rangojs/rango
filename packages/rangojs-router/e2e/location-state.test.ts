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
 * useLocationState(), and useLocationState()
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
      "Item saved successfully!",
    );
  });

  test("flash state auto-clears after navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Trigger redirect to get flash message
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!",
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
      "Item saved successfully!",
    );

    // Navigate away
    await page.locator('[data-testid="ls-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();

    // Go back to index - flash should NOT re-appear
    await goBack(page);
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("ctx.setLocationState sets state on normal render", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // No server info initially
    await expect(
      page.locator('[data-testid="server-info-empty"]'),
    ).toBeVisible();

    // Navigate to ctx-state page
    await page.locator('[data-testid="ls-ctx-state-link"]').click();
    await expect(
      page.locator('[data-testid="ls-ctx-state-page"]'),
    ).toBeVisible();

    // Server-set state should be available via useLocationState
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value",
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
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value",
    );

    // Navigate to index
    await page.locator('[data-testid="ls-back-link"]').click();
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();

    // Go back to ctx-state page - state should persist in history
    await goBack(page);
    await expect(
      page.locator('[data-testid="ls-ctx-state-page"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value",
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
      "Redirected by middleware!",
    );
  });

  test("redirect with custom status (303) carries state", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Click 303 redirect link (SPA navigation)
    await page.locator('[data-testid="ls-redirect-303-link"]').click();

    // Should end up at target with flash
    await expect(page).toHaveURL(/\/location-state\/target$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "303 redirect flash",
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
      "Action saved successfully!",
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
      "Action saved successfully!",
    );

    // Navigate away
    await page.locator('[data-testid="ls-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();

    // Flash should not be present
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("thrown action redirect with flash state shows flash on target page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    // Click thrown redirect button
    await page.locator('[data-testid="throw-redirect-btn"]').click();

    // Should redirect back to /location-state with flash message
    await expect(page).toHaveURL(/\/location-state$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Thrown redirect flash!",
    );
  });

  test("thrown action simple redirect navigates without flash", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Click thrown simple redirect button
    await page.locator('[data-testid="throw-simple-redirect-btn"]').click();

    // Should navigate to target page
    await expect(page).toHaveURL(/\/location-state\/target$/);
    await expect(page.locator('[data-testid="ls-target"]')).toBeVisible();

    // No flash since no state was passed
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("redirect state is stored in history.state", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Trigger redirect with flash state
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!",
    );

    // Check that history.state contains the flash key (before useLocationState clears it)
    // Note: useLocationState clears via replaceState in useEffect, but the read happens
    // synchronously during render. After render + effect, the key is cleaned up.
    // So we just verify the flash was read correctly (tested above) and that
    // the state was cleaned from history after the effect.
    const state = await getHistoryState(page);
    // The flash key should have been cleared by useLocationState's useEffect
    const flashKeys = Object.keys(state || {}).filter((k) =>
      k.startsWith("__rsc_ls_"),
    );
    expect(flashKeys.length).toBe(0);
  });
});

/**
 * Link state prop tests — covers all 4 patterns:
 * 1. Typed eager: state={[Definition({ ... })]}
 * 2. Typed JIT: state={[Definition(() => ({ ... }))]}
 * 3. Plain static: state={{ key: value }}
 * 4. Plain JIT: state={() => ({ key: value })}
 */
test.describe("link-state-prop", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("typed eager state is delivered to target page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Click typed eager link
    await page.locator('[data-testid="link-typed-eager"]').click();
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();

    // Verify typed state was received
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("42");
  });

  test("typed JIT state is delivered to target page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Click typed JIT link
    await page.locator('[data-testid="link-typed-jit"]').click();
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();

    // Verify typed state was received (getter resolved at click time)
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "JIT Product",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("99");
  });

  test("typed JIT getter runs at click time, not render time", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // The TypedJitTimingLink sets a ref to 42 in useEffect (after mount).
    // The getter reads the ref: if resolved at render time it sees 0,
    // if resolved at click time it sees 42.
    await page.locator('[data-testid="link-typed-jit-timing"]').click();
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();

    // productPrice = 42 proves the getter ran after mount (at click time)
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "JIT Timing",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("42");
  });

  test("plain static state is delivered to target page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Click plain static link
    await page.locator('[data-testid="link-plain-static"]').click();
    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();

    // Verify plain state was received via useLocationState() (reads history.state.state)
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");
    await expect(page.locator('[data-testid="plain-count"]')).toHaveText("5");
  });

  test("plain JIT state is delivered to target page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Click plain JIT link (function called at click time)
    await page.locator('[data-testid="link-plain-jit"]').click();
    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();

    // Verify plain state was received
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("jit");
    await expect(page.locator('[data-testid="plain-count"]')).toHaveText("7");
  });

  test("typed state persists through back/forward navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Navigate to typed target
    await page.locator('[data-testid="link-typed-eager"]').click();
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );

    // Navigate back
    await page.locator('[data-testid="link-state-back"]').click();
    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Go back to typed target via browser back
    await goBack(page);
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("42");
  });

  test("plain state persists through back/forward navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Navigate to plain target
    await page.locator('[data-testid="link-plain-static"]').click();
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");

    // Navigate back
    await page.locator('[data-testid="link-state-back"]').click();
    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Go back to plain target via browser back
    await goBack(page);
    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");
    await expect(page.locator('[data-testid="plain-count"]')).toHaveText("5");
  });

  test("typed state stored in history.state with __rsc_ls_ prefix", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Navigate to typed target
    await page.locator('[data-testid="link-typed-eager"]').click();
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );

    // Verify typed state is keyed under __rsc_ls_ in history.state
    const state = await getHistoryState(page);
    const lsKeys = Object.keys(state || {}).filter((k) =>
      k.startsWith("__rsc_ls_"),
    );
    expect(lsKeys.length).toBe(1);
  });

  test("plain state stored in history.state.state", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Navigate to plain target
    await page.locator('[data-testid="link-plain-static"]').click();
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");

    // Verify plain state is stored under history.state.state (not __rsc_ls_ keys)
    const state = await getHistoryState(page);
    expect(state?.state).toEqual({ from: "list", count: 5 });
  });
});

/**
 * Production build tests for Link state prop
 */
test.describe("link-state-prop (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  test("typed eager state works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await page.locator('[data-testid="link-typed-eager"]').click();
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();

    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("42");
  });

  test("typed JIT state works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await page.locator('[data-testid="link-typed-jit"]').click();
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();

    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "JIT Product",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("99");
  });

  test("typed JIT getter runs at click time in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await page.locator('[data-testid="link-typed-jit-timing"]').click();
    await expect(
      page.locator('[data-testid="link-state-target"]'),
    ).toBeVisible();

    // productPrice = 42 proves the getter ran after mount (at click time)
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "JIT Timing",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("42");
  });

  test("plain static state works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await page.locator('[data-testid="link-plain-static"]').click();
    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();

    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");
    await expect(page.locator('[data-testid="plain-count"]')).toHaveText("5");
  });

  test("plain JIT state works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await page.locator('[data-testid="link-plain-jit"]').click();
    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();

    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("jit");
    await expect(page.locator('[data-testid="plain-count"]')).toHaveText("7");
  });

  test("typed state persists through back/forward in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Navigate to typed target
    await page.locator('[data-testid="link-typed-eager"]').click();
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );

    // Navigate back
    await page.locator('[data-testid="link-state-back"]').click();
    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Browser back to typed target
    await goBack(page);
    await expect(page.locator('[data-testid="typed-product-name"]')).toHaveText(
      "Eager Product",
    );
    await expect(
      page.locator('[data-testid="typed-product-price"]'),
    ).toHaveText("42");
  });

  test("plain state persists through back/forward in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    // Navigate to plain target
    await page.locator('[data-testid="link-plain-static"]').click();
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");

    // Navigate back
    await page.locator('[data-testid="link-state-back"]').click();
    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Browser back to plain target
    await goBack(page);
    await expect(page.locator('[data-testid="plain-from"]')).toHaveText("list");
    await expect(page.locator('[data-testid="plain-count"]')).toHaveText("5");
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
      "Item saved successfully!",
    );
  });

  test("ctx.setLocationState works in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Navigate to ctx-state page
    await page.locator('[data-testid="ls-ctx-state-link"]').click();
    await expect(
      page.locator('[data-testid="ls-ctx-state-page"]'),
    ).toBeVisible();

    // Server-set state should be available
    await expect(page.locator('[data-testid="server-info-data"]')).toHaveText(
      "server-set-value",
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
      "Action saved successfully!",
    );
  });

  test("thrown action redirect with flash works in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();

    await page.locator('[data-testid="throw-redirect-btn"]').click();

    await expect(page).toHaveURL(/\/location-state$/);
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Thrown redirect flash!",
    );
  });

  test("thrown action simple redirect works in production build", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    await page.locator('[data-testid="throw-simple-redirect-btn"]').click();

    await expect(page).toHaveURL(/\/location-state\/target$/);
    await expect(page.locator('[data-testid="ls-target"]')).toBeVisible();
    await expect(page.locator('[data-testid="flash-empty"]')).toBeVisible();
  });

  test("flash auto-clears in production build", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Get flash via redirect
    await page.locator('[data-testid="ls-redirect-link"]').click();
    await expect(page.locator('[data-testid="flash-text"]')).toHaveText(
      "Item saved successfully!",
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

/**
 * Stateful navigation failure tests — dev
 *
 * Verifies that when a Link-with-state navigation fails (network error),
 * the error UI renders at the target URL. The early pushState is intentional
 * and the failed destination owns the URL.
 */
test.describe("stateful-navigation-failure", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("failed stateful navigation shows error UI at source URL", async ({
    page,
  }) => {
    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Intercept only the RSC partial request to the target route
    await page.route(
      (url) =>
        url.pathname.includes("/location-state/link-state/target") &&
        url.searchParams.has("_rsc_partial"),
      (route) => route.abort("failed"),
    );

    // Click a Link with state
    await page.locator('[data-testid="link-typed-eager"]').click();

    // The error UI should appear
    await expect(page.getByRole("heading", { name: /error/i })).toBeVisible();

    // URL stays at source — pushState only happens on successful commit
    expect(page.url()).toContain("/location-state/link-state");
    expect(page.url()).not.toContain("/target");
  });
});

/**
 * Stateful navigation failure tests — production
 */
test.describe("stateful-navigation-failure (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("failed stateful navigation shows error UI at source URL", async ({
    page,
  }) => {
    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Intercept only the RSC partial request to the target route
    await page.route(
      (url) =>
        url.pathname.includes("/location-state/link-state/target") &&
        url.searchParams.has("_rsc_partial"),
      (route) => route.abort("failed"),
    );

    // Click a Link with state
    await page.locator('[data-testid="link-typed-eager"]').click();

    // The error UI should appear
    await expect(page.getByRole("heading", { name: /error/i })).toBeVisible();

    // URL stays at source — pushState only happens on successful commit
    expect(page.url()).toContain("/location-state/link-state");
    expect(page.url()).not.toContain("/target");
  });
});

/**
 * Superseded navigation race: clicking two stateful links in quick
 * succession must leave the URL at the second link's target, not
 * rolled back to the source by the first transaction's dispose.
 */
test.describe("stateful-navigation-superseded", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("second stateful nav wins when first is superseded", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    // Fire both clicks synchronously so the first navigation can't
    // re-render the page before the second click fires.
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-testid="link-typed-eager"]')!
        .click();
      document
        .querySelector<HTMLElement>('[data-testid="link-plain-static"]')!
        .click();
    });

    // The second navigation should win -- URL must be at its target
    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();
    expect(page.url()).toContain("/location-state/link-state/plain-target");
  });
});

test.describe("stateful-navigation-superseded (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("second stateful nav wins when first is superseded", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/link-state"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="link-state-index"]'),
    ).toBeVisible();

    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-testid="link-typed-eager"]')!
        .click();
      document
        .querySelector<HTMLElement>('[data-testid="link-plain-static"]')!
        .click();
    });

    await expect(
      page.locator('[data-testid="link-state-plain-target"]'),
    ).toBeVisible();
    expect(page.url()).toContain("/location-state/link-state/plain-target");
  });
});

/**
 * LocationState.write() / .delete() — static, non-reactive client API.
 *
 * Contract under test:
 *  1. write() persists across hard reload (history.state survives)
 *  2. write() persists across back/forward
 *  3. write() does not trigger useLocationState() readers (no event)
 *  4. write() merges with existing history.state (router bookkeeping intact)
 *  5. delete() removes the slot but leaves the rest of history.state
 */
function staticWriteSuite(f: ReturnType<typeof useFixture>) {
  test("write persists across hard reload", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/static-write"));
    await waitForHydration(page);

    await page.locator('[data-testid="sw-write-a"]').click();
    await expect(page.locator('[data-testid="sw-static-value"]')).toHaveText(
      "alpha:1",
    );

    await page.reload();
    await waitForHydration(page);

    await expect(page.locator('[data-testid="sw-static-value"]')).toHaveText(
      "alpha:1",
    );
  });

  test("write persists across back/forward", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/static-write"));
    await waitForHydration(page);

    await page.locator('[data-testid="sw-write-b"]').click();
    await expect(page.locator('[data-testid="sw-static-value"]')).toHaveText(
      "beta:2",
    );

    await page.locator('[data-testid="sw-other-link"]').click();
    await expect(page.locator('[data-testid="ls-other-page"]')).toBeVisible();

    await goBack(page);
    await expect(page.locator('[data-testid="ls-static-write"]')).toBeVisible();

    // Fresh mount re-reads from history.state on the original entry.
    await expect(page.locator('[data-testid="sw-static-value"]')).toHaveText(
      "beta:2",
    );
  });

  test("write is non-reactive: useLocationState does not update without nav", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/static-write"));
    await waitForHydration(page);

    // After mount, both surfaces show their "no value" rendering.
    await expect(page.locator('[data-testid="sw-static-empty"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="sw-reactive-empty"]'),
    ).toBeVisible();

    await page.locator('[data-testid="sw-write-a"]').click();

    await expect(page.locator('[data-testid="sw-static-value"]')).toHaveText(
      "alpha:1",
    );

    // write() must not dispatch popstate or __rsc_locationstate; the
    // reactive reader stays empty until the next real navigation.
    await expect(
      page.locator('[data-testid="sw-reactive-empty"]'),
    ).toBeVisible();
  });

  test("write merges with existing history.state; delete only removes the slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/location-state/static-write"));
    await waitForHydration(page);

    // Seed an unrelated marker key so we can assert merge behavior
    // independently of any router-managed keys (which may or may not be
    // present on a direct page load).
    await page.evaluate(() => {
      window.history.replaceState(
        { ...(window.history.state ?? {}), __test_marker: "preserve-me" },
        "",
      );
    });
    const beforeKeys = await page.evaluate(() =>
      Object.keys(window.history.state ?? {}).sort(),
    );
    expect(beforeKeys).toContain("__test_marker");

    await page.locator('[data-testid="sw-write-a"]').click();
    await expect(page.locator('[data-testid="sw-static-value"]')).toHaveText(
      "alpha:1",
    );

    const afterWrite = (await getHistoryState(page)) as Record<string, unknown>;
    // All pre-existing keys still present.
    for (const k of beforeKeys) {
      expect(afterWrite).toHaveProperty(k);
    }
    expect(afterWrite.__test_marker).toBe("preserve-me");
    // Exactly one new slot, holding the written value.
    const writtenSlot = Object.entries(afterWrite).find(([k, v]) => {
      if (beforeKeys.includes(k)) return false;
      return (
        v !== null &&
        typeof v === "object" &&
        "label" in v &&
        (v as { label: unknown }).label === "alpha"
      );
    })?.[0];
    expect(
      writtenSlot,
      "expected one new slot to hold the written value",
    ).toBeDefined();

    await page.locator('[data-testid="sw-delete"]').click();
    await expect(page.locator('[data-testid="sw-static-empty"]')).toBeVisible();

    const afterDelete = (await getHistoryState(page)) as Record<
      string,
      unknown
    >;
    // Pre-existing keys still intact.
    for (const k of beforeKeys) {
      expect(afterDelete).toHaveProperty(k);
    }
    expect(afterDelete.__test_marker).toBe("preserve-me");
    // Slot we wrote is gone.
    if (writtenSlot) {
      expect(afterDelete).not.toHaveProperty(writtenSlot);
    }

    // Navigation still works after write+delete.
    await page.locator('[data-testid="sw-index-link"]').click();
    await expect(page.locator('[data-testid="ls-index"]')).toBeVisible();
  });
}

test.describe("location-state.static-write", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  staticWriteSuite(f);
});

test.describe("location-state.static-write (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  staticWriteSuite(f);
});
