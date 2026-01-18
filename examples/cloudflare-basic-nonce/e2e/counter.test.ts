import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoCSPViolations,
  testId,
} from "./helper";

test.describe("counter server actions", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render counter with initial value", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await expect(testId(page, "counter")).toBeVisible();
    await expect(testId(page, "counter-value")).toBeVisible();
    await expect(testId(page, "counter-increment")).toBeVisible();
    await expect(testId(page, "counter-decrement")).toBeVisible();
  });

  test("should increment counter via server action", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Get initial count
    const initialText = await testId(page, "counter-value").textContent();
    const initialCount = parseInt(initialText?.match(/\d+/)?.[0] ?? "0", 10);

    // Click increment
    await testId(page, "counter-increment").click();

    // Should show pending state
    await expect(testId(page, "counter-pending")).toBeVisible();

    // Wait for pending to disappear and count to update
    await expect(testId(page, "counter-pending")).not.toBeVisible({ timeout: 10000 });

    // Check count increased
    const newText = await testId(page, "counter-value").textContent();
    const newCount = parseInt(newText?.match(/\d+/)?.[0] ?? "0", 10);
    expect(newCount).toBe(initialCount + 1);
  });

  test("should decrement counter via server action", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // First increment to make sure we have a positive count
    await testId(page, "counter-increment").click();
    await expect(testId(page, "counter-pending")).not.toBeVisible({ timeout: 10000 });

    // Get current count
    const currentText = await testId(page, "counter-value").textContent();
    const currentCount = parseInt(currentText?.match(/\d+/)?.[0] ?? "0", 10);

    // Click decrement
    await testId(page, "counter-decrement").click();

    // Wait for action to complete
    await expect(testId(page, "counter-pending")).not.toBeVisible({ timeout: 10000 });

    // Check count decreased
    const newText = await testId(page, "counter-value").textContent();
    const newCount = parseInt(newText?.match(/\d+/)?.[0] ?? "0", 10);
    expect(newCount).toBe(currentCount - 1);
  });

  test("should disable buttons during pending state", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Click increment
    await testId(page, "counter-increment").click();

    // Buttons should be disabled during pending
    await expect(testId(page, "counter-increment")).toBeDisabled();
    await expect(testId(page, "counter-decrement")).toBeDisabled();

    // Wait for action to complete
    await expect(testId(page, "counter-pending")).not.toBeVisible({ timeout: 10000 });

    // Buttons should be enabled again
    await expect(testId(page, "counter-increment")).toBeEnabled();
    await expect(testId(page, "counter-decrement")).toBeEnabled();
  });
});
