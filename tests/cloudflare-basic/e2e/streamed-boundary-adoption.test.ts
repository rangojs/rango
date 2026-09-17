import { expect, test } from "@playwright/test";
import { countDomBoundaryMarkers, countHtmlBoundaryMarkers } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Cloudflare counterpart of packages/rangojs-router/e2e/streamed-boundary-
// adoption.test.ts. /suspense-demo/gated has two boundaries that resolve after
// hydration: the route loading() (stats read, 400ms) and the report card's
// local Suspense (2000ms).

function defineSuite(mode: "dev" | "build") {
  // Title DERIVED from mode so the `(production)` bucket tag can never drift.
  const title = `Streamed boundary adoption${mode === "build" ? " (production)" : ""}`;

  test.describe(title, () => {
    const f = useFixture({ root: ".", mode });

    test("boundaries resolving after hydration adopt the streamed server HTML", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const url = f.url("/suspense-demo/gated");

      // Warm the module graph so hydration reliably beats the loaders.
      await page.goto(url);
      await expect(testId(page, "sd-report")).toBeVisible();

      const document = page.waitForResponse(
        (r) => r.url() === url && r.request().resourceType() === "document",
      );
      await page.goto(url);
      await waitForHydration(page);

      // Hydration can still lose the race on a slow runner; the placeholder
      // shape is only observable while a boundary is pending.
      const pending = await page.evaluate(() => ({
        report: !!document.querySelector('[data-testid="sd-report"]'),
        placeholder: !!document.querySelector('template[id^="B:"]'),
      }));
      if (!pending.report) {
        expect(pending.placeholder).toBe(true);
      }

      await expect(testId(page, "sd-stats")).toBeVisible();
      await expect(testId(page, "sd-report")).toBeVisible();
      const serverMarkers = countHtmlBoundaryMarkers(
        await (await document).text(),
      );
      expect(serverMarkers).toBeGreaterThan(0);
      await expect
        .poll(() => countDomBoundaryMarkers(page))
        .toBe(serverMarkers);
    });
  });
}

defineSuite("dev");
defineSuite("build");
