import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * intercept()'s `when` receives `from` / `to` as { url, params, routeName }.
 * Fixture: test-app/src/urls/intercept-when-shape.tsx — the modal opens only
 * from the list's "open" section (from.routeName, from.params) and never for
 * item "skip" (to.params); otherwise the full item page renders.
 */

function interceptWhenShapeTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`intercept when selector shape (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    async function openFrom(
      page: import("@playwright/test").Page,
      section: string,
      link: string,
    ) {
      await page.goto(f.url(`/intercept-when-shape/list/${section}`));
      await waitForHydration(page);
      await expect(testId(page, "iws-section")).toHaveText(section);
      await testId(page, link).click();
    }

    test("from.routeName and from.params select the intercept", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openFrom(page, "open", "iws-to-1");
      await expect(testId(page, "iws-modal-id")).toHaveText("1");
      await expect(page).toHaveURL(/\/intercept-when-shape\/item\/1$/);
      await expect(testId(page, "iws-list")).toBeVisible();
    });

    test("a source whose params fail the selector renders the full page", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openFrom(page, "closed", "iws-to-1");
      await expect(testId(page, "iws-item-page")).toHaveText("1");
      await expect(testId(page, "iws-modal-id")).toHaveCount(0);
    });

    test("a throwing selector renders the full page without the intercept", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openFrom(page, "open", "iws-to-throw");
      await expect(testId(page, "iws-item-page")).toHaveText("throw");
      await expect(testId(page, "iws-modal-id")).toHaveCount(0);
    });

    test("to.params select the intercept", async ({ page }) => {
      using _ = expectNoPageError(page);
      await openFrom(page, "open", "iws-to-skip");
      await expect(testId(page, "iws-item-page")).toHaveText("skip");
      await expect(testId(page, "iws-modal-id")).toHaveCount(0);
    });
  });
}

interceptWhenShapeTests("dev");
interceptWhenShapeTests("build");
