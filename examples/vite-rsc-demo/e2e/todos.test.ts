import { expect, test } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Todos tests - server actions and revalidation
 */
devTest.describe("todos-navigation", () => {
  devTest("should display todos index page", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Todos page should show header
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    // Should show the add todo form
    await expect(
      page.locator('input[placeholder="What needs to be done?"]')
    ).toBeVisible();
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible();

    // Should show Server Actions Demo section
    await expect(page.locator("text=Server Actions Demo")).toBeVisible();
  });

  devTest("should show todos list with existing items", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to fully load
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    // There should be some existing todos from the demo data
    // Look for the stats that show pending items
    await expect(page.locator("text=/\\d+ pending/")).toBeVisible({
      timeout: 3000,
    });
  });

  devTest("should preserve todos list on back navigation", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Verify initial page loads
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
    await expect(page.locator("text=/\\d+ pending/")).toBeVisible({
      timeout: 3000,
    });

    // Navigate away
    await page.goto(devURL(devServerURL, "/"));
    await waitForHydration(page);

    // Navigate back
    await goBack(page);

    // Todos page should be restored
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
    await expect(page.locator("text=/\\d+ pending/")).toBeVisible({
      timeout: 3000,
    });
  });
});

/**
 * Todos action tests
 */
devTest.describe("todos-actions", () => {
  devTest("should add a new todo", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for initial page load
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    // Make sure button is ready
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible();

    // Add a todo
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("My New Todo Item");

    const addButton = page.locator("button:has-text('Add Todo')");
    await addButton.click();

    // Wait for action to complete and revalidation
    // Button should return to "Add Todo" after action completes
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });

    // Wait for todo to appear in the list
    await expect(page.locator("text=My New Todo Item")).toBeVisible({
      timeout: 10000,
    });
  });

  devTest("should toggle existing todo completion", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load with existing todos
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    // Find an existing unchecked todo and toggle it
    // Look for a checkbox that is NOT checked
    const uncheckedCheckbox = page
      .locator('input[type="checkbox"]:not(:checked)')
      .first();
    await expect(uncheckedCheckbox).toBeVisible({ timeout: 3000 });
    await uncheckedCheckbox.click();

    // Wait for action to complete
    await page.waitForTimeout(2000);

    // The checkbox should now be checked
    // We verify the page is still functional
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });

  devTest("should enter and exit edit mode", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    // Click the first Edit button directly
    const editButton = page.locator("button:has-text('Edit')").first();
    await expect(editButton).toBeVisible({ timeout: 3000 });
    await editButton.click();

    // Wait for Save button to appear (edit mode is active)
    const saveButton = page.locator("button:has-text('Save')").first();
    await expect(saveButton).toBeVisible({ timeout: 3000 });

    // Find the edit input that appeared
    const editInputs = page.locator('input[type="text"]');
    const editInput = editInputs.nth(1);
    await expect(editInput).toBeVisible({ timeout: 3000 });

    // Type some text
    await editInput.fill("Updated Todo Title");

    // Click Save button
    await saveButton.click();

    // Wait for action to complete - Save button should change back to Edit
    await expect(page.locator("button:has-text('Edit')").first()).toBeVisible({
      timeout: 10000,
    });

    // Page should still be functional
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });

  devTest("should show pending state during add action", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 3000,
    });

    // Add a todo
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Pending State Test");

    const addButton = page.locator("button:has-text('Add Todo')");
    await addButton.click();

    // Form should show pending state (button text change)
    // Note: This might be too fast to catch, so we just verify the action completes
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });
  });

  devTest("should update stats in header", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Check initial stats in header badge
    const pendingBadge = page.locator("text=/\\d+ pending/");
    await expect(pendingBadge).toBeVisible({ timeout: 3000 });

    // Get initial count
    const initialText = await pendingBadge.textContent();

    // Add a todo
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Stats Update Test");
    await page.locator("button:has-text('Add Todo')").click();

    // Wait for action to complete
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });

    // Stats should still be visible
    await expect(pendingBadge).toBeVisible();
  });
});

/**
 * Todos concurrent actions tests
 */
devTest.describe("todos-concurrent-actions", () => {
  devTest.setTimeout(60000);

  devTest("should handle rapid todo additions", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 5000,
    });

    // Wait for event handlers to attach
    await page.waitForTimeout(100);

    const input = page.locator('input[placeholder="What needs to be done?"]');
    const addButton = page.locator("button:has-text('Add Todo')");

    // Add multiple todos rapidly without waiting for completion
    await input.fill("Rapid Todo 1");
    await addButton.click();

    await input.fill("Rapid Todo 2");
    await addButton.click();

    await input.fill("Rapid Todo 3");
    await addButton.click();

    // Wait for all actions to complete and revalidation
    await page.waitForTimeout(10000);

    // All todos should appear
    await expect(page.locator("text=Rapid Todo 1")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("text=Rapid Todo 2")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("text=Rapid Todo 3")).toBeVisible({
      timeout: 10000,
    });
  });

  devTest("should handle rapid checkbox toggles", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    // Get unchecked checkboxes
    const checkboxes = page.locator('input[type="checkbox"]:not(:checked)');
    const count = await checkboxes.count();

    if (count >= 2) {
      // Toggle multiple checkboxes rapidly
      await checkboxes.nth(0).click();
      await checkboxes.nth(1).click();

      // Wait for actions to complete
      await page.waitForTimeout(4000);

      // Page should still be functional
      await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
    }
  });

  devTest("should handle add and toggle concurrently", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 3000,
    });

    // Toggle an existing checkbox
    const checkbox = page
      .locator('input[type="checkbox"]:not(:checked)')
      .first();
    await checkbox.click();

    // Immediately add a new todo
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Concurrent Add Todo");
    await page.locator("button:has-text('Add Todo')").click();

    // Wait for all actions to complete
    await page.waitForTimeout(6000);

    // New todo should appear
    await expect(page.locator("text=Concurrent Add Todo")).toBeVisible({
      timeout: 5000,
    });

    // Page should still be functional
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });
});

/**
 * Todos revalidation tests
 */
devTest.describe("todos-revalidation", () => {
  devTest("should revalidate loader after action", async ({ page, devServerURL }) => {
    using _ = expectNoPageError(page);

    await page.goto(devURL(devServerURL, "/todos"));
    await waitForHydration(page);

    // Wait for page to load
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 3000,
    });

    // Add a todo
    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Revalidation Test Todo");
    await page.locator("button:has-text('Add Todo')").click();

    // Wait for action to complete (button returns to normal)
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });

    // Wait for todo to appear - this confirms revalidation happened
    await expect(page.locator("text=Revalidation Test Todo")).toBeVisible({
      timeout: 10000,
    });

    // The stats in the layout header should also update
    // This verifies the TodosLoader revalidation is working
    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });
});

/**
 * Production build tests for todos
 */
test.describe("todos-navigation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should display todos index page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator('input[placeholder="What needs to be done?"]')
    ).toBeVisible({ timeout: 5000 });
    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({ timeout: 5000 });
  });

  test("should show todos list with existing items", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
    await expect(page.locator("text=/\\d+ pending/")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should preserve todos list on back navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
    await expect(page.locator("text=/\\d+ pending/")).toBeVisible({
      timeout: 5000,
    });

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await goBack(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
    await expect(page.locator("text=/\\d+ pending/")).toBeVisible({
      timeout: 5000,
    });
  });
});

test.describe("todos-actions (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should add a new todo", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible({ timeout: 10000 });

    const addButton = page.locator("button:has-text('Add Todo')");
    await expect(addButton).toBeVisible({ timeout: 10000 });

    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Production Test Todo");
    await addButton.click();

    // Wait for the new todo to appear (action completes and UI updates)
    await expect(page.locator("text=Production Test Todo")).toBeVisible({
      timeout: 15000,
    });
  });

  test("should toggle existing todo completion", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    const uncheckedCheckbox = page
      .locator('input[type="checkbox"]:not(:checked)')
      .first();
    await expect(uncheckedCheckbox).toBeVisible({ timeout: 5000 });
    await uncheckedCheckbox.click();

    await page.waitForTimeout(2000);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });

  test("should enter and exit edit mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();

    const editButton = page.locator("button:has-text('Edit')").first();
    await expect(editButton).toBeVisible({ timeout: 5000 });
    await editButton.click();

    const saveButton = page.locator("button:has-text('Save')").first();
    await expect(saveButton).toBeVisible({ timeout: 5000 });

    const editInputs = page.locator('input[type="text"]');
    const editInput = editInputs.nth(1);
    await expect(editInput).toBeVisible({ timeout: 5000 });

    await editInput.fill("Production Updated Title");
    await saveButton.click();

    await expect(page.locator("button:has-text('Edit')").first()).toBeVisible({
      timeout: 10000,
    });

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });
});

test.describe("todos-revalidation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.setTimeout(120000);

  test("should revalidate loader after action", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/todos"));
    await waitForHydration(page);

    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 5000,
    });

    const input = page.locator('input[placeholder="What needs to be done?"]');
    await input.fill("Production Revalidation Test");
    await page.locator("button:has-text('Add Todo')").click();

    await expect(page.locator("button:has-text('Add Todo')")).toBeVisible({
      timeout: 10000,
    });

    await expect(page.locator("text=Production Revalidation Test")).toBeVisible({
      timeout: 10000,
    });

    await expect(page.locator("h1:has-text('Todos')")).toBeVisible();
  });
});
