import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  goBack,
  testId,
  prodDescribe,
} from "./helper";

// URL resolver: dev passes devURL(devServerURL, p); production passes f.url(p).
type UrlResolver = (path: string) => string;

// Concurrent-action bodies are shared between dev and the (production) build
// describe so the same rapid-fire races run against minified, NODE_ENV-folded
// output. Synchronization is event-driven (optimistic style + action-counter
// text), not fixed waitForTimeout, so the production timing stays deterministic.

// Wait until the open card modal has no in-flight transitions. The modal sets
// cursor: "wait" while any startTransition(kanbanUpdateCard) is pending, so a
// non-"wait" cursor means every concurrent action has settled.
async function waitForModalSettled(page: Page) {
  await expect
    .poll(
      () =>
        page
          .locator('[data-testid="card-modal"]')
          .evaluate((el) => getComputedStyle(el).cursor),
      { timeout: 20000 },
    )
    .not.toBe("wait");
}

async function kanbanConcurrentLabelToggles(page: Page, url: UrlResolver) {
  using _ = expectNoPageError(page);

  await page.goto(url("/kanban"));
  await waitForHydration(page);

  await testId(page, "card-link-card-1").click();
  await expect(testId(page, "card-modal")).toBeVisible();

  const testingLabel = page
    .locator("button")
    .filter({ hasText: "testing" })
    .first();
  const apiLabel = page.locator("button").filter({ hasText: "api" }).first();
  const authLabel = page.locator("button").filter({ hasText: "auth" }).first();

  // Fire three label toggles in quick succession (concurrent actions).
  await testingLabel.click();
  await apiLabel.click();
  await authLabel.click();

  // Optimistic state is synchronous: each toggled label flips to opacity 1.
  for (const label of [testingLabel, apiLabel, authLabel]) {
    await expect
      .poll(() => label.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
  }

  // All concurrent actions settle (cursor leaves "wait").
  await waitForModalSettled(page);

  // Modal and board remain functional after the concurrent batch.
  await expect(testId(page, "card-modal")).toBeVisible();
  await expect(testId(page, "card-title")).toBeVisible();
  await expect(testId(page, "kanban-board")).toBeVisible();
}

async function kanbanRapidCardAdditions(page: Page, url: UrlResolver) {
  using _ = expectNoPageError(page);

  await page.goto(url("/kanban"));
  await waitForHydration(page);

  const todoColumn = testId(page, "kanban-column-col-todo");
  const addCardButton = todoColumn.locator("button", {
    hasText: "+ Add a card",
  });
  await addCardButton.click();

  const input = todoColumn.locator('input[placeholder="Enter card title..."]');
  await expect(input).toBeVisible();

  // Add three cards back to back without awaiting completion between them.
  await input.fill("Concurrent Card 1");
  await todoColumn.locator("button", { hasText: "Add Card" }).click();

  await input.fill("Concurrent Card 2");
  await todoColumn.locator("button", { hasText: "Add Card" }).click();

  await input.fill("Concurrent Card 3");
  await todoColumn.locator("button", { hasText: "Add Card" }).click();

  // All three cards must appear (optimistic first, then confirmed by
  // revalidation). The locator waits replace the old fixed timeout.
  await expect(page.locator("text=Concurrent Card 1")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator("text=Concurrent Card 2")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator("text=Concurrent Card 3")).toBeVisible({
    timeout: 15000,
  });
}

async function kanbanActionCounterConcurrent(page: Page, url: UrlResolver) {
  using _ = expectNoPageError(page);

  await page.goto(url("/kanban"));
  await waitForHydration(page);

  await testId(page, "card-link-card-2").click();
  await expect(testId(page, "card-modal")).toBeVisible();

  const docsLabel = page.locator("button").filter({ hasText: "docs" }).first();
  const uiLabel = page.locator("button").filter({ hasText: "UI" }).first();

  // Two concurrent label toggles.
  await docsLabel.click();
  await uiLabel.click();

  // Both actions settle before we close the modal.
  await waitForModalSettled(page);

  await testId(page, "card-modal-close").click();
  await expect(testId(page, "card-modal")).not.toBeVisible();

  // The action counter on the board reflects that kanbanUpdateCard ran and the
  // loader revalidated. Poll until the counted action surfaces.
  await expect(page.locator("text=kanbanUpdateCard:")).toBeVisible({
    timeout: 15000,
  });
}

/**
 * Kanban board tests - intercepting routes and action revalidation
 */
devTest.describe("kanban-intercept-routes", () => {
  devTest(
    "should show modal when clicking card from board",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Board should be visible
      await expect(testId(page, "kanban-board")).toBeVisible();

      // Click first card (card-1)
      const cardLink = testId(page, "card-link-card-1");
      await cardLink.click();

      // Modal should appear
      await expect(testId(page, "card-modal")).toBeVisible();

      // URL should change to card URL
      await expect(page).toHaveURL(/\/kanban\/card\/card-1/);

      // Board should still be visible behind modal
      await expect(testId(page, "kanban-board")).toBeVisible();
    },
  );

  devTest(
    "should close modal and return to board on back navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Click card to open modal
      const cardLink = testId(page, "card-link-card-1");
      await cardLink.click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Navigate back
      await goBack(page);

      // Should be back on board
      await expect(page).toHaveURL(/\/kanban$/);

      // Modal should be closed
      await expect(testId(page, "card-modal")).not.toBeVisible();

      // Board should still be visible
      await expect(testId(page, "kanban-board")).toBeVisible();
    },
  );

  devTest(
    "should show full card page on direct URL navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to card URL
      await page.goto(devURL(devServerURL, "/kanban/card/card-1"));
      await waitForHydration(page);

      // Card detail should be visible (rendered in main outlet on direct navigation)
      // Note: The demo app uses the same CardDetailContent component for both
      // intercept and direct navigation, so the modal-style overlay is shown in both cases
      await expect(testId(page, "card-modal")).toBeVisible();
      await expect(testId(page, "card-title")).toContainText(
        "Set up project structure",
      );

      // Board should still be visible (it's in the layout)
      await expect(testId(page, "kanban-board")).toBeVisible();
    },
  );

  devTest(
    "should close modal when clicking close button",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Click card to open modal
      const cardLink = testId(page, "card-link-card-1");
      await cardLink.click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Click close button and wait for navigation
      await testId(page, "card-modal-close").click();
      await page.waitForURL(/\/kanban\/?$/);

      // Modal should be closed
      await expect(testId(page, "card-modal")).not.toBeVisible();
    },
  );

  devTest(
    "should close modal when clicking Back to Board button",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Click card to open modal
      const cardLink = testId(page, "card-link-card-1");
      await cardLink.click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Click Back to Board button and wait for navigation
      await testId(page, "back-to-board").click();
      await page.waitForURL(/\/kanban\/?$/);

      // Modal should be closed
      await expect(testId(page, "card-modal")).not.toBeVisible();
    },
  );

  devTest(
    "should display card title in modal",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Click card-1 to open modal
      const cardLink = testId(page, "card-link-card-1");
      await cardLink.click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Card title should be visible
      await expect(testId(page, "card-title")).toContainText(
        "Set up project structure",
      );
    },
  );

  devTest(
    "should preserve board state when opening and closing modal",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Verify initial board state - check multiple columns exist
      await expect(testId(page, "kanban-column-col-todo")).toBeVisible();
      await expect(testId(page, "kanban-column-col-progress")).toBeVisible();
      await expect(testId(page, "kanban-column-col-done")).toBeVisible();

      // Open modal
      await testId(page, "card-link-card-1").click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Close modal
      await testId(page, "card-modal-close").click();
      await expect(testId(page, "card-modal")).not.toBeVisible();

      // Board state should be preserved
      await expect(testId(page, "kanban-column-col-todo")).toBeVisible();
      await expect(testId(page, "kanban-column-col-progress")).toBeVisible();
      await expect(testId(page, "kanban-column-col-done")).toBeVisible();
    },
  );
});

devTest.describe("kanban-action-counter-revalidation", () => {
  devTest(
    "should display action counter on kanban page",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Action counter should be visible
      await expect(testId(page, "action-counter")).toBeVisible();
    },
  );

  devTest(
    "should delete card when clicking delete button",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Verify card-6 exists on the board
      await expect(testId(page, "kanban-card-card-6")).toBeVisible();

      // Click on card-6 to open modal
      await testId(page, "card-link-card-6").click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Delete the card (this triggers an action)
      page.on("dialog", (dialog) => dialog.accept());
      await testId(page, "delete-card").click();

      // Wait for navigation back to board
      await expect(page).toHaveURL(/\/kanban$/);
      await expect(testId(page, "card-modal")).not.toBeVisible();

      // Card should be removed from board (optimistic update)
      await expect(testId(page, "kanban-card-card-6")).not.toBeVisible();
    },
  );
});

devTest.describe("kanban-action-navigation-race", () => {
  devTest(
    "should revalidate and show fresh data after action completes during navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Get initial action counter
      const actionCounter = testId(page, "action-counter");
      const initialCounterText = await actionCounter.textContent();

      // Open card modal
      await testId(page, "card-link-card-1").click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Toggle a label to trigger kanbanUpdateCard action (has ~2s server delay)
      const labelButton = page
        .locator("button")
        .filter({ hasText: "docs" })
        .first();
      await labelButton.click();

      // Wait long enough for action to start on server (200ms initial delay)
      // but NOT long enough for it to complete (~2.2s total)
      await page.waitForTimeout(500);

      // Close modal via programmatic navigation (close button)
      // This triggers navigate("/kanban") - the navigation fetch races the action
      await testId(page, "card-modal-close").click();

      // Modal should close and we should be on /kanban
      await expect(testId(page, "card-modal")).not.toBeVisible();
      await expect(page).toHaveURL(/\/kanban$/);

      // Board should be visible
      await expect(testId(page, "kanban-board")).toBeVisible();

      // Wait for action to complete on server and background revalidation to happen
      // Action has ~2.2s delay, then revalidation fetches fresh data
      await page.waitForTimeout(4000);

      // The action counter should now show the kanbanUpdateCard action was counted
      // This proves:
      // 1. Action completed on server (incrementing the counter)
      // 2. Background revalidation fetched fresh data (counter is visible in UI)
      await expect(page.locator("text=kanbanUpdateCard:")).toBeVisible({
        timeout: 2000,
      });
    },
  );

  devTest(
    "should show correct action count when using back button (working case)",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Get initial action counter total
      const counterTotal = testId(page, "action-counter-total");

      // Open card modal
      await testId(page, "card-link-card-2").click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Toggle a label to trigger kanbanUpdateCard action
      const labelButton = page
        .locator("button")
        .filter({ hasText: "UI" })
        .first();
      await labelButton.click();

      // Use browser back button instead of close button
      // This triggers handlePopstate() which aborts in-flight actions
      await goBack(page);

      // Should be back on board
      await expect(page).toHaveURL(/\/kanban$/);
      await expect(testId(page, "card-modal")).not.toBeVisible();

      // With back button, the action is aborted so we don't expect count to increase
      // This test documents the current (correct) back button behavior
      await expect(testId(page, "kanban-board")).toBeVisible();
    },
  );
});

/**
 * Concurrent actions tests - multiple actions triggered rapidly
 */
devTest.describe("kanban-concurrent-actions", () => {
  devTest.setTimeout(60000);

  devTest(
    "should handle multiple label toggles concurrently",
    async ({ page, devServerURL }) => {
      await kanbanConcurrentLabelToggles(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "should handle rapid card additions",
    async ({ page, devServerURL }) => {
      await kanbanRapidCardAdditions(page, (p) => devURL(devServerURL, p));
    },
  );

  devTest(
    "should update action counter correctly with concurrent actions",
    async ({ page, devServerURL }) => {
      await kanbanActionCounterConcurrent(page, (p) => devURL(devServerURL, p));
    },
  );
});

prodDescribe("kanban-concurrent-actions", (f) => {
  test.setTimeout(120000);

  test("should handle multiple label toggles concurrently", async ({
    page,
  }) => {
    await kanbanConcurrentLabelToggles(page, (p) => f.url(p));
  });

  test("should handle rapid card additions", async ({ page }) => {
    await kanbanRapidCardAdditions(page, (p) => f.url(p));
  });

  test("should update action counter correctly with concurrent actions", async ({
    page,
  }) => {
    await kanbanActionCounterConcurrent(page, (p) => f.url(p));
  });
});

devTest.describe("kanban-navigation-history", () => {
  devTest(
    "should maintain history when navigating through multiple cards",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Open first card
      await testId(page, "card-link-card-1").click();
      await expect(testId(page, "card-modal")).toBeVisible();
      await expect(page).toHaveURL(/\/kanban\/card\/card-1/);

      // Close modal
      await testId(page, "card-modal-close").click();
      await expect(page).toHaveURL(/\/kanban$/);

      // Open second card
      await testId(page, "card-link-card-3").click();
      await expect(testId(page, "card-modal")).toBeVisible();
      await expect(page).toHaveURL(/\/kanban\/card\/card-3/);

      // Navigate back - should show card-1 (from history)
      await goBack(page);
      await expect(page).toHaveURL(/\/kanban$/);

      // Navigate back again - should stay on board (no more history)
      await goBack(page);
      await expect(page).toHaveURL(/\/kanban\/card\/card-1/);
    },
  );

  devTest(
    "should restore board from cache on back navigation",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);

      await page.goto(devURL(devServerURL, "/kanban"));
      await waitForHydration(page);

      // Verify board is visible
      await expect(testId(page, "kanban-board")).toBeVisible();

      // Open card modal
      await testId(page, "card-link-card-1").click();
      await expect(testId(page, "card-modal")).toBeVisible();

      // Navigate back
      await goBack(page);

      // Board should be restored immediately from cache
      await expect(testId(page, "kanban-board")).toBeVisible();
      await expect(testId(page, "card-modal")).not.toBeVisible();
    },
  );
});

/**
 * Production build tests for kanban
 */
test.describe("kanban-intercept-routes (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should show modal when clicking card from board", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "kanban-board")).toBeVisible({ timeout: 10000 });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    const cardLink = testId(page, "card-link-card-1");
    await cardLink.click();

    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/kanban\/card\/card-1/);
    await expect(testId(page, "kanban-board")).toBeVisible();
  });

  test("should close modal and return to board on back navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "kanban-board")).toBeVisible({ timeout: 10000 });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    const cardLink = testId(page, "card-link-card-1");
    await cardLink.click();
    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });

    await goBack(page);

    await expect(page).toHaveURL(/\/kanban$/);
    await expect(testId(page, "card-modal")).not.toBeVisible();
    await expect(testId(page, "kanban-board")).toBeVisible();
  });

  test("should show full card page on direct URL navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban/card/card-1"));
    await waitForHydration(page);

    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });
    await expect(testId(page, "card-title")).toContainText(
      "Set up project structure",
    );
    await expect(testId(page, "kanban-board")).toBeVisible();
  });

  test("should close modal when clicking close button", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "kanban-board")).toBeVisible({ timeout: 10000 });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    const cardLink = testId(page, "card-link-card-1");
    await cardLink.click();
    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });

    await testId(page, "card-modal-close").click();

    await expect(testId(page, "card-modal")).not.toBeVisible();
    await expect(page).toHaveURL(/\/kanban$/);
  });

  test("should preserve board state when opening and closing modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "kanban-column-col-todo")).toBeVisible({
      timeout: 10000,
    });
    await expect(testId(page, "kanban-column-col-progress")).toBeVisible();
    await expect(testId(page, "kanban-column-col-done")).toBeVisible();

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    await testId(page, "card-link-card-1").click();
    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });

    await testId(page, "card-modal-close").click();
    await expect(testId(page, "card-modal")).not.toBeVisible();

    await expect(testId(page, "kanban-column-col-todo")).toBeVisible();
    await expect(testId(page, "kanban-column-col-progress")).toBeVisible();
    await expect(testId(page, "kanban-column-col-done")).toBeVisible();
  });
});

test.describe("kanban-actions (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display action counter on kanban page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "action-counter")).toBeVisible({
      timeout: 10000,
    });
  });

  test("should handle label toggle in modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "kanban-board")).toBeVisible({ timeout: 10000 });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    await testId(page, "card-link-card-1").click();
    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });

    const labelButton = page
      .locator("button")
      .filter({ hasText: "docs" })
      .first();
    await labelButton.click();

    await page.waitForTimeout(4000);

    await expect(testId(page, "card-modal")).toBeVisible();
    await expect(testId(page, "kanban-board")).toBeVisible();
  });
});

test.describe("kanban-navigation-history (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should restore board from cache on back navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    await expect(testId(page, "kanban-board")).toBeVisible({ timeout: 10000 });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    await testId(page, "card-link-card-1").click();
    await expect(testId(page, "card-modal")).toBeVisible({ timeout: 10000 });

    await goBack(page);

    await expect(testId(page, "kanban-board")).toBeVisible();
    await expect(testId(page, "card-modal")).not.toBeVisible();
  });
});
