/**
 * E2E: a server component that throws redirect() while React renders it.
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
function componentRedirectTests(f: Fixture) {
  test("document request answers the component's redirect itself", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-redirect/throw"), {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/component-redirect/target");
  });

  // A document's shell awaits a segment with no loading() above it, so a
  // component that suspends before throwing is reported before the status
  // commits. The fixture suspends on a macrotask, not a microtask.
  test("an async component's redirect answers the same 302", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-redirect/throw-async"), {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/component-redirect/target");
  });

  // A synchronous throw happens in the shell's own pass, fallback or not.
  test("a component behind loading() answers the 302 on a document", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-redirect/throw-loading"), {
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

  test("a Link to a component behind loading() lands on the target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-redirect/"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "cr-link-loading"),
      testId(page, "cr-target"),
    );
    await expect(page).toHaveURL(/\/component-redirect\/target$/);
    await expect(testId(page, "cr-boundary")).toHaveCount(0);
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("component redirect (dev mode)", () => {
  componentRedirectTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("component redirect (production build)", () => {
  componentRedirectTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
