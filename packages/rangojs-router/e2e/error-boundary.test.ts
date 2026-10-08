import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, goBack } from "./helper";
import { defineStreamedBoundaryScenarios, expectConsole } from "@shared/e2e";

/**
 * Shared error boundary tests run against both dev and production.
 *
 * Contract under test:
 * - Sync server errors: caught per-segment during RSC render, layout preserved
 * - Streaming errors with a declared errorBoundary()/notFoundBoundary(): the
 *   declared fallback renders in place of the segment, layout preserved, status
 *   unchanged after flush
 * - Streaming errors with no declared boundary: caught client-side by
 *   RootErrorBoundary, layout replaced
 * - Client errors: caught client-side by RootErrorBoundary, layout replaced
 * - Navigation away from error boundary recovers the app (layout restored)
 * - Back navigation from error boundary recovers the app
 */
function errorBoundaryTests(f: ReturnType<typeof useFixture>, isDev: boolean) {
  test.describe("client-component-errors", () => {
    test("should show error boundary when client component throws on interaction", async ({
      page,
    }) => {
      // Provoked on purpose (console guard, tests/shared-e2e/src/console-guard.ts).
      expectConsole(page, {
        allow: [
          /\[RootErrorBoundary\] Unhandled error caught: Error: Client-side error/,
        ],
      });
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);

      await expect(testId(page, "client-error-title")).toBeVisible();
      await expect(testId(page, "client-error-thrower")).toBeVisible();

      await testId(page, "client-error-thrower-trigger").click();

      // RootErrorBoundary shows "Internal Server Error" fallback
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Detailed error message is only shown in dev mode
      if (isDev) {
        await expect(
          page.getByText("Client-side error", { exact: false }).first(),
        ).toBeVisible();
      }
    });

    test("client error replaces segment tree with error fallback", async ({
      page,
    }) => {
      // Provoked on purpose (console guard, tests/shared-e2e/src/console-guard.ts).
      expectConsole(page, {
        allow: [
          /\[RootErrorBoundary\] Unhandled error caught: Error: Client-side error/,
        ],
      });
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);

      // Verify layout elements exist before the error
      await expect(testId(page, "app-root")).toBeVisible();
      await expect(testId(page, "nav")).toBeVisible();
      await expect(testId(page, "client-error-title")).toBeVisible();

      // Trigger the error
      await testId(page, "client-error-thrower-trigger").click();

      // RootErrorBoundary replaces the segment tree
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // The route content is gone (replaced by error fallback)
      await expect(testId(page, "client-error-title")).not.toBeVisible();

      // Error fallback provides recovery links
      await expect(page.getByText("Try Again")).toBeVisible();
      await expect(page.getByText("Go to homepage")).toBeVisible();
    });
  });

  test.describe("server-component-errors", () => {
    test("should show error boundary for server component error", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/server-error"));

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      if (isDev) {
        await expect(
          page.getByText("Server error", { exact: false }).first(),
        ).toBeVisible();
      }
    });

    test("SPA navigation to server error preserves layout", async ({
      page,
    }) => {
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      await expect(testId(page, "errors-title")).toBeVisible();

      await testId(page, "server-error-link").click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Server errors are scoped to the errored segment — layout stays
      await expect(testId(page, "nav")).toBeVisible();
    });
  });

  test.describe("streaming-errors (no declared boundary)", () => {
    test("should show loading then error boundary for streaming error", async ({
      page,
    }) => {
      // Provoked on purpose (console guard, tests/shared-e2e/src/console-guard.ts).
      expectConsole(page, {
        allow: [
          /\[RootErrorBoundary\] Unhandled error caught: Error: Streaming error/,
        ],
      });
      // The "loading first" pin lives on the RAW STREAM, not the live DOM.
      // The DOM fallback is transient: with head-executing module scripts
      // (headScripts "preinit") hydration can process the streamed error
      // instruction and swap in the error boundary BEFORE a locator poll
      // ever observes the fallback — page.goto resolves at `load`, which for
      // this route is after the error already streamed. Asserting the DOM
      // loading state raced hydration speed (failed 4/4 on a warm local
      // preview, flaked on CI). The stream is deterministic: the shell ships
      // the fallback, React's errored-boundary marker arrives later in the
      // same body.
      const res = await fetch(f.url("/errors/streaming-error"), {
        headers: { Accept: "text/html" },
      });
      const html = await res.text();
      const fallbackIdx = html.indexOf('data-testid="streaming-error-loading"');
      expect(fallbackIdx, "loading fallback is in the shell").toBeGreaterThan(
        -1,
      );
      const erroredIdx = html.indexOf("<!--$!-->");
      expect(
        erroredIdx,
        "errored-boundary marker streams after the fallback",
      ).toBeGreaterThan(fallbackIdx);

      // The browser lands on the error boundary regardless of how early
      // hydration won the swap.
      await page.goto(f.url("/errors/streaming-error"));
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      if (isDev) {
        await expect(
          page.getByText("Streaming error", { exact: false }).first(),
        ).toBeVisible();
      }
    });

    test("SPA navigation to streaming error replaces layout", async ({
      page,
    }) => {
      // Provoked on purpose (console guard, tests/shared-e2e/src/console-guard.ts).
      expectConsole(page, {
        allow: [
          /\[RootErrorBoundary\] Unhandled error caught: Error: Streaming error/,
        ],
      });
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      await testId(page, "streaming-error-link").click();

      await expect(
        testId(page, "main-content").locator(
          '[data-testid="streaming-error-loading"]',
        ),
      ).toBeVisible({
        timeout: 2000,
      });

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Streaming errors throw mid-stream after the client starts processing
      // the RSC payload, so RootErrorBoundary catches them client-side and
      // replaces the entire tree (same as client errors, unlike sync server errors).
      await expect(testId(page, "nav")).not.toBeVisible();
    });
  });

  test.describe("streaming-errors (declared boundary)", () => {
    defineStreamedBoundaryScenarios({
      url: (p) => f.url(p),
      waitForHydration,
      index: "/errors",
      navId: "nav",
      fails: {
        path: "/errors/streaming-declared",
        linkId: "streaming-declared-link",
        fallbackId: "streaming-declared-fallback",
        loadingId: "streaming-declared-loading",
        segment: { id: "streaming-declared-segment", text: "route" },
      },
      noSsr: {
        path: "/errors/streaming-declared-no-ssr",
        linkId: "streaming-declared-no-ssr-link",
        fallbackId: "streaming-declared-no-ssr-fallback",
      },
      missing: {
        path: "/errors/streaming-not-found",
        linkId: "streaming-not-found-link",
        fallbackId: "streaming-not-found-fallback",
        loadingId: "streaming-not-found-loading",
      },
    });
  });

  test.describe("streaming-errors (failed render is never stored)", () => {
    // The flaky handlers fail until healed: serial, shared state.
    test.describe.configure({ mode: "serial" });

    test.beforeEach(async ({ request }) => {
      await request.get(f.url("/errors/flaky/reset"));
    });

    for (const [label, path] of [
      ["cache()", "/errors/flaky-cache"],
      ["ppr", "/errors/flaky-ppr"],
    ] as const) {
      test(`${label}: the declared fallback is not stored, the next request is healthy`, async ({
        page,
        request,
      }) => {
        // cache() keeps a healthy entry for its TTL on a long-lived server:
        // a per-run key keeps reruns independent.
        const url = `${path}?run=${Date.now()}`;
        await page.goto(f.url(url));
        await expect(testId(page, "flaky-fallback")).toBeVisible({
          timeout: 10000,
        });

        // Writes settle in the background: give a wrongly stored fallback
        // time to land, then heal. Nothing may have been stored.
        await page.waitForTimeout(1500);
        await request.get(f.url("/errors/flaky/heal"));
        if (label === "ppr") {
          const res = await request.get(f.url(url), {
            headers: { accept: "text/html" },
          });
          expect(res.headers()["x-rango-shell"]).toBe("MISS");
          await page.waitForTimeout(1500);
        }
        for (let i = 0; i < 2; i++) {
          await page.goto(f.url(url));
          await expect(testId(page, "flaky-healthy")).toBeVisible({
            timeout: 10000,
          });
          await expect(testId(page, "flaky-fallback")).toHaveCount(0);
        }
      });
    }
  });

  test.describe("streaming-errors (slot under an ancestor boundary)", () => {
    test("document: a failing slot with loading() renders the layout's errorBoundary", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/slot-ancestor"));
      await expect(testId(page, "slot-ancestor-fallback")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "slot-ancestor-page")).toBeVisible();
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);
      await expect(testId(page, "nav")).toBeVisible();
    });

    test("SPA navigation: same", async ({ page }) => {
      await page.goto(f.url("/errors"));
      await waitForHydration(page);
      await testId(page, "slot-ancestor-link").click();
      await expect(testId(page, "slot-ancestor-fallback")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "slot-ancestor-page")).toBeVisible();
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);
      await expect(testId(page, "nav")).toBeVisible();
    });
  });

  test.describe("navigation-after-error", () => {
    test("should be able to navigate away from error boundary", async ({
      page,
    }) => {
      await page.goto(f.url("/errors/server-error"));

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      // Error fallback has a homepage link
      await page.getByText("Go to homepage").click();

      await expect(testId(page, "index-page")).toBeVisible({
        timeout: 5000,
      });
    });

    test("should work with back navigation after error", async ({ page }) => {
      await page.goto(f.url("/errors"));
      await waitForHydration(page);

      await testId(page, "server-error-link").click();

      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });

      await goBack(page);

      await expect(testId(page, "errors-title")).toBeVisible({
        timeout: 5000,
      });
    });

    test("server error preserves layout, client error replaces it", async ({
      page,
    }) => {
      // Provoked on purpose (console guard, tests/shared-e2e/src/console-guard.ts).
      expectConsole(page, {
        allow: [
          /\[RootErrorBoundary\] Unhandled error caught: Error: Client-side error/,
        ],
      });
      // Server error: layout (nav) is preserved because the error is
      // caught per-segment during RSC render, not by the client-side
      // RootErrorBoundary which would replace the whole tree.
      await page.goto(f.url("/errors/server-error"));
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
      // Nav is still visible — server errors are scoped to the errored segment
      await expect(testId(page, "nav")).toBeVisible();

      // Client error: RootErrorBoundary catches and replaces the entire tree
      await page.goto(f.url("/errors/client-error"));
      await waitForHydration(page);
      await testId(page, "client-error-thrower-trigger").click();
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 5000,
      });
      // Nav is gone — client errors bubble to RootErrorBoundary
      await expect(testId(page, "nav")).not.toBeVisible();

      // Recovery: navigate home and verify full app shell restored
      await page.getByText("Go to homepage").click();
      await waitForHydration(page);
      await expect(testId(page, "app-root")).toBeVisible();
      await expect(testId(page, "nav")).toBeVisible();
      await expect(testId(page, "index-page")).toBeVisible();
    });
  });
}

/**
 * Error boundary tests - dev mode
 */
test.describe("error-boundary", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  errorBoundaryTests(f, true);
});

/**
 * Error boundary tests - production mode
 */
test.describe("error-boundary (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  errorBoundaryTests(f, false);
});
