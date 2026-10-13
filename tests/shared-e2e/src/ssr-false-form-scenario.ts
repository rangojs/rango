import { expect, test } from "@playwright/test";

/**
 * A no-script document of a clientUrls() route whose `ssr: false` loader
 * feeds a useActionState form under an inline `<Suspense>` (#1138). The
 * form's action is a bound server reference: Fizz suspends the form once
 * while it encodes the action and retries it on a later turn, so a document
 * that flushed at shell-ready shipped the fallback and left the form in
 * `<div hidden id="S:n">`. Fixture: client-urls-ssr-false-form* in each app
 * (an instant page loader flagged `ssr: false`). Both apps call this from a
 * dev and a (production) describe.
 */

export interface SsrFalseFormScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the group route. */
  path: string;
}

const LOADS = 20;

export function runSsrFalseFormTests(
  options: SsrFalseFormScenarioOptions,
): void {
  test("the document's HTML has the form in place, 20 of 20", async ({
    request,
  }) => {
    const target = options.url(options.path);
    // The first document warms the server: on a cold one the route's modules
    // are still loading.
    await request.get(target, { headers: { accept: "text/html" } });
    const lost: string[] = [];
    for (let i = 0; i < LOADS; i++) {
      const response = await request.get(target, {
        headers: { accept: "text/html" },
      });
      expect(response.ok()).toBe(true);
      const html = await response.text();
      const formAt = html.indexOf('data-testid="sff-form"');
      const hiddenAt = html.search(/<div hidden id="S:\d+">/);
      if (
        formAt === -1 ||
        html.includes("<!--$?-->") ||
        html.includes('data-testid="sff-fallback"') ||
        (hiddenAt !== -1 && hiddenAt < formAt)
      ) {
        lost.push(`load ${i}`);
      }
    }
    expect(lost).toEqual([]);
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("a no-script document shows the useActionState form, 20 of 20", async ({
      page,
    }) => {
      await page.goto(options.url(options.path));
      for (let i = 0; i < LOADS; i++) {
        await page.goto(options.url(options.path));
        await expect(page.getByTestId("sff-form")).toBeVisible();
        await expect(page.getByTestId("sff-fallback")).toHaveCount(0);
      }
    });

    test("the no-script form submits and its result renders in place", async ({
      page,
    }) => {
      await page.goto(options.url(options.path));
      await page.getByTestId("sff-submit").click();
      await expect(page.getByTestId("sff-state")).toHaveText("saved item-1");
      await expect(page.getByTestId("sff-form")).toBeVisible();
      await expect(page.getByTestId("sff-fallback")).toHaveCount(0);
    });
  });
}
