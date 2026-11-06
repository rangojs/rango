/**
 * A server component that throws redirect() while React renders it, under the
 * workerd runtime.
 *
 * It is not a handler's return, so React reports it to the Flight onError and
 * the nearest errorBoundary() renders it: the document answered a 200 error
 * page and a client navigation an error row. The render answers the redirect
 * instead (rsc/render-pipeline.ts), so a page load gets a real 3xx and a Link
 * click the Flight redirect the client re-navigates with.
 *
 * Both modes: the raw status with `maxRedirects: 0` (a browser follows the 3xx
 * itself, which cannot show it) and the browser's landing, document and soft.
 */
import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

// Shared test body, called inside each (dev / production) describe with that
// suite's fixture, so the describe titles stay literal for the bucketing guard.
function componentRedirectSuite(f: Fixture) {
  test("document request answers the component's redirect itself", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-redirect/throw"), {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/component-redirect/target");
  });

  test("an async component's redirect answers the same 302", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-redirect/throw-async"), {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/component-redirect/target");
  });

  test("page load lands on the target, never the error boundary", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-redirect/throw"));
    await waitForHydration(page);

    await expect(testId(page, "cr-target")).toBeVisible();
    await expect(page).toHaveURL(/\/component-redirect\/target$/);
    await expect(testId(page, "cr-boundary")).toHaveCount(0);
  });

  test("Link click lands on the target, never the error boundary", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-redirect/"));
    await waitForHydration(page);

    await clickAndWaitFor(testId(page, "cr-link"), testId(page, "cr-target"));
    await expect(page).toHaveURL(/\/component-redirect\/target$/);
    await expect(testId(page, "cr-boundary")).toHaveCount(0);
  });
}

test.describe("component-redirect", () => {
  componentRedirectSuite(useFixture({ root: ".", mode: "dev" }));
});

test.describe("component-redirect (production)", () => {
  componentRedirectSuite(useFixture({ root: ".", mode: "build" }));
});
