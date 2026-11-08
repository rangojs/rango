/**
 * E2E: a component that throws redirect() while React renders it.
 *
 * The render answers it as a handler's throw is answered, while its status is
 * still open: a document request answers the redirect's 3xx, and a client
 * navigation answers 204 + X-RSC-Redirect and lands on the target. A redirect
 * an async component throws is reported after a Flight response's opening
 * flush, so a client navigation cannot answer it — the documented limit
 * (docs/internal/execution-model.md, "A component that throws redirect()
 * redirects, if the render says so in time") is pinned here too: the boundary
 * renders and the URL stays.
 *
 * Fixture: test-app/src/urls/component-redirect.tsx.
 */
import { expect, test } from "@playwright/test";
import { expectConsole } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { testId, waitForHydration } from "./helper";

function componentRedirectTests(f: Fixture) {
  const target = "/component-redirect/target";

  test("document: a sync component's redirect lands on its target", async ({
    page,
  }) => {
    await page.goto(f.url("/component-redirect/sync"));
    await expect(page).toHaveURL(f.url(target));
    await expect(testId(page, "component-redirect-target")).toBeVisible();
  });

  test("document: answers the redirect's 3xx with its Location", async ({
    request,
  }) => {
    const res = await request.get(f.url("/component-redirect/sync"), {
      maxRedirects: 0,
    });
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toBe(target);
  });

  test("document: an async component's redirect lands on its target", async ({
    page,
  }) => {
    // The throw fails the shell, which is before the status commits.
    await page.goto(f.url("/component-redirect/async"));
    await expect(page).toHaveURL(f.url(target));
    await expect(testId(page, "component-redirect-target")).toBeVisible();
  });

  test("client navigation: a sync component's redirect lands on the target", async ({
    page,
  }) => {
    await page.goto(f.url("/component-redirect"));
    await waitForHydration(page);
    await testId(page, "to-sync").click();
    await expect(page).toHaveURL(f.url(target));
    await expect(testId(page, "component-redirect-target")).toBeVisible();
    await expect(testId(page, "component-redirect-index")).toHaveCount(0);
  });

  test("client navigation: a declared errorBoundary does not intercept it", async ({
    page,
  }) => {
    await page.goto(f.url("/component-redirect"));
    await waitForHydration(page);
    await testId(page, "to-bounded").click();
    await expect(page).toHaveURL(f.url(target));
    await expect(testId(page, "component-redirect-boundary")).toHaveCount(0);
  });

  test("client navigation: the partial request answers 204 + X-RSC-Redirect", async ({
    page,
    request,
  }) => {
    await page.goto(f.url("/component-redirect"));
    await waitForHydration(page);
    const res = await request.get(
      f.url("/component-redirect/sync?_rsc_partial=1&_rsc_segments="),
      { maxRedirects: 0, headers: { accept: "text/x-component" } },
    );
    expect(res.status()).toBe(204);
    expect(new URL(res.headers()["x-rsc-redirect"]!).pathname).toBe(target);
  });

  test("client navigation: an async component's redirect is out of time, so the boundary renders", async ({
    page,
  }) => {
    // Pinned limit, not wanted: the error row lands after the response
    // committed. A document request for the same route answers the redirect.
    // The boundary catches it on purpose (console guard,
    // tests/shared-e2e/src/console-guard.ts).
    expectConsole(page, {
      allow: [/\[RootErrorBoundary\] Unhandled error caught/],
    });
    await page.goto(f.url("/component-redirect"));
    await waitForHydration(page);
    await testId(page, "to-async").click();
    await expect(page).toHaveURL(f.url("/component-redirect/async"));
    await expect(page.getByText("Internal Server Error")).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// Dev
// ---------------------------------------------------------------------------
test.describe("component redirect", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  componentRedirectTests(f);
});

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------
test.describe("component redirect (production)", () => {
  test.setTimeout(120000);
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  componentRedirectTests(f);
});
