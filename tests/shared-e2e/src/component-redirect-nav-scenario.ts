import { expect, test, type Page } from "@playwright/test";

/**
 * A server component that throws redirect(), reached by a Link click.
 *
 * It is not a handler's return, so React writes an error row for it, and an
 * async component's row lands after the response's status line committed: the
 * server cannot answer it with the 204 + X-RSC-Redirect a handler's redirect
 * gets. The row's digest names the target and the browser follows it, so the
 * click lands on the target instead of the error page.
 *
 * - The segment's own component threw (sync or async): followed before the
 *   navigation commits (segment-system.tsx renderSegments).
 * - React meets it only while it renders (nested in the handler's element,
 *   behind loading(), or thrown by an async handler that streams under
 *   loading()): the page segment's router boundary follows it with a replace
 *   (route-content-wrapper.tsx StreamedLoaderErrorBoundary).
 *
 * Either way the layout above the page stays mounted (its <input> keeps what
 * the test typed) and Back returns to the page the click left.
 *
 * Fixture in each app, under /component-redirect-nav: a layout with an
 * <input data-testid="crn-input">, an errorBoundary(), an index of
 * links (crn-link-async, -sync, -nested, -loading, -handler-loading) and the target
 * (crn-target). Every throwing route redirects to /component-redirect-nav/target.
 */

export interface ComponentRedirectNavScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
}

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const CASES = [
  {
    name: "an async component's redirect lands on the target, layout kept",
    link: "crn-link-async",
  },
  {
    name: "a synchronous component's redirect lands on the target, layout kept",
    link: "crn-link-sync",
  },
  {
    name: "an async component nested in the handler's element lands on the target, layout kept",
    link: "crn-link-nested",
  },
  {
    name: "an async component behind loading() lands on the target, layout kept",
    link: "crn-link-loading",
  },
  {
    name: "an async handler under loading() that throws redirect() lands on the target, layout kept",
    link: "crn-link-handler-loading",
  },
] as const;

export function runComponentRedirectNavTests(
  options: ComponentRedirectNavScenarioOptions,
): void {
  for (const c of CASES) {
    test(c.name, async ({ page }) => {
      using _ = options.expectNoPageError(page);
      await page.goto(options.url("/component-redirect-nav/"));
      await options.waitForHydration(page);
      await testId(page, "crn-input").fill("kept");

      await testId(page, c.link).click();

      await expect(page).toHaveURL(/\/component-redirect-nav\/target$/);
      await expect(testId(page, "crn-target")).toBeVisible();
      await expect(testId(page, "crn-boundary")).toHaveCount(0);
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);
      // The layout never unmounted.
      await expect(testId(page, "crn-input")).toHaveValue("kept");

      await page.goBack();
      await expect(page).toHaveURL(/\/component-redirect-nav\/?$/);
      await expect(testId(page, "crn-index")).toBeVisible();
    });
  }
}
