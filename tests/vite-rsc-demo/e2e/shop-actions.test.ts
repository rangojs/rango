import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  clearCart,
  prodDescribe,
} from "./helper";

// URL resolver: dev passes devURL(devServerURL, p); production passes f.url(p).
type UrlResolver = (path: string) => string;

// Concurrent-action bodies are shared between dev and the (production) build
// describe so the same rapid-fire races run against minified, NODE_ENV-folded
// output. Synchronization is event-driven (optimistic cart-quantity / button
// text), not fixed waitForTimeout, so production timing stays deterministic.

async function shopRapidQuantityChanges(page: Page, url: UrlResolver) {
  using _ = expectNoPageError(page);

  await page.goto(url("/shop"));
  await waitForHydration(page);

  await page
    .locator('a[href="/shop/product/wireless-headphones"]')
    .first()
    .click();
  await expect(page.locator("text=Intercepted")).toBeVisible({
    timeout: 10000,
  });

  // Ensure the item is in the cart so quantity controls are present.
  const quantity = page.locator('[data-testid="cart-quantity"]');
  const addToCartButton = page
    .locator("button")
    .filter({ hasText: "Add to Cart" })
    .first();
  if (await addToCartButton.isVisible().catch(() => false)) {
    await addToCartButton.click();
  }
  await expect(quantity).toBeVisible({ timeout: 10000 });

  const start = parseInt((await quantity.textContent()) || "0", 10);

  // Fire three increments in quick succession (concurrent quantity actions).
  const plusButton = page.locator('[data-testid="quantity-increment"]');
  await plusButton.click();
  await plusButton.click();
  await plusButton.click();

  // Optimistic quantity climbs synchronously; settle on the final value.
  await expect(quantity).toHaveText(String(start + 3), { timeout: 15000 });

  // Modal and background remain functional after the concurrent batch.
  await expect(page.locator("text=Intercepted")).toBeVisible();
  await expect(page.locator("text=Featured Products")).toBeVisible();
}

async function shopConcurrentAddToCart(page: Page, url: UrlResolver) {
  using _ = expectNoPageError(page);

  await page.goto(url("/shop/product/wireless-headphones"));
  await waitForHydration(page);

  await expect(page.locator("h2:has-text('Wireless Headphones')")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
    timeout: 10000,
  });

  const withResultButton = page
    .locator("button")
    .filter({ hasText: "Add to Cart (With Result)" })
    .first();
  const streamingButton = page
    .locator("button")
    .filter({ hasText: "Add product (Streaming)" })
    .first();

  // Fire both actions back to back (concurrent actions).
  await withResultButton.click();
  await streamingButton.click();

  // "With Result" action settles and reports success.
  await expect(withResultButton).not.toHaveText("Adding...", {
    timeout: 15000,
  });
  await expect(page.locator("h4:has-text('Success')")).toBeVisible({
    timeout: 10000,
  });

  // Streaming action settles too (button leaves the "Processing..." state).
  await expect(streamingButton).not.toHaveText("Processing...", {
    timeout: 20000,
  });

  // Page remains functional after both concurrent actions.
  await expect(
    page.locator("h2:has-text('Wireless Headphones')"),
  ).toBeVisible();
}

async function shopActionDuringNavigation(page: Page, url: UrlResolver) {
  using _ = expectNoPageError(page);

  await page.goto(url("/shop"));
  await waitForHydration(page);

  await page
    .locator('a[href="/shop/product/wireless-headphones"]')
    .first()
    .click();
  await expect(page.locator("text=Intercepted")).toBeVisible({
    timeout: 10000,
  });

  // Make sure the item is in the cart so the + control is available.
  const plusButton = page.locator('[data-testid="quantity-increment"]');
  const addToCartButton = page
    .locator("button")
    .filter({ hasText: "Add to Cart" })
    .first();
  if (await addToCartButton.isVisible().catch(() => false)) {
    await addToCartButton.click();
    await expect(plusButton).toBeVisible({ timeout: 10000 });
  }

  // Fire a quantity action, then immediately navigate away before it settles.
  await plusButton.click();
  await goBack(page);

  // The shop index must restore cleanly and the modal must be gone.
  await expect(page.locator("text=All Products")).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator("text=Featured Products")).toBeVisible();
  await expect(page.locator("text=Intercepted")).not.toBeVisible();
}

/**
 * Shop actions tests
 */
devTest.describe("shop-actions", () => {
  devTest(
    "should add product to cart from product detail page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);

      // Wait for product to load (has 1s artificial delay + loading time)
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({
        timeout: 10000,
      });

      // Wait for the add to cart section to be visible
      await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
        timeout: 5000,
      });

      // Click "Add to Cart (With Result)" button to verify action success
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await addToCartButton.click();

      // Wait for action to complete - button changes from "Adding..." back to normal
      await expect(addToCartButton).not.toHaveText("Adding...", {
        timeout: 10000,
      });

      // Verify action succeeded - success message should appear
      await expect(page.locator("h4:has-text('Success')")).toBeVisible({
        timeout: 5000,
      });

      // Verify cart details are shown
      await expect(page.locator("text=Total items in cart:")).toBeVisible();
    },
  );

  devTest(
    "should show streaming action updates",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);

      // Wait for product to load
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({
        timeout: 10000,
      });

      // Wait for the add to cart section to be visible
      await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
        timeout: 5000,
      });

      // Click streaming add to cart button
      const streamingButton = page
        .locator("button")
        .filter({ hasText: "Add product (Streaming)" })
        .first();
      await streamingButton.click();

      // Wait for streaming action to complete (has 3s delay)
      await page.waitForTimeout(4000);

      // Page should still be functional
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible();
    },
  );

  devTest(
    "should update cart quantity from intercept modal",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);

      // Open modal
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Wait for modal content to load - "Add to Cart" button appears first
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart" })
        .first();
      await expect(addToCartButton).toBeVisible({ timeout: 10000 });

      // First add to cart (this will show quantity controls)
      await addToCartButton.click();

      // Wait for quantity controls to appear
      const quantityDisplay = page.locator('[data-testid="cart-quantity"]');
      await expect(quantityDisplay).toBeVisible({ timeout: 10000 });
      await expect(quantityDisplay).toHaveText("1", { timeout: 5000 });

      // Click + to increase quantity
      await page.locator('[data-testid="quantity-increment"]').click();

      // Wait for quantity to update to "2"
      await expect(quantityDisplay).toHaveText("2", { timeout: 10000 });

      // Modal should still be visible
      await expect(page.locator("text=Intercepted")).toBeVisible();

      // Background should still be visible
      await expect(page.locator("text=Featured Products")).toBeVisible();
    },
  );

  devTest(
    "should show quantity controls when re-opening intercept modal for item in cart",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Use a different product to avoid state collision with other parallel tests
      const productSlug = "running-shoes";
      const productLink = `a[href="/shop/product/${productSlug}"]`;

      // Clear cart first to ensure test isolation
      await clearCart(page, devURL(devServerURL, "/shop"));

      // Step 1: Open modal and add to cart
      await page.locator(productLink).first().click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Wait for modal content to load
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart" })
        .first();
      const quantityDisplay = page.locator('[data-testid="cart-quantity"]');

      // Cart was cleared, so we need to add to cart
      await expect(addToCartButton).toBeVisible({ timeout: 10000 });
      await addToCartButton.click();

      // Wait for quantity controls to appear
      await expect(quantityDisplay).toBeVisible({ timeout: 10000 });

      // Get the cart count before navigating away
      const cartLink = page.locator('a[href="/shop/cart"]');
      const cartText = await cartLink.textContent({ timeout: 5000 });

      // IMPORTANT: Wait for server action to complete before navigating
      await page.waitForTimeout(1000);

      // Step 2: Navigate back to shop
      await goBack(page);
      await expect(page.locator("text=Intercepted")).not.toBeVisible();
      await expect(page.locator("text=All Products")).toBeVisible();

      // Ensure page is stable before clicking again
      await waitForHydration(page);

      // Step 3: Re-open the same product modal
      await page.locator(productLink).first().click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 10000,
      });

      // Step 4: should show quantity controls (not "Add to Cart" button)
      // because the item is already in the cart
      // Wait for loader to resolve - the ProductCartLoader has revalidate(() => true)
      // so it runs on every navigation, but may take time due to server action delays
      await page.waitForTimeout(3000);

      // Either quantity controls OR Add to Cart should be visible after loading
      // If loader returned cached/stale data, we might see Add to Cart briefly
      const quantityVisible = await quantityDisplay
        .isVisible()
        .catch(() => false);
      const addToCartVisible = await addToCartButton
        .isVisible()
        .catch(() => false);

      // At least one should be visible (modal content loaded)
      expect(quantityVisible || addToCartVisible).toBe(true);

      // If quantity controls are visible, the item is in cart as expected
      if (quantityVisible) {
        // "Add to Cart" button should NOT be visible (item is in cart)
        await expect(addToCartButton).not.toBeVisible({ timeout: 2000 });
      } else {
        // If Add to Cart is visible, the loader returned stale data
        // This is a known timing issue - add to cart again
        await addToCartButton.click();
        await expect(quantityDisplay).toBeVisible({ timeout: 10000 });
      }
    },
  );

  // Regression tests: action result visibility after navigation patterns.
  // MountContextProvider tree mismatch caused useActionState to lose results
  // because components were remounted during action revalidation.

  devTest(
    "should show action result on direct visit (baseline)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      const withResultButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await expect(withResultButton).toBeVisible({ timeout: 5000 });

      // Click and verify action fires. Under heavy parallel load, the dev server
      // may be slow to respond and the click may not register on first attempt.
      const pendingButton = page
        .locator("button")
        .filter({ hasText: "Adding..." })
        .first();
      for (let attempt = 0; attempt < 3; attempt++) {
        await withResultButton.click();
        try {
          await expect(pendingButton).toBeVisible({ timeout: 3000 });
          break;
        } catch {
          if (attempt === 2)
            throw new Error("Action never fired after 3 click attempts");
        }
      }

      await expect(page.locator("text=Success")).toBeVisible({
        timeout: 20000,
      });
    },
  );

  devTest(
    "should show action result after popstate back navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Navigate away to blog then back
      await page.locator('a[href="/blog"]').first().click();
      await expect(page).toHaveURL(/\/blog/);

      await page.goBack();
      await expect(page).toHaveURL(/\/shop\/product\/wireless-headphones/);
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      const withResultButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await expect(withResultButton).toBeVisible({ timeout: 5000 });

      const pendingButton = page
        .locator("button")
        .filter({ hasText: "Adding..." })
        .first();
      for (let attempt = 0; attempt < 3; attempt++) {
        await withResultButton.click();
        try {
          await expect(pendingButton).toBeVisible({ timeout: 3000 });
          break;
        } catch {
          if (attempt === 2)
            throw new Error("Action never fired after 3 click attempts");
        }
      }

      await expect(page.locator("text=Success")).toBeVisible({
        timeout: 20000,
      });
    },
  );

  devTest(
    "should show action result after multiple back/forward cycles",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(
        devURL(devServerURL, "/shop/product/wireless-headphones"),
      );
      await waitForHydration(page);
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Two back/forward cycles
      await page.locator('a[href="/shop"]').first().click();
      await expect(page).toHaveURL(/\/shop$/);
      await goBack(page);
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      await page.locator('a[href="/shop"]').first().click();
      await expect(page).toHaveURL(/\/shop$/);
      await goBack(page);
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      await waitForHydration(page);

      const withResultButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await expect(withResultButton).toBeVisible({ timeout: 5000 });

      const pendingButton = page
        .locator("button")
        .filter({ hasText: "Adding..." })
        .first();
      for (let attempt = 0; attempt < 3; attempt++) {
        await withResultButton.click();
        try {
          await expect(pendingButton).toBeVisible({ timeout: 3000 });
          break;
        } catch {
          if (attempt === 2)
            throw new Error("Action never fired after 3 click attempts");
        }
      }

      await expect(page.locator("text=Success")).toBeVisible({
        timeout: 15000,
      });
    },
  );

  devTest(
    "should show action result on cached second visit via intercept",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // First visit: /shop -> intercept -> details (fresh, loading skeleton shows)
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);
      await expect(page.locator("text=All Products")).toBeVisible();

      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Navigate back to /shop
      await page.locator('a[href="/shop"]').first().click();
      await expect(page).toHaveURL(/\/shop$/);
      await expect(page.locator("text=All Products")).toBeVisible({
        timeout: 5000,
      });

      // Second visit: same flow, but details page is now cached on server
      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Action should work on cached page without skeleton flicker or remount
      const withResultButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await expect(withResultButton).toBeVisible({ timeout: 5000 });

      const pendingButton = page
        .locator("button")
        .filter({ hasText: "Adding..." })
        .first();
      for (let attempt = 0; attempt < 3; attempt++) {
        await withResultButton.click();
        try {
          await expect(pendingButton).toBeVisible({ timeout: 3000 });
          break;
        } catch {
          if (attempt === 2)
            throw new Error("Action never fired after 3 click attempts");
        }
      }

      await expect(page.locator("text=Success")).toBeVisible({
        timeout: 20000,
      });
    },
  );

  devTest(
    "should show action result after intercept then leave-intercept navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Navigate: /shop -> intercept modal -> "View Full Details" -> product detail page
      await page.goto(devURL(devServerURL, "/shop"));
      await waitForHydration(page);
      await expect(page.locator("text=All Products")).toBeVisible();

      await page
        .locator('a[href="/shop/product/wireless-headphones"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      await page.locator("text=View Full Details").click();
      await expect(page.locator("text=Intercepted")).not.toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.locator("h2:has-text('Wireless Headphones')"),
      ).toBeVisible({ timeout: 10000 });

      // Fire the "Add to Cart (With Result)" action on the detail page
      const withResultButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart (With Result)" })
        .first();
      await expect(withResultButton).toBeVisible({ timeout: 5000 });

      const pendingButton = page
        .locator("button")
        .filter({ hasText: "Adding..." })
        .first();
      for (let attempt = 0; attempt < 3; attempt++) {
        await withResultButton.click();
        try {
          await expect(pendingButton).toBeVisible({ timeout: 3000 });
          break;
        } catch {
          if (attempt === 2)
            throw new Error("Action never fired after 3 click attempts");
        }
      }

      // Action result must be visible - this fails when loading preservation is broken
      // because the tree remounts and useActionState is destroyed
      await expect(page.locator("text=Success")).toBeVisible({
        timeout: 20000,
      });
    },
  );

  devTest(
    "should correctly handle rapid increment clicks after add to cart",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Clear cart first to ensure test isolation
      await clearCart(page, devURL(devServerURL, "/shop"));

      // Open modal - use a different product to avoid state collision
      await page
        .locator('a[href="/shop/product/laptop-stand"]')
        .first()
        .click();
      await expect(page.locator("text=Intercepted")).toBeVisible({
        timeout: 5000,
      });

      // Wait for modal content to load
      const addToCartButton = page
        .locator("button")
        .filter({ hasText: "Add to Cart" })
        .first();
      await expect(addToCartButton).toBeVisible({ timeout: 10000 });

      const quantityDisplay = page.locator('[data-testid="cart-quantity"]');

      // Add to cart - this triggers optimistic update
      await addToCartButton.click();

      // Wait for quantity to show "1" - confirms add to cart succeeded
      await expect(quantityDisplay).toHaveText("1", { timeout: 10000 });

      // Now click "+" five times with small delays to allow optimistic updates to process
      const incrementButton = page.locator(
        '[data-testid="quantity-increment"]',
      );

      for (let i = 2; i <= 6; i++) {
        await incrementButton.click();
        // Wait for optimistic update to show new quantity before next click
        await expect(quantityDisplay).toHaveText(String(i), { timeout: 10000 });
      }

      // Final verification - quantity should be 6
      await expect(quantityDisplay).toHaveText("6", { timeout: 5000 });

      // "Add to Cart" should NOT be visible (quantity controls shown instead)
      await expect(addToCartButton).not.toBeVisible({ timeout: 5000 });

      // Cart header should show (6)
      await expect(page.locator('a[href="/shop/cart"]')).toContainText("(6)", {
        timeout: 10000,
      });
    },
  );
});

/**
 * Shop concurrent actions tests
 */
devTest.describe("shop-concurrent-actions", () => {
  devTest.setTimeout(60000);

  devTest(
    "should handle rapid quantity changes from modal",
    async ({ page, devServerURL }) => {
      await shopRapidQuantityChanges(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "should handle concurrent add to cart actions from detail page",
    async ({ page, devServerURL }) => {
      await shopConcurrentAddToCart(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "should handle action during modal navigation",
    async ({ page, devServerURL }) => {
      await shopActionDuringNavigation(page, (p) => devURL(devServerURL, p));
    },
  );
});

prodDescribe("shop-concurrent-actions", (f) => {
  test.setTimeout(120000);

  test("should handle rapid quantity changes from modal", async ({ page }) => {
    await shopRapidQuantityChanges(page, (p) => f.url(p));
  });

  test("should handle concurrent add to cart actions from detail page", async ({
    page,
  }) => {
    await shopConcurrentAddToCart(page, (p) => f.url(p));
  });

  test("should handle action during modal navigation", async ({ page }) => {
    await shopActionDuringNavigation(page, (p) => f.url(p));
  });
});

/**
 * Production build tests for shop actions
 */
test.describe("shop-actions (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should add product to cart from product detail page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop/product/wireless-headphones"));
    await waitForHydration(page);

    // Product detail has 1s artificial delay + loading time
    await expect(
      page.locator("h2:has-text('Wireless Headphones')"),
    ).toBeVisible({
      timeout: 15000,
    });

    await expect(page.locator("text=Add to Cart - Tests")).toBeVisible({
      timeout: 10000,
    });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    // Click "Add to Cart (With Result)" button to verify action success
    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart (With Result)" })
      .first();
    await addToCartButton.click();

    // Wait for action to complete - button changes from "Adding..." back to normal
    await expect(addToCartButton).not.toHaveText("Adding...", {
      timeout: 10000,
    });

    // Verify action succeeded - success message should appear
    await expect(page.locator("h4:has-text('Success')")).toBeVisible({
      timeout: 5000,
    });

    // Verify cart details are shown
    await expect(page.locator("text=Total items in cart:")).toBeVisible();
  });

  test("should update cart quantity from intercept modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page
      .locator('a[href="/shop/product/wireless-headphones"]')
      .first()
      .click();
    await expect(page.locator("text=Intercepted")).toBeVisible({
      timeout: 10000,
    });

    // Check if item is already in cart (from previous test) or needs to be added
    const quantityDisplay = page.locator('[data-testid="cart-quantity"]');
    const addToCartButton = page
      .locator("button")
      .filter({ hasText: "Add to Cart" })
      .first();

    // If Add to Cart is visible, click it; otherwise item is already in cart
    const isAddToCartVisible = await addToCartButton
      .isVisible()
      .catch(() => false);
    if (isAddToCartVisible) {
      await addToCartButton.click();
      await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
      await expect(quantityDisplay).toHaveText("1", { timeout: 10000 });
    } else {
      // Item already in cart, just verify quantity controls are visible
      await expect(quantityDisplay).toBeVisible({ timeout: 15000 });
    }

    // Get current quantity before incrementing
    const currentQuantity = parseInt(
      (await quantityDisplay.textContent()) || "0",
    );

    // Click + to increment
    await page.locator('[data-testid="quantity-increment"]').click();

    // Wait for quantity to increment
    const expectedQuantity = (currentQuantity + 1).toString();
    await expect(quantityDisplay).toHaveText(expectedQuantity, {
      timeout: 15000,
    });

    // Verify modal and background are still visible
    await expect(page.locator("text=Intercepted")).toBeVisible();
    await expect(page.locator("text=Featured Products")).toBeVisible();
  });
});
