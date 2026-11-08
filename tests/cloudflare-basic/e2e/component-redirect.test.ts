import { expect, test } from "@playwright/test";
import { expectConsole } from "@shared/e2e";
import { useFixture } from "./fixture";
import { testId, waitForHydration } from "./helper";

// A component that throws redirect() while React renders it. The render answers
// it as a handler's throw is answered, while its status is still open: a
// document request answers the redirect's 3xx, a client navigation answers
// 204 + X-RSC-Redirect and lands on the target. A redirect an async component
// throws is reported after a Flight response's opening flush, so a client
// navigation cannot answer it — the documented limit
// (docs/internal/execution-model.md) is pinned here too. Fixture:
// src/pages/component-redirect.tsx. Counterpart of
// packages/rangojs-router/e2e/component-redirect.test.ts.

function defineSuite(mode: "dev" | "build") {
  // Title DERIVED from mode so the `(production)` bucket tag can never drift.
  const title = `Component redirect${mode === "build" ? " (production)" : ""}`;

  test.describe(title, () => {
    const f = useFixture({ root: ".", mode });
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
      // The boundary catches the error row on purpose (console guard,
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
  });
}

defineSuite("dev");
defineSuite("build");
