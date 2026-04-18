import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests that a server action can set context variables via ctx.set()
 * and both the route handler AND registered loaders read them via ctx.get()
 * during the revalidation render pass that follows the action.
 *
 * Covers:
 *   - String-keyed variables (AppVariables)
 *   - Typed createVar() tokens
 *   - Handler reads (ctx.get in handler)
 *   - Loader reads (ctx.get in loader registered via loader())
 *   - JS-enhanced (useTransition) path
 *   - PE (native form POST) path
 */
test.describe("action ctx.set → handler/loader ctx.get (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("JS action: handler and loader read both string-keyed and createVar values", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-ctx-set"));
    await waitForHydration(page);

    // Before action: all show "none"
    await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
    await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");
    await expect(testId(page, "loader-ctx-string-value")).toHaveText("none");
    await expect(testId(page, "loader-ctx-typed-value")).toHaveText("none");

    await testId(page, "action-ctx-set-btn").click();

    // After action: handler reads survive the action → revalidation boundary
    await expect(testId(page, "action-ctx-string-value")).toHaveText(
      "set-by-action",
      { timeout: 10000 },
    );
    await expect(testId(page, "action-ctx-typed-value")).toHaveText(
      "typed-by-action",
      { timeout: 10000 },
    );

    // After action: loader reads also survive the action → revalidation boundary
    await expect(testId(page, "loader-ctx-string-value")).toHaveText(
      "set-by-action",
      { timeout: 10000 },
    );
    await expect(testId(page, "loader-ctx-typed-value")).toHaveText(
      "typed-by-action",
      { timeout: 10000 },
    );
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE action: handler and loader read both values after native form POST", async ({
      page,
    }) => {
      await page.goto(f.url("/action-ctx-set"));
      await expect(testId(page, "action-ctx-set-page")).toBeVisible();

      // Before action: all show "none"
      await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
      await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");
      await expect(testId(page, "loader-ctx-string-value")).toHaveText("none");
      await expect(testId(page, "loader-ctx-typed-value")).toHaveText("none");

      // Submit native form (no JS)
      await testId(page, "action-ctx-set-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      // After PE action: handler reads survive the PE action → render boundary
      await expect(testId(page, "action-ctx-string-value")).toHaveText(
        "set-by-action",
      );
      await expect(testId(page, "action-ctx-typed-value")).toHaveText(
        "typed-by-action",
      );

      // After PE action: loader reads also survive the PE action → render boundary
      await expect(testId(page, "loader-ctx-string-value")).toHaveText(
        "set-by-action",
      );
      await expect(testId(page, "loader-ctx-typed-value")).toHaveText(
        "typed-by-action",
      );
    });
  });
});

test.describe("action ctx.set → handler/loader ctx.get (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("JS action: handler and loader read both string-keyed and createVar values", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-ctx-set"));
    await waitForHydration(page);

    // Before action: all show "none"
    await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
    await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");
    await expect(testId(page, "loader-ctx-string-value")).toHaveText("none");
    await expect(testId(page, "loader-ctx-typed-value")).toHaveText("none");

    await testId(page, "action-ctx-set-btn").click();

    // After action: handler reads survive the action → revalidation boundary
    await expect(testId(page, "action-ctx-string-value")).toHaveText(
      "set-by-action",
      { timeout: 10000 },
    );
    await expect(testId(page, "action-ctx-typed-value")).toHaveText(
      "typed-by-action",
      { timeout: 10000 },
    );

    // After action: loader reads also survive the action → revalidation boundary
    await expect(testId(page, "loader-ctx-string-value")).toHaveText(
      "set-by-action",
      { timeout: 10000 },
    );
    await expect(testId(page, "loader-ctx-typed-value")).toHaveText(
      "typed-by-action",
      { timeout: 10000 },
    );
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE action: handler and loader read both values after native form POST", async ({
      page,
    }) => {
      await page.goto(f.url("/action-ctx-set"));
      await expect(testId(page, "action-ctx-set-page")).toBeVisible();

      // Before action: all show "none"
      await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
      await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");
      await expect(testId(page, "loader-ctx-string-value")).toHaveText("none");
      await expect(testId(page, "loader-ctx-typed-value")).toHaveText("none");

      // Submit native form (no JS)
      await testId(page, "action-ctx-set-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      // After PE action: handler reads survive the PE action → render boundary
      await expect(testId(page, "action-ctx-string-value")).toHaveText(
        "set-by-action",
      );
      await expect(testId(page, "action-ctx-typed-value")).toHaveText(
        "typed-by-action",
      );

      // After PE action: loader reads also survive the PE action → render boundary
      await expect(testId(page, "loader-ctx-string-value")).toHaveText(
        "set-by-action",
      );
      await expect(testId(page, "loader-ctx-typed-value")).toHaveText(
        "typed-by-action",
      );
    });
  });
});
