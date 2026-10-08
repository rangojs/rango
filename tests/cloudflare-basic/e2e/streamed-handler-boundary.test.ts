import { expect, test } from "@playwright/test";
import { defineStreamedBoundaryScenarios, expectConsole } from "@shared/e2e";
import { useFixture } from "./fixture";
import { testId, waitForHydration } from "./helper";

// A handler under loading() streams after the response started. When it
// rejects or calls notFound(), the nearest declared errorBoundary() /
// notFoundBoundary() renders in place of the segment (layout and nav stay,
// status stays 200). With no declared boundary the rejection still reaches
// RootErrorBoundary, which replaces the tree. Counterpart of
// packages/rangojs-router/e2e/error-boundary.test.ts "streaming-errors".

function defineSuite(mode: "dev" | "build") {
  // Title DERIVED from mode so the `(production)` bucket tag can never drift.
  const title = `Streamed handler declared boundary${mode === "build" ? " (production)" : ""}`;

  test.describe(title, () => {
    const f = useFixture({ root: ".", mode });
    const base = "/streamed-handler-boundary";

    defineStreamedBoundaryScenarios({
      url: (p) => f.url(p),
      waitForHydration,
      index: base,
      navId: "nav",
      fails: {
        path: `${base}/fails`,
        linkId: "shb-fails-link",
        fallbackId: "shb-fails-fallback",
        loadingId: "shb-fails-loading",
      },
      noSsr: {
        path: `${base}/fails-no-ssr`,
        linkId: "shb-no-ssr-link",
        fallbackId: "shb-no-ssr-fallback",
      },
      missing: {
        path: `${base}/missing`,
        linkId: "shb-missing-link",
        fallbackId: "shb-missing-fallback",
        loadingId: "shb-missing-loading",
      },
    });

    test.describe("a failed render is never stored", () => {
      // The flaky handlers fail until healed: serial, shared state.
      test.describe.configure({ mode: "serial" });

      test.beforeEach(async ({ request }) => {
        await request.get(f.url(`${base}/reset`));
      });

      for (const [label, route] of [
        ["cache()", "flaky-cache"],
        ["ppr", "flaky-ppr"],
      ] as const) {
        test(`${label}: the declared fallback is not stored, the next request is healthy`, async ({
          page,
          request,
        }) => {
          // cache() keeps a healthy entry for its TTL on a long-lived server:
          // a per-run key keeps reruns independent.
          const url = `${base}/${route}?run=${Date.now()}`;
          await page.goto(f.url(url));
          await expect(testId(page, "shb-flaky-fallback")).toBeVisible({
            timeout: 10000,
          });

          // Writes settle in the background: give a wrongly stored fallback
          // time to land, then heal. Nothing may have been stored.
          await page.waitForTimeout(1500);
          await request.get(f.url(`${base}/heal`));
          if (label === "ppr") {
            const res = await request.get(f.url(url), {
              headers: { accept: "text/html" },
            });
            expect(res.headers()["x-rango-shell"]).toBe("MISS");
            await page.waitForTimeout(1500);
          }
          for (let i = 0; i < 2; i++) {
            await page.goto(f.url(url));
            await expect(testId(page, "shb-flaky-healthy")).toBeVisible({
              timeout: 10000,
            });
            await expect(testId(page, "shb-flaky-fallback")).toHaveCount(0);
          }
        });
      }
    });

    test("a failing slot with loading() renders the layout's errorBoundary (document and SPA)", async ({
      page,
    }) => {
      await page.goto(f.url(`${base}/slot-ancestor`));
      await expect(testId(page, "shb-slot-fallback")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "shb-slot-page")).toBeVisible();
      await expect(page.getByText("Internal Server Error")).toHaveCount(0);

      await page.goto(f.url(base));
      await waitForHydration(page);
      await testId(page, "shb-slot-link").click();
      await expect(testId(page, "shb-slot-fallback")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "shb-slot-page")).toBeVisible();
      await expect(testId(page, "nav")).toBeVisible();
    });

    test("no declared boundary: RootErrorBoundary still replaces the tree", async ({
      page,
    }) => {
      // Provoked on purpose (console guard, tests/shared-e2e/src/console-guard.ts).
      expectConsole(page, {
        allow: [
          /\[RootErrorBoundary\] Unhandled error caught: Error: streamed handler failed after the response started/,
        ],
      });
      await page.goto(f.url(base));
      await waitForHydration(page);
      await testId(page, "shb-undeclared-link").click();
      await expect(page.getByText("Internal Server Error")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "nav")).not.toBeVisible();
    });
  });
}

defineSuite("dev");
defineSuite("build");
