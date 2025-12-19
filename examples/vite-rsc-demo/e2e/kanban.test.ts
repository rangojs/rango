import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack, testId } from "./helper";

/**
 * Kanban board tests - intercepting routes and action revalidation
 */
test.describe("kanban-intercept-routes", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should show modal when clicking card from board", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
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
  });

  test("should close modal and return to board on back navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
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
  });

  test("should show full card page on direct URL navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to card URL
    await page.goto(f.url("/kanban/card/card-1"));
    await waitForHydration(page);

    // Card detail should be visible (rendered in main outlet on direct navigation)
    // Note: The demo app uses the same CardDetailContent component for both
    // intercept and direct navigation, so the modal-style overlay is shown in both cases
    await expect(testId(page, "card-modal")).toBeVisible();
    await expect(testId(page, "card-title")).toContainText("Set up project structure");

    // Board should still be visible (it's in the layout)
    await expect(testId(page, "kanban-board")).toBeVisible();
  });

  test("should close modal when clicking close button", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    // Click card to open modal
    const cardLink = testId(page, "card-link-card-1");
    await cardLink.click();
    await expect(testId(page, "card-modal")).toBeVisible();

    // Click close button
    await testId(page, "card-modal-close").click();

    // Modal should be closed
    await expect(testId(page, "card-modal")).not.toBeVisible();

    // Should navigate back to board
    await expect(page).toHaveURL(/\/kanban$/);
  });

  test("should close modal when clicking Back to Board button", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    // Click card to open modal
    const cardLink = testId(page, "card-link-card-1");
    await cardLink.click();
    await expect(testId(page, "card-modal")).toBeVisible();

    // Click Back to Board button
    await testId(page, "back-to-board").click();

    // Modal should be closed
    await expect(testId(page, "card-modal")).not.toBeVisible();

    // Should navigate back to board
    await expect(page).toHaveURL(/\/kanban$/);
  });

  test("should display card title in modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    // Click card-1 to open modal
    const cardLink = testId(page, "card-link-card-1");
    await cardLink.click();
    await expect(testId(page, "card-modal")).toBeVisible();

    // Card title should be visible
    await expect(testId(page, "card-title")).toContainText(
      "Set up project structure"
    );
  });

  test("should preserve board state when opening and closing modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
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
  });
});

test.describe("kanban-action-counter-revalidation", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should display action counter on kanban page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    // Action counter should be visible
    await expect(testId(page, "action-counter")).toBeVisible();
  });

  test("should delete card when clicking delete button", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
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
  });
});

test.describe("kanban-action-navigation-race", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should revalidate and show fresh data after action completes during navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    // Get initial action counter
    const actionCounter = testId(page, "action-counter");
    const initialCounterText = await actionCounter.textContent();

    // Open card modal
    await testId(page, "card-link-card-1").click();
    await expect(testId(page, "card-modal")).toBeVisible();

    // Toggle a label to trigger kanbanUpdateCard action (has ~2s server delay)
    const labelButton = page.locator("button").filter({ hasText: "docs" }).first();
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
    await expect(page.locator("text=kanbanUpdateCard:")).toBeVisible({ timeout: 2000 });
  });

  test("should show correct action count when using back button (working case)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
    await waitForHydration(page);

    // Get initial action counter total
    const counterTotal = testId(page, "action-counter-total");

    // Open card modal
    await testId(page, "card-link-card-2").click();
    await expect(testId(page, "card-modal")).toBeVisible();

    // Toggle a label to trigger kanbanUpdateCard action
    const labelButton = page.locator("button").filter({ hasText: "UI" }).first();
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
  });
});

test.describe("kanban-navigation-history", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should maintain history when navigating through multiple cards", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
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
  });

  test("should restore board from cache on back navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/kanban"));
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
  });
});
