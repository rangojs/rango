import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

test.describe("prerender-handler (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("static prerender handler renders on-demand", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="docs-title"]')).toContainText(
      "Documentation"
    );
    await expect(page.locator('[data-testid="docs-content"]')).toContainText(
      "pre-rendered documentation content"
    );
    await expect(page.locator('[data-testid="docs-pathname"]')).toContainText(
      "/docs"
    );
  });

  test("dynamic prerender handler renders with params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/getting-started"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]')
    ).toContainText("getting-started");
    await expect(
      page.locator('[data-testid="docs-article-content"]')
    ).toContainText("Content for getting-started");
  });

  test("prerender client component resolves loader, action, and locationState", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/getting-started"));
    await waitForHydration(page);

    // Loader data should be resolved and rendered by useLoader
    await expect(
      page.locator('[data-testid="prerender-loader-data"]')
    ).toContainText("prerender-loader-data");
    await expect(
      page.locator('[data-testid="prerender-loader-test"]')
    ).toContainText("true");

    // useAction should work with directly imported action
    await expect(
      page.locator('[data-testid="prerender-action-state"]')
    ).toContainText("idle");

    // Verify loader has $$id injected
    const loaderJson = await page.locator('[data-testid="prerender-loader-json"]').textContent();
    const loaderObj = JSON.parse(loaderJson!);
    expect(loaderObj.$$id).toBeTruthy();

    // Verify action has $$id injected (via direct import, not prop)
    const actionId = await page.locator('[data-testid="prerender-action-id"]').textContent();
    expect(actionId).not.toBe("no-action-id");

    // Verify location state has __rsc_ls_key injected
    const locationStateKey = await page.locator('[data-testid="prerender-location-state-key"]').textContent();
    expect(locationStateKey).not.toBe("no-ls-key");
  });

  test("dynamic prerender handler renders different params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/api-reference"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]')
    ).toContainText("api-reference");
    await expect(
      page.locator('[data-testid="docs-article-content"]')
    ).toContainText("Content for api-reference");
  });

  test("client navigation to prerender route works", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start at the index page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to a prerender route
    await page.goto(f.url("/docs/api-reference"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]')
    ).toContainText("api-reference");
  });
});
