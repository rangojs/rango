/**
 * E2E: a server component that throws notFound() while React renders it.
 *
 * It is not a handler's throw, so React reports it to the Flight onError and
 * the router's root boundary renders it: the document answered an error page
 * and a client navigation an error row. The render answers it instead
 * (rsc/render-pipeline.ts): the route renders again with its notFoundBoundary(),
 * as a notFound() from its handler would, and the document answers 404.
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
}

// -- Dev mode ----------------------------------------------------------------
test.describe("component notFound (dev mode)", () => {
  componentNotFoundTests(useFixture({ root: "./e2e/test-app", mode: "dev" }));
});

// -- Production build --------------------------------------------------------
test.describe("component notFound (production)", () => {
  componentNotFoundTests(useFixture({ root: "./e2e/test-app", mode: "build" }));
});
