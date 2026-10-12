import { expect, test } from "@playwright/test";

/**
 * A no-script document of a clientUrls() route whose inline `<Suspense>`
 * draws a client component from a loader's answer (#1106). A boundary that
 * misses the first flush streams its fallback and swaps the content in with
 * a script, which a browser without JavaScript never runs. Fixture:
 * client-urls-loader-element* in each app (an instant loader returning
 * `<ClientUrlsElementBadge />`, read under an inline `<Suspense>`). Both apps
 * call this from a dev and a (production) describe.
 */

export interface LoaderElementScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the group route. */
  path: string;
}

export function runLoaderElementTests(
  options: LoaderElementScenarioOptions,
): void {
  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("a no-script document renders the client component a loader's answer draws under an inline Suspense", async ({
      page,
    }) => {
      // The first document warms the server: on a cold one the route's
      // modules are still loading. Then several documents, each resolving the
      // reference again.
      await page.goto(options.url(options.path));
      for (let i = 0; i < 3; i++) {
        await page.goto(options.url(options.path));
        await expect(page.getByTestId("cle-page")).toBeVisible();
        await expect(page.getByTestId("cle-badge")).toBeVisible();
        await expect(page.getByTestId("cle-fallback")).toHaveCount(0);
      }
    });
  });
}
