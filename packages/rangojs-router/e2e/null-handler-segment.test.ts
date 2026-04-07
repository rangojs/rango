import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Regression test: route segment included in partial diff when handler returns null.
 *
 * When a handler returns null (e.g. only ctx.set() side effects), the segment's
 * component is null. Previously this caused the segment to be omitted from the
 * partial diff, so SPA navigation to such a route failed with "Missing segment"
 * because the client couldn't reconcile children (child layouts, parallels).
 *
 * Full document requests always worked because the full match path includes all
 * segments unconditionally.
 */
test.describe("null-handler-segment (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("SPA navigation to null-handler route renders child layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at href index (different route group)
    await page.goto(f.url("/href"));
    await waitForHydration(page);
    await expect(testId(page, "href-index-page")).toBeVisible();

    // SPA navigate to null-handler route
    await testId(page, "goto-null-handler-link").click();
    await expect(testId(page, "null-handler-layout")).toBeVisible();

    // Child layout should render with ctx.set() data from the null handler
    await expect(testId(page, "null-handler-marker")).toHaveText(
      "from-null-handler",
    );

    // Parallel slot should render
    await expect(testId(page, "null-handler-child-plain")).toBeVisible();
    await expect(testId(page, "null-handler-child-plain-text")).toHaveText(
      "parallel slot rendered (plain)",
    );
  });

  test("direct navigation to null-handler route works", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href/null-handler"));
    await waitForHydration(page);

    await expect(testId(page, "null-handler-layout")).toBeVisible();
    await expect(testId(page, "null-handler-marker")).toHaveText(
      "from-null-handler",
    );
    await expect(testId(page, "null-handler-child-plain")).toBeVisible();
  });

  test("SPA navigation to null-handler-cached route renders child layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);

    await testId(page, "goto-null-handler-cached-link").click();
    await expect(testId(page, "null-handler-cached-layout")).toBeVisible();
    await expect(testId(page, "null-handler-cached-marker")).toHaveText(
      "from-cached-null-handler",
    );
    await expect(testId(page, "null-handler-child-cached")).toBeVisible();
  });

  test("direct navigation to null-handler-cached route works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href/null-handler-cached"));
    await waitForHydration(page);

    await expect(testId(page, "null-handler-cached-layout")).toBeVisible();
    await expect(testId(page, "null-handler-cached-marker")).toHaveText(
      "from-cached-null-handler",
    );
    await expect(testId(page, "null-handler-child-cached")).toBeVisible();
  });

  test("SPA navigation to null-handler-use-cache route renders child layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);

    await testId(page, "goto-null-handler-use-cache-link").click();
    await expect(testId(page, "null-handler-use-cache-layout")).toBeVisible();
    // No marker check — ctx.set() not allowed inside "use cache"
    await expect(testId(page, "null-handler-child-use-cache")).toBeVisible();
  });

  test("direct navigation to null-handler-use-cache route works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href/null-handler-use-cache"));
    await waitForHydration(page);

    await expect(testId(page, "null-handler-use-cache-layout")).toBeVisible();
    // No marker check — ctx.set() not allowed inside "use cache"
    await expect(testId(page, "null-handler-child-use-cache")).toBeVisible();
  });
});

test.describe("null-handler-segment (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("SPA navigation to null-handler route renders child layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);
    await expect(testId(page, "href-index-page")).toBeVisible();

    await testId(page, "goto-null-handler-link").click();
    await expect(testId(page, "null-handler-layout")).toBeVisible();
    await expect(testId(page, "null-handler-marker")).toHaveText(
      "from-null-handler",
    );
    await expect(testId(page, "null-handler-child-plain")).toBeVisible();
    await expect(testId(page, "null-handler-child-plain-text")).toHaveText(
      "parallel slot rendered (plain)",
    );
  });

  test("direct navigation to null-handler route works", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href/null-handler"));
    await waitForHydration(page);

    await expect(testId(page, "null-handler-layout")).toBeVisible();
    await expect(testId(page, "null-handler-marker")).toHaveText(
      "from-null-handler",
    );
    await expect(testId(page, "null-handler-child-plain")).toBeVisible();
  });

  test("SPA navigation to null-handler-cached route renders child layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);

    await testId(page, "goto-null-handler-cached-link").click();
    await expect(testId(page, "null-handler-cached-layout")).toBeVisible();
    await expect(testId(page, "null-handler-cached-marker")).toHaveText(
      "from-cached-null-handler",
    );
    await expect(testId(page, "null-handler-child-cached")).toBeVisible();
  });

  test("direct navigation to null-handler-cached route works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href/null-handler-cached"));
    await waitForHydration(page);

    await expect(testId(page, "null-handler-cached-layout")).toBeVisible();
    await expect(testId(page, "null-handler-cached-marker")).toHaveText(
      "from-cached-null-handler",
    );
    await expect(testId(page, "null-handler-child-cached")).toBeVisible();
  });

  test("SPA navigation to null-handler-use-cache route renders child layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href"));
    await waitForHydration(page);

    await testId(page, "goto-null-handler-use-cache-link").click();
    await expect(testId(page, "null-handler-use-cache-layout")).toBeVisible();
    // No marker check — ctx.set() not allowed inside "use cache"
    await expect(testId(page, "null-handler-child-use-cache")).toBeVisible();
  });

  test("direct navigation to null-handler-use-cache route works", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/href/null-handler-use-cache"));
    await waitForHydration(page);

    await expect(testId(page, "null-handler-use-cache-layout")).toBeVisible();
    // No marker check — ctx.set() not allowed inside "use cache"
    await expect(testId(page, "null-handler-child-use-cache")).toBeVisible();
  });
});
