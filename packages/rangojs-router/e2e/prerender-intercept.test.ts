import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

// ---------------------------------------------------------------------------
// Dev mode: intercept + prerender on-demand rendering
// ---------------------------------------------------------------------------
test.describe("prerender-intercept (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("direct navigation renders full detail page without modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    // Full detail page renders
    await expect(page.locator('[data-testid="pri-detail"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="pri-detail-title"]'),
    ).toContainText("alpha");
    await expect(
      page.locator('[data-testid="pri-detail-content"]'),
    ).toContainText("Full detail page for alpha");
    // Handler-time marker is present (rendered on-demand in dev)
    const handlerTime = await page
      .locator('[data-testid="pri-handler-time"]')
      .textContent();
    expect(handlerTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Modal must NOT be visible on direct navigation
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
  });

  test("client navigation from index shows modal via intercept", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    // Index page visible
    await expect(page.locator('[data-testid="pri-index"]')).toBeVisible();

    // Click link to alpha
    await page.locator('[data-testid="pri-link-alpha"]').click();

    // Modal appears with intercept content
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText(
      "alpha",
    );
    await expect(
      page.locator('[data-testid="pri-modal-indicator"]'),
    ).toContainText("Intercepted");

    // Modal render-time marker is present
    const modalTime = await page
      .locator('[data-testid="pri-modal-render-time"]')
      .textContent();
    expect(modalTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("back navigation from modal returns to index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();

    await goBack(page);

    // Modal is gone, index is back
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="pri-index"]')).toBeVisible();
  });

  test("loader data is fresh on every request", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    // Loader always returns fresh data -- timestamps must differ
    expect(ts2).not.toBe(ts1);
  });

  test("different params render different detail pages", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="pri-detail-title"]'),
    ).toContainText("alpha");
    await expect(
      page.locator('[data-testid="pri-detail-content"]'),
    ).toContainText("Full detail page for alpha");

    await page.goto(f.url("/prerender-intercept/beta"));
    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="pri-detail-title"]'),
    ).toContainText("beta");
    await expect(
      page.locator('[data-testid="pri-detail-content"]'),
    ).toContainText("Full detail page for beta");
  });

  test("intercept works for both alpha and beta params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    // Intercept alpha
    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText(
      "alpha",
    );

    await goBack(page);
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();

    // Intercept beta
    await page.locator('[data-testid="pri-link-beta"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText(
      "beta",
    );
  });
});

// ---------------------------------------------------------------------------
// Production build: proves prerender store is used (frozen handler content)
// ---------------------------------------------------------------------------
test.describe("prerender-intercept (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("direct navigation renders full detail page without modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="pri-detail"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="pri-detail-title"]'),
    ).toContainText("alpha");
    await expect(
      page.locator('[data-testid="pri-detail-content"]'),
    ).toContainText("Full detail page for alpha");

    // Handler-time marker present
    const handlerTime = await page
      .locator('[data-testid="pri-handler-time"]')
      .textContent();
    expect(handlerTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // No modal on direct navigation
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
  });

  test("handler content is frozen across reloads (proves prerender store)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First load
    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);

    const handlerTime1 = await page
      .locator('[data-testid="pri-handler-time"]')
      .textContent();
    const loaderTs1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();

    // Second load
    await page.reload();
    await waitForHydration(page);

    const handlerTime2 = await page
      .locator('[data-testid="pri-handler-time"]')
      .textContent();
    const loaderTs2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();

    // Handler render time is baked at build time -- identical across reloads.
    // This is the definitive proof that content comes from the prerender store,
    // not from live handler execution.
    expect(handlerTime1).toBe(handlerTime2);
    expect(handlerTime1).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Loader timestamp differs -- loaders are never cached, always fresh.
    expect(Number(loaderTs1)).toBeGreaterThan(0);
    expect(Number(loaderTs2)).toBeGreaterThan(0);
    expect(loaderTs1).not.toBe(loaderTs2);
  });

  test("client navigation from index shows modal via intercept", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);
    await expect(page.locator('[data-testid="pri-index"]')).toBeVisible();

    await page.locator('[data-testid="pri-link-alpha"]').click();

    // Modal appears
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText(
      "alpha",
    );
    await expect(
      page.locator('[data-testid="pri-modal-indicator"]'),
    ).toContainText("Intercepted");

    // Modal render-time marker is present (from prerender store)
    const modalTime = await page
      .locator('[data-testid="pri-modal-render-time"]')
      .textContent();
    expect(modalTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("modal content is frozen across intercept navigations (proves prerender store)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First intercept navigation
    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    const modalTime1 = await page
      .locator('[data-testid="pri-modal-render-time"]')
      .textContent();

    // Go back, then intercept again
    await goBack(page);
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    const modalTime2 = await page
      .locator('[data-testid="pri-modal-render-time"]')
      .textContent();

    // Modal render time is baked at build time -- identical across navigations.
    // This proves the intercept variant is served from the prerender store.
    expect(modalTime1).toBe(modalTime2);
    expect(modalTime1).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("back navigation from modal returns to index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();

    await goBack(page);

    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="pri-index"]')).toBeVisible();
  });

  test("different params render different detail content from prerender store", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Alpha
    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="pri-detail-title"]'),
    ).toContainText("alpha");
    await expect(
      page.locator('[data-testid="pri-detail-content"]'),
    ).toContainText("Full detail page for alpha");
    const alphaTime = await page
      .locator('[data-testid="pri-handler-time"]')
      .textContent();

    // Beta
    await page.goto(f.url("/prerender-intercept/beta"));
    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="pri-detail-title"]'),
    ).toContainText("beta");
    await expect(
      page.locator('[data-testid="pri-detail-content"]'),
    ).toContainText("Full detail page for beta");
    const betaTime = await page
      .locator('[data-testid="pri-handler-time"]')
      .textContent();

    // Both have frozen handler times (from build), but they can differ
    // because alpha and beta are built as separate prerender entries
    expect(alphaTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(betaTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("intercept works for both alpha and beta params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    // Intercept alpha
    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText(
      "alpha",
    );

    await goBack(page);
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();

    // Intercept beta
    await page.locator('[data-testid="pri-link-beta"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pri-modal-title"]')).toContainText(
      "beta",
    );
  });

  test("intercept loader runs fresh at runtime (not pre-rendered)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First intercept navigation
    await page.goto(f.url("/prerender-intercept"));
    await waitForHydration(page);

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();

    // The FreshTimestampLoader is attached to the intercept route.
    // It uses useLoader() client-side to display fresh data.
    // Even though the modal handler is pre-rendered, the loader runs fresh.
    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    // Go back and intercept again
    await goBack(page);
    await expect(page.locator('[data-testid="pri-modal"]')).not.toBeVisible();

    await page.locator('[data-testid="pri-link-alpha"]').click();
    await expect(page.locator('[data-testid="pri-modal"]')).toBeVisible();

    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    // Loader timestamp must differ -- proves loaders are NOT pre-rendered
    expect(ts2).not.toBe(ts1);
  });

  test("layout wraps both detail and modal outlet", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-intercept/alpha"));
    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="prerender-intercept-layout"]'),
    ).toBeVisible();
  });
});
