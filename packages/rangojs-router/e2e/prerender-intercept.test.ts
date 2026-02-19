import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

test.describe("prerender-intercept (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("direct navigation shows full detail page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="pri-detail"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-detail-title"]')).toContainText("alpha");
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
  });

  test("client navigation from index shows modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText("alpha");
    await expect(page.locator('[data-testid="pri-modal-indicator"]')).toContainText("Intercepted");
  });

  test("back navigation from modal hides it", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();

    await goBack(page);
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="pri-index"]')).toBeVisible();
  });

  test("loader data is fresh on intercept navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    const ts1 = await page.locator('[data-testid="fresh-timestamp"]').textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page.locator('[data-testid="fresh-timestamp"]').textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    expect(ts2).not.toBe(ts1);
  });
});

test.describe("prerender-intercept (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("direct navigation shows full detail page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="pri-detail"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-detail-title"]')).toContainText("alpha");
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
  });

  test("client navigation from index shows modal", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText("alpha");
    await expect(page.locator('[data-testid="pri-modal-indicator"]')).toContainText("Intercepted");
  });

  test("back navigation from modal hides it", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();

    await goBack(page);
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="pri-index"]')).toBeVisible();
  });

  test("loader data is fresh on pre-rendered detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    const ts1 = await page.locator('[data-testid="fresh-timestamp"]').textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page.locator('[data-testid="fresh-timestamp"]').textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    expect(ts2).not.toBe(ts1);
  });

  test("different params render different detail content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);
    await expect(page.locator('[data-testid="pri-detail-title"]')).toContainText("alpha");

    await page.goto(f.url("/prerender-intercept/beta"));
    await waitForHydration(page);
    await expect(page.locator('[data-testid="pri-detail-title"]')).toContainText("beta");
  });
});
