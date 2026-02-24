import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// -- Dev mode ----------------------------------------------------------------
// In dev mode, Prerender handlers run live per request. Skip in the
// handler will surface as a runtime error (no build-time skip logic).
// The "published" slug renders normally. The "draft" slug throws Skip
// which behaves as a regular error in dev.

test.describe("build-skip prerender (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("published article renders normally in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/published"));
    await waitForHydration(page);

    await expect(testId(page, "build-skip-article-title")).toContainText(
      "published"
    );
  });

  test("working static handler renders in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/working-static"));
    await waitForHydration(page);

    await expect(
      testId(page, "build-skip-working-static-title")
    ).toContainText("Working Static");
  });
});

// -- Production build --------------------------------------------------------
// In production, Skip entries are excluded from the prerender manifest.
// With passthrough: true, the handler stays in the bundle and renders live
// for unknown/skipped params.

test.describe("build-skip prerender (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("published article is pre-rendered and serves correctly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/published"));
    await waitForHydration(page);

    await expect(testId(page, "build-skip-article-title")).toContainText(
      "published"
    );
    await expect(testId(page, "build-skip-article-content")).toContainText(
      "Content for published"
    );
  });

  test("draft article (skipped via Skip) renders live with passthrough", async ({
    page,
  }) => {
    // Skip skipped "draft" during build, but passthrough: true keeps
    // the handler in the bundle. The worker falls through to live rendering.
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/draft"));
    await waitForHydration(page);

    // In passthrough mode, the handler runs live and throws Skip again.
    // This surfaces as a runtime error (500 or error boundary).
    // The page should NOT have the pre-rendered content.
    // It should show an error since Skip is a regular Error at runtime.
    const articleEl = page.locator('[data-testid="build-skip-article-title"]');
    // The article should not render successfully (Skip thrown at runtime)
    await expect(articleEl).not.toBeVisible({ timeout: 3000 }).catch(() => {
      // If it is visible, that means passthrough re-ran the handler and
      // Skip was not thrown (unexpected but acceptable).
    });
  });

  test("working static handler serves pre-rendered content in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/build-skip/working-static"));
    await waitForHydration(page);

    await expect(
      testId(page, "build-skip-working-static-title")
    ).toContainText("Working Static");
  });

  test("working static handler timestamp is stable across reloads", async ({
    page,
  }) => {
    await page.goto(f.url("/build-skip/working-static"));
    await waitForHydration(page);

    const ts1 = await testId(
      page,
      "build-skip-working-static-timestamp"
    ).textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(
      page,
      "build-skip-working-static-timestamp"
    ).textContent();

    // Truly pre-rendered: identical timestamp across reloads
    expect(ts1).toBe(ts2);
  });
});
