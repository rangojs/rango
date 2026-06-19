import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// Counter server actions over the workerd RSC stream. Assertions are relative
// to the observed starting value (initial+1 / current-1), so they are
// independent of the persisted counter state and hold in dev and the
// production build alike.
function describeCounter(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`counter server actions (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    test("should render counter with initial value", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/counter"));
      await waitForHydration(page);

      await expect(testId(page, "counter")).toBeVisible();
      await expect(testId(page, "counter-value")).toBeVisible();
      await expect(testId(page, "counter-increment")).toBeVisible();
      await expect(testId(page, "counter-decrement")).toBeVisible();
    });

    test("should increment counter via server action", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/counter"));
      await waitForHydration(page);

      // Get initial count
      const initialText = await testId(page, "counter-value").textContent();
      const initialCount = parseInt(initialText?.match(/\d+/)?.[0] ?? "0", 10);

      // Click increment and wait for count to update
      await testId(page, "counter-increment").click();
      await expect(testId(page, "counter-value")).toContainText(
        `Count: ${initialCount + 1}`,
        { timeout: 10000 },
      );
    });

    test("should decrement counter via server action", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/counter"));
      await waitForHydration(page);

      // First increment to make sure we have a positive count
      await testId(page, "counter-increment").click();
      await expect(testId(page, "counter-pending")).not.toBeVisible({
        timeout: 10000,
      });

      // Get current count
      const currentText = await testId(page, "counter-value").textContent();
      const currentCount = parseInt(currentText?.match(/\d+/)?.[0] ?? "0", 10);

      // Click decrement
      await testId(page, "counter-decrement").click();

      // Wait for action to complete
      await expect(testId(page, "counter-pending")).not.toBeVisible({
        timeout: 10000,
      });

      // Check count decreased
      const newText = await testId(page, "counter-value").textContent();
      const newCount = parseInt(newText?.match(/\d+/)?.[0] ?? "0", 10);
      expect(newCount).toBe(currentCount - 1);
    });

    test("should re-enable buttons after server action completes", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/counter"));
      await waitForHydration(page);

      // Buttons start enabled
      await expect(testId(page, "counter-increment")).toBeEnabled();
      await expect(testId(page, "counter-decrement")).toBeEnabled();

      // Click increment and wait for action to complete
      await testId(page, "counter-increment").click();
      await expect(testId(page, "counter-pending")).not.toBeVisible({
        timeout: 10000,
      });

      // Buttons should be enabled after action completes
      await expect(testId(page, "counter-increment")).toBeEnabled();
      await expect(testId(page, "counter-decrement")).toBeEnabled();
    });
  });
}

describeCounter("dev");
describeCounter("build");
