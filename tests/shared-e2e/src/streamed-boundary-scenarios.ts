import { expect, test, type Page } from "@playwright/test";

/**
 * A handler under loading() that rejects or calls notFound() after the flush
 * renders the declared errorBoundary() / notFoundBoundary() in place of its
 * segment (status stays 200, nav stays). Both apps call this inside a dev and
 * a (production) describe; the titles stay with the callers.
 */

export interface StreamedBoundaryFixture {
  path: string;
  linkId: string;
  fallbackId: string;
  loadingId: string;
}

export interface StreamedBoundaryScenariosOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  /** A page that links to every fixture route. */
  index: string;
  /** Test id of the layout chrome that must survive every fallback. */
  navId: string;
  fails: StreamedBoundaryFixture & {
    /** Test id and text of the rendered fallback's segment marker. */
    segment?: { id: string; text: string };
  };
  /** The same failure under loading(fallback, { ssr: false }). */
  noSsr: Omit<StreamedBoundaryFixture, "loadingId">;
  missing: StreamedBoundaryFixture;
}

const TIMEOUT = 10000;

export function defineStreamedBoundaryScenarios(
  o: StreamedBoundaryScenariosOptions,
): void {
  const byId = (page: Page, id: string) =>
    page.locator(`[data-testid="${id}"]`);
  const noRootError = (page: Page) =>
    expect(page.getByText("Internal Server Error")).toHaveCount(0);

  test("document: the declared errorBoundary renders, nav stays, status stays 200", async ({
    page,
  }) => {
    const res = await page.goto(o.url(o.fails.path));
    expect(res!.status()).toBe(200);
    await expect(byId(page, o.fails.fallbackId)).toBeVisible({
      timeout: TIMEOUT,
    });
    if (o.fails.segment) {
      await expect(byId(page, o.fails.segment.id)).toHaveText(
        o.fails.segment.text,
      );
    }
    await expect(byId(page, o.fails.loadingId)).toHaveCount(0);
    await noRootError(page);
    await expect(byId(page, o.navId)).toBeVisible();
  });

  test("SPA navigation: the declared errorBoundary replaces only the segment", async ({
    page,
  }) => {
    await page.goto(o.url(o.index));
    await o.waitForHydration(page);
    await byId(page, o.fails.linkId).click();
    await expect(byId(page, o.fails.fallbackId)).toBeVisible({
      timeout: TIMEOUT,
    });
    await expect(byId(page, o.fails.loadingId)).toHaveCount(0);
    await noRootError(page);
    await expect(byId(page, o.navId)).toBeVisible();
  });

  test("loading({ ssr: false }): document and SPA navigation show the declared errorBoundary", async ({
    page,
  }) => {
    await page.goto(o.url(o.noSsr.path));
    await expect(byId(page, o.noSsr.fallbackId)).toBeVisible({
      timeout: TIMEOUT,
    });
    await expect(byId(page, o.navId)).toBeVisible();

    await page.goto(o.url(o.index));
    await o.waitForHydration(page);
    await byId(page, o.noSsr.linkId).click();
    await expect(byId(page, o.noSsr.fallbackId)).toBeVisible({
      timeout: TIMEOUT,
    });
    await noRootError(page);
    await expect(byId(page, o.navId)).toBeVisible();
  });

  test("document: notFound() renders the declared notFoundBoundary, status stays 200", async ({
    page,
  }) => {
    const res = await page.goto(o.url(o.missing.path));
    expect(res!.status()).toBe(200);
    await expect(byId(page, o.missing.fallbackId)).toBeVisible({
      timeout: TIMEOUT,
    });
    await expect(byId(page, o.missing.loadingId)).toHaveCount(0);
    await noRootError(page);
    await expect(byId(page, o.navId)).toBeVisible();
  });

  test("SPA navigation: notFound() renders the declared notFoundBoundary", async ({
    page,
  }) => {
    await page.goto(o.url(o.index));
    await o.waitForHydration(page);
    await byId(page, o.missing.linkId).click();
    await expect(byId(page, o.missing.fallbackId)).toBeVisible({
      timeout: TIMEOUT,
    });
    await noRootError(page);
    await expect(byId(page, o.navId)).toBeVisible();
  });
}
