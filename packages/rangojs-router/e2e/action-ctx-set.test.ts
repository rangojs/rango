import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests that a server action can set context variables via ctx.set()
 * and the route handler reads them via ctx.get() during the revalidation
 * render pass that follows the action.
 *
 * Covers:
 *   - String-keyed variables (AppVariables)
 *   - Typed createVar() tokens
 *   - JS-enhanced (useTransition) path
 *   - PE (native form POST) path
 */
test.describe("action ctx.set → handler ctx.get (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("JS action: handler reads both string-keyed and createVar values", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-ctx-set"));
    await waitForHydration(page);

    // Before action: both show "none"
    await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
    await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");

    await testId(page, "action-ctx-set-btn").click();

    // After action: both approaches survive the action → revalidation boundary
    await expect(testId(page, "action-ctx-string-value")).toHaveText(
      "set-by-action",
      { timeout: 10000 },
    );
    await expect(testId(page, "action-ctx-typed-value")).toHaveText(
      "typed-by-action",
      { timeout: 10000 },
    );
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE action: handler reads both string-keyed and createVar values after native form POST", async ({
      page,
    }) => {
      await page.goto(f.url("/action-ctx-set"));
      await expect(testId(page, "action-ctx-set-page")).toBeVisible();

      // Before action: both show "none"
      await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
      await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");

      // Submit native form (no JS)
      await testId(page, "action-ctx-set-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      // After PE action: both approaches survive the PE action → render boundary
      await expect(testId(page, "action-ctx-string-value")).toHaveText(
        "set-by-action",
      );
      await expect(testId(page, "action-ctx-typed-value")).toHaveText(
        "typed-by-action",
      );
    });
  });
});

test.describe("action ctx.set → handler ctx.get (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("JS action: handler reads both string-keyed and createVar values", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/action-ctx-set"));
    await waitForHydration(page);

    // Before action: both show "none"
    await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
    await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");

    await testId(page, "action-ctx-set-btn").click();

    // After action: both approaches survive the action → revalidation boundary
    await expect(testId(page, "action-ctx-string-value")).toHaveText(
      "set-by-action",
      { timeout: 10000 },
    );
    await expect(testId(page, "action-ctx-typed-value")).toHaveText(
      "typed-by-action",
      { timeout: 10000 },
    );
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE action: handler reads both string-keyed and createVar values after native form POST", async ({
      page,
    }) => {
      await page.goto(f.url("/action-ctx-set"));
      await expect(testId(page, "action-ctx-set-page")).toBeVisible();

      // Before action: both show "none"
      await expect(testId(page, "action-ctx-string-value")).toHaveText("none");
      await expect(testId(page, "action-ctx-typed-value")).toHaveText("none");

      // Submit native form (no JS)
      await testId(page, "action-ctx-set-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      // After PE action: both approaches survive the PE action → render boundary
      await expect(testId(page, "action-ctx-string-value")).toHaveText(
        "set-by-action",
      );
      await expect(testId(page, "action-ctx-typed-value")).toHaveText(
        "typed-by-action",
      );
    });
  });
});
