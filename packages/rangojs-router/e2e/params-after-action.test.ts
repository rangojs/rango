import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Regression: useParams() should remain populated after a server action
 * triggers a partial revalidation — including when the action throws and
 * the response routes through an error boundary. Previously, the action
 * response metadata omitted `params`, and NavigationProvider clobbered the
 * params store to `{}` on every action (success or error).
 */

const TARGET = "/params-after-action/post-42/section/comments";
const ERROR_TARGET = "/params-after-action/error/post-42/section/comments";
const EXPECTED_PARAMS = { postId: "post-42", section: "comments" };

async function assertParamsPopulated(page: import("@playwright/test").Page) {
  await expect(testId(page, "client-params-json")).toHaveText(
    JSON.stringify(EXPECTED_PARAMS),
  );
  await expect(testId(page, "client-post-id")).toHaveText("postId:post-42");
  await expect(testId(page, "client-section")).toHaveText("section:comments");
}

async function assertBoundaryParamsPopulated(
  page: import("@playwright/test").Page,
) {
  await expect(testId(page, "error-boundary-params-json")).toHaveText(
    JSON.stringify(EXPECTED_PARAMS),
  );
  await expect(testId(page, "error-boundary-post-id")).toHaveText(
    "postId:post-42",
  );
  await expect(testId(page, "error-boundary-section")).toHaveText(
    "section:comments",
  );
}

test.describe("useParams survives action revalidation (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("JS action: useParams still populated after action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(TARGET));
    await waitForHydration(page);

    await assertParamsPopulated(page);

    await testId(page, "params-after-action-btn").click();
    await expect(testId(page, "params-after-action-btn")).toBeEnabled();

    await assertParamsPopulated(page);
  });

  test("JS action error: useParams populated in error boundary", async ({
    page,
  }) => {
    await page.goto(f.url(ERROR_TARGET));
    await waitForHydration(page);

    await expect(testId(page, "error-trigger-params-json")).toHaveText(
      JSON.stringify(EXPECTED_PARAMS),
    );

    await testId(page, "params-after-action-throw-btn").click();

    await expect(
      testId(page, "params-after-action-error-boundary"),
    ).toBeVisible();
    await assertBoundaryParamsPopulated(page);
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE action: useParams still populated after native form POST", async ({
      page,
    }) => {
      await page.goto(f.url(TARGET));
      await expect(testId(page, "params-after-action-page")).toBeVisible();

      await expect(testId(page, "client-params-json")).toHaveText(
        JSON.stringify(EXPECTED_PARAMS),
      );

      await testId(page, "params-after-action-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      await expect(testId(page, "client-params-json")).toHaveText(
        JSON.stringify(EXPECTED_PARAMS),
      );
    });

    test("PE action error: useParams populated in error boundary", async ({
      page,
    }) => {
      await page.goto(f.url(ERROR_TARGET));
      await expect(
        testId(page, "params-after-action-error-page"),
      ).toBeVisible();

      await testId(page, "params-after-action-throw-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      await expect(
        testId(page, "params-after-action-error-boundary"),
      ).toBeVisible();
      await assertBoundaryParamsPopulated(page);
    });
  });
});

test.describe("useParams survives action revalidation (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("JS action: useParams still populated after action", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url(TARGET));
    await waitForHydration(page);

    await assertParamsPopulated(page);

    await testId(page, "params-after-action-btn").click();
    await expect(testId(page, "params-after-action-btn")).toBeEnabled();

    await assertParamsPopulated(page);
  });

  test("JS action error: useParams populated in error boundary", async ({
    page,
  }) => {
    await page.goto(f.url(ERROR_TARGET));
    await waitForHydration(page);

    await expect(testId(page, "error-trigger-params-json")).toHaveText(
      JSON.stringify(EXPECTED_PARAMS),
    );

    await testId(page, "params-after-action-throw-btn").click();

    await expect(
      testId(page, "params-after-action-error-boundary"),
    ).toBeVisible();
    await assertBoundaryParamsPopulated(page);
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE action: useParams still populated after native form POST", async ({
      page,
    }) => {
      await page.goto(f.url(TARGET));
      await expect(testId(page, "params-after-action-page")).toBeVisible();

      await expect(testId(page, "client-params-json")).toHaveText(
        JSON.stringify(EXPECTED_PARAMS),
      );

      await testId(page, "params-after-action-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      await expect(testId(page, "client-params-json")).toHaveText(
        JSON.stringify(EXPECTED_PARAMS),
      );
    });

    test("PE action error: useParams populated in error boundary", async ({
      page,
    }) => {
      await page.goto(f.url(ERROR_TARGET));
      await expect(
        testId(page, "params-after-action-error-page"),
      ).toBeVisible();

      await testId(page, "params-after-action-throw-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      await expect(
        testId(page, "params-after-action-error-boundary"),
      ).toBeVisible();
      await assertBoundaryParamsPopulated(page);
    });
  });
});
