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
