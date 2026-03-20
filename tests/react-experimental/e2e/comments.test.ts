import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

async function waitForCommentFormToSettle(page: Page) {
  const nameInput = testId(page, "comment-name");
  const textInput = testId(page, "comment-text");
  const submitButton = testId(page, "comment-submit");

  await expect(submitButton).toBeEnabled({ timeout: 10000 });
  await expect(nameInput).toHaveValue("", { timeout: 10000 });
  await expect(textInput).toHaveValue("", { timeout: 10000 });

  const snapshot = async () => ({
    name: await nameInput.inputValue(),
    text: await textInput.inputValue(),
    enabled: await submitButton.isEnabled(),
  });

  const first = await snapshot();
  await page.waitForTimeout(100);
  await expect.poll(snapshot, { timeout: 10000 }).toEqual(first);
}

async function submitComment(
  page: Page,
  comment: { name: string; text: string },
) {
  const nameInput = testId(page, "comment-name");
  const textInput = testId(page, "comment-text");

  await waitForCommentFormToSettle(page);

  await nameInput.fill(comment.name);
  await expect(nameInput).toHaveValue(comment.name);

  await textInput.fill(comment.text);
  await expect(textInput).toHaveValue(comment.text);

  const loaderResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      response.url().includes("_rsc_loader=") &&
      response.status() === 200
    );
  });

  await testId(page, "comment-submit").click();
  await loaderResponse;

  await waitForCommentFormToSettle(page);
}

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
    await submitComment(page, {
      name: "Alice",
      text: "Great article!",
    });

    // Comment should appear
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 10000 });
    await expect(testId(page, "comments-section")).toContainText(
      "Comments (1)",
      { timeout: 10000 },
    );
    await expect(testId(page, "comments-list")).toContainText("Alice", {
      timeout: 10000,
    });
    await expect(testId(page, "comments-list")).toContainText(
      "Great article!",
      {
        timeout: 10000,
      },
    );

    // "No comments" should be gone
    await expect(testId(page, "no-comments")).not.toBeVisible();
  });

  test("should post multiple comments", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/composable-caching"));
    await waitForHydration(page);

    // Post first comment
    await submitComment(page, {
      name: "Bob",
      text: "First comment",
    });
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 10000 });
    await expect(testId(page, "comments-section")).toContainText(
      "Comments (1)",
      { timeout: 10000 },
    );

    // Post second comment
    await submitComment(page, {
      name: "Carol",
      text: "Second comment",
    });
    await expect(testId(page, "comments-section")).toContainText(
      "Comments (2)",
      { timeout: 10000 },
    );
    await expect(testId(page, "comments-list")).toContainText("Bob", {
      timeout: 10000,
    });
    await expect(testId(page, "comments-list")).toContainText("Carol", {
      timeout: 10000,
    });
  });

  test("should clear form after posting", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/view-transitions"));
    await waitForHydration(page);

    await submitComment(page, {
      name: "Dave",
      text: "Nice post!",
    });

    // Wait for comment to appear
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 10000 });
  });

  test("should disable submit button while posting", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);

    await submitComment(page, {
      name: "Eve",
      text: "Testing submit",
    });

    // Wait for comment to appear (action completes)
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 10000 });
    // Button should be re-enabled after completion
    await expect(testId(page, "comment-submit")).toBeEnabled();
    await expect(testId(page, "comment-submit")).toContainText("Post Comment");
  });

  test("comments are scoped per blog post", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Post a unique comment on one blog post
    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);
    await submitComment(page, {
      name: "Frank",
      text: "Scoped-test-unique-xyz",
    });
    await expect(testId(page, "comments-list")).toContainText(
      "Scoped-test-unique-xyz",
      { timeout: 10000 },
    );

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

  test("should post a comment via loader action", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/rsc-routing"));
    await waitForHydration(page);

    await expect(testId(page, "no-comments")).toBeVisible();

    await submitComment(page, {
      name: "Alice",
      text: "Great article!",
    });

    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 10000 });
    await expect(testId(page, "comments-section")).toContainText(
      "Comments (1)",
      { timeout: 10000 },
    );
    await expect(testId(page, "comments-list")).toContainText("Alice", {
      timeout: 10000,
    });
    await expect(testId(page, "comments-list")).toContainText(
      "Great article!",
      {
        timeout: 10000,
      },
    );
    await expect(testId(page, "no-comments")).not.toBeVisible();
  });

  test("should post multiple comments", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/blog/composable-caching"));
    await waitForHydration(page);

    await submitComment(page, {
      name: "Bob",
      text: "First comment",
    });
    await expect(testId(page, "comments-list")).toBeVisible({ timeout: 10000 });
    await expect(testId(page, "comments-section")).toContainText(
      "Comments (1)",
      { timeout: 10000 },
    );

    await submitComment(page, {
      name: "Carol",
      text: "Second comment",
    });
    await expect(testId(page, "comments-section")).toContainText(
      "Comments (2)",
      { timeout: 10000 },
    );
    await expect(testId(page, "comments-list")).toContainText("Bob", {
      timeout: 10000,
    });
    await expect(testId(page, "comments-list")).toContainText("Carol", {
      timeout: 10000,
    });
  });
});
