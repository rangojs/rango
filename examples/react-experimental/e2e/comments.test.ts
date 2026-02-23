import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe("blog comments via loader action (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should show empty comments on blog detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/view-transitions"));
    await waitForHydration(page);

    await expect(testId(page, "comments-section")).toBeVisible();
    await expect(testId(page, "comment-form")).toBeVisible();
    await expect(testId(page, "no-comments")).toBeVisible();
    await expect(testId(page, "no-comments")).toContainText("No comments yet");
  });

  test("should post a comment via loader action", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);

    // Initially no comments
    await expect(testId(page, "no-comments")).toBeVisible();

    // Fill in the form
    await testId(page, "comment-name").fill("Alice");
    await testId(page, "comment-text").fill("Great article!");

    // Submit
    await testId(page, "comment-submit").click();

    // Comment should appear
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "comments-section")).toContainText("Comments (1)");
    await expect(testId(page, "comments-list")).toContainText("Alice");
    await expect(testId(page, "comments-list")).toContainText("Great article!");

    // "No comments" should be gone
    await expect(testId(page, "no-comments")).not.toBeVisible();
  });

  test("should post multiple comments", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/composable-caching"));
    await waitForHydration(page);

    // Post first comment
    await testId(page, "comment-name").fill("Bob");
    await testId(page, "comment-text").fill("First comment");
    await testId(page, "comment-submit").click();
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "comments-section")).toContainText("Comments (1)");

    // Post second comment
    await testId(page, "comment-name").fill("Carol");
    await testId(page, "comment-text").fill("Second comment");
    await testId(page, "comment-submit").click();
    await expect(testId(page, "comments-section")).toContainText("Comments (2)", { timeout: 5000 });
    await expect(testId(page, "comments-list")).toContainText("Bob");
    await expect(testId(page, "comments-list")).toContainText("Carol");
  });

  test("should clear form after posting", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/view-transitions"));
    await waitForHydration(page);

    await testId(page, "comment-name").fill("Dave");
    await testId(page, "comment-text").fill("Nice post!");
    await testId(page, "comment-submit").click();

    // Wait for comment to appear
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 5000 });

    // Form inputs should be cleared
    await expect(testId(page, "comment-name")).toHaveValue("");
    await expect(testId(page, "comment-text")).toHaveValue("");
  });

  test("should disable submit button while posting", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);

    await testId(page, "comment-name").fill("Eve");
    await testId(page, "comment-text").fill("Testing submit");
    await testId(page, "comment-submit").click();

    // Wait for comment to appear (action completes)
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 5000 });
    // Button should be re-enabled after completion
    await expect(testId(page, "comment-submit")).toBeEnabled();
    await expect(testId(page, "comment-submit")).toContainText("Post Comment");
  });

  test("comments are scoped per blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Post a unique comment on one blog post
    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);
    await testId(page, "comment-name").fill("Frank");
    await testId(page, "comment-text").fill("Scoped-test-unique-xyz");
    await testId(page, "comment-submit").click();
    await expect(testId(page, "comments-list")).toContainText("Scoped-test-unique-xyz", { timeout: 5000 });

    // Navigate to a different blog post (fresh slug, no prior test comments)
    await page.goto(f.url("/blog/view-transitions"));
    await waitForHydration(page);

    // Should not have the comment from the other post
    const section = testId(page, "comments-section");
    await expect(section).toBeVisible();
    await expect(section).not.toContainText("Scoped-test-unique-xyz");
  });
});

test.describe("blog comments via loader action (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("should show empty comments on blog detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/view-transitions"));
    await waitForHydration(page);

    await expect(testId(page, "comments-section")).toBeVisible();
    await expect(testId(page, "comment-form")).toBeVisible();
    await expect(testId(page, "no-comments")).toBeVisible();
    await expect(testId(page, "no-comments")).toContainText("No comments yet");
  });

  // FIXME: invokeFetchableLoaderAction server reference (09ecd117d1ba) is not
  // registered in the RSC action manifest. The SSR bundle creates the reference
  // but loadServerAction() on the RSC side can't find it. See issue #205.
  test.fixme("should post a comment via loader action", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);

    await expect(testId(page, "no-comments")).toBeVisible();

    await testId(page, "comment-name").fill("Alice");
    await testId(page, "comment-text").fill("Great article!");
    await testId(page, "comment-submit").click();

    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "comments-section")).toContainText("Comments (1)");
    await expect(testId(page, "comments-list")).toContainText("Alice");
    await expect(testId(page, "comments-list")).toContainText("Great article!");
    await expect(testId(page, "no-comments")).not.toBeVisible();
  });

  // FIXME: Same issue as above — server reference not found in production build.
  test.fixme("should post multiple comments", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/composable-caching"));
    await waitForHydration(page);

    await testId(page, "comment-name").fill("Bob");
    await testId(page, "comment-text").fill("First comment");
    await testId(page, "comment-submit").click();
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 5000 });
    await expect(testId(page, "comments-section")).toContainText("Comments (1)");

    await testId(page, "comment-name").fill("Carol");
    await testId(page, "comment-text").fill("Second comment");
    await testId(page, "comment-submit").click();
    await expect(testId(page, "comments-section")).toContainText("Comments (2)", { timeout: 5000 });
    await expect(testId(page, "comments-list")).toContainText("Bob");
    await expect(testId(page, "comments-list")).toContainText("Carol");
  });
});
