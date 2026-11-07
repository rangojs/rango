/**
 * E2E: a server component that throws notFound() while React renders it.
 *
 * It is not a handler's throw, so React reports it to the Flight onError and
 * the router's root boundary renders it: the document answered an error page
 * and a client navigation an error row. The render answers it instead
 * (rsc/render-pipeline.ts): the page renders again with the notFoundBoundary()
 * a notFound() from the throwing segment's handler would render (a route's, a
 * layout's, a parallel slot's, an intercept's), and the document answers 404.
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
function componentNotFoundTests(f: Fixture) {
  test("document request answers 404 with the declared notFoundBoundary", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-not-found/throw"));
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('data-testid="cnf-not-found"');
    expect(html).toContain('data-testid="cnf-shell"');
  });

  // Answered on a document request (the HTML step decodes the payload before
  // it can answer); on a client navigation an async component's row arrives
  // after the response's opening chunk (docs/internal/execution-model.md).
  test("an async component's notFound() answers the same 404", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-not-found/throw-async"));
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('data-testid="cnf-not-found"');
  });

  test("page load shows the notFoundBoundary inside the layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-not-found/throw"));
    await waitForHydration(page);

    await expect(testId(page, "cnf-not-found")).toHaveText(
      "not found: no such product",
    );
    await expect(testId(page, "cnf-shell")).toBeVisible();
    await expect(testId(page, "cnf-error")).toHaveCount(0);
  });

  test("Link click shows the notFoundBoundary, never the error page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-not-found/"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "cnf-link"),
      testId(page, "cnf-not-found"),
    );
    await expect(page).toHaveURL(/\/component-not-found\/throw$/);
    await expect(testId(page, "cnf-shell")).toBeVisible();
    await expect(testId(page, "cnf-error")).toHaveCount(0);
  });

  test("a layout's component: the document answers 404 with the notFoundBoundary in the layout's place", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-not-found/layout/missing"));
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('data-testid="cnf-not-found"');
    expect(html).toContain('data-testid="cnf-shell"');
    expect(html).not.toContain('data-testid="cnf-layout"');
    expect(html).not.toContain('data-testid="cnf-error"');
  });

  test("a parallel slot's component: the document answers 404 with the notFoundBoundary in its layout's place", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-not-found/slot"));
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('data-testid="cnf-not-found"');
    expect(html).not.toContain('data-testid="cnf-slot-owner"');
    expect(html).not.toContain('data-testid="cnf-error"');
  });

  test("a layout's component: a Link click shows the notFoundBoundary, and a sibling route renders the layout again", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-not-found/"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "cnf-layout-link"),
      testId(page, "cnf-not-found"),
    );
    await expect(page).toHaveURL(/\/component-not-found\/layout\/missing$/);
    await expect(testId(page, "cnf-layout")).toHaveCount(0);
    await expect(testId(page, "cnf-error")).toHaveCount(0);

    // A sibling route under the same layout: the client must not keep the
    // fallback where the layout was.
    await clickAndWaitFor(
      testId(page, "cnf-layout-ok-link"),
      testId(page, "cnf-layout-page"),
    );
    await expect(testId(page, "cnf-layout-page")).toHaveText("ok page");
    await expect(testId(page, "cnf-layout")).toBeVisible();
    await expect(testId(page, "cnf-not-found")).toHaveCount(0);
  });

  test("a parallel slot's component: a Link click shows the notFoundBoundary, never the error page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-not-found/"));
    await waitForHydration(page);
    await clickAndWaitFor(
      testId(page, "cnf-slot-link"),
      testId(page, "cnf-not-found"),
    );
    await expect(page).toHaveURL(/\/component-not-found\/slot$/);
    await expect(testId(page, "cnf-slot-owner")).toHaveCount(0);
    await expect(testId(page, "cnf-error")).toHaveCount(0);
  });

  test("an intercept's component: a Link click shows the notFoundBoundary in the slot over the page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/component-not-found/"));
    await waitForHydration(page);

    await clickAndWaitFor(
      testId(page, "cnf-photo-link"),
      testId(page, "cnf-not-found"),
    );
    await expect(page).toHaveURL(/\/component-not-found\/photo\/1$/);
    await expect(testId(page, "cnf-index")).toBeVisible();
    await expect(testId(page, "cnf-error")).toHaveCount(0);
  });
}

// -- Dev mode ----------------------------------------------------------------
test.describe("component notFound (dev mode)", () => {
  componentNotFoundTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("component notFound (production)", () => {
  componentNotFoundTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
