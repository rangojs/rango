import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Request-derived names that match an Object.prototype member (#1109), on
 * workerd.
 *
 * Routes: static segments named `constructor` and `__proto__` render their
 * own routes. The production trie arrives from the build manifest as JSON and
 * used to leave both routes out, so they 404'd: the (production) describe is
 * the one that pins it. `/toString` has no route of its own and reaches this
 * app's root catch-all (`/*`) like any other segment.
 *
 * Fetchable-loader params: string values reach the loader. A number is a 400
 * carrying a loader error, so load() rejects with "Invalid loader params" and
 * the hook throws it to the error boundary (LoaderParamsProbe).
 */
function requestKeyTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`request-derived keys (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    for (const [path, text] of [
      ["/constructor", "constructor route"],
      ["/__proto__", "__proto__ route"],
    ]) {
      test(`${path} renders its own route`, async ({ page }) => {
        using _ = expectNoPageError(page);
        const response = await page.goto(f.url(path));
        expect(response?.status()).toBe(200);
        await expect(testId(page, "request-key-page")).toHaveText(text);
      });
    }

    test("a route without such a segment still renders", async ({ page }) => {
      using _ = expectNoPageError(page);
      const response = await page.goto(f.url("/about"));
      expect(response?.status()).toBe(200);
      await expect(testId(page, "about-title")).toHaveText("About");
    });

    test("/toString has no route of its own and reaches the catch-all", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const response = await page.goto(f.url("/toString"));
      expect(response?.status()).toBe(200);
      await expect(testId(page, "wildcard-value")).toHaveText(
        "Wildcard: toString",
      );
      await expect(testId(page, "request-key-page")).toHaveCount(0);
    });

    test("load() with string params gets the loader's data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/loader-params"));
      await waitForHydration(page);

      await testId(page, "loader-params-valid").click();

      await expect(testId(page, "loader-params-id")).toHaveText("valid-1");
      await expect(testId(page, "loader-params-rejection")).toHaveCount(0);
      await expect(testId(page, "loader-params-boundary")).toHaveCount(0);
    });

    test("load() with a non-string param rejects with Invalid loader params", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/loader-params"));
      await waitForHydration(page);

      const response = page.waitForResponse((r) =>
        r.url().includes("_rsc_loader="),
      );
      await testId(page, "loader-params-invalid").click();
      expect((await response).status()).toBe(400);

      const message =
        "Invalid loader params: expected an object of string values";
      await expect(testId(page, "loader-params-rejection")).toContainText(
        message,
      );
      await expect(testId(page, "loader-params-boundary")).toContainText(
        message,
      );
    });
  });
}

requestKeyTests("dev");
requestKeyTests("build");
