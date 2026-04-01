import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, expectNoPageError } from "./helper";

/**
 * Rendered barrier e2e tests.
 *
 * Tests the experimental ctx.rendered() API: DSL loaders that wait for
 * handlers to settle and then read handle data via ctx.use(handle).
 *
 * Scenario: Handlers push product IDs via a Products handle. The LivePricesLoader
 * calls await ctx.rendered(), reads the product IDs, and returns live prices.
 * A client component (PriceDisplay) reads the loader data via useLoader().
 *
 * Covered paths:
 * - Fresh SSR (no caching)
 * - Cached handler (cache() DSL — handler cached, loader live)
 * - "use cache" handler (inline directive)
 * - Prerendered handler (Prerender() — handle data replayed from build)
 * - Layout + route handle accumulation
 */

function renderedBarrierTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;
  test.describe(`rendered-barrier (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
    });

    test("fresh SSR: loader reads handle data from handler", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/rendered-barrier/fresh"));
      await waitForHydration(page);

      // Handler rendered
      await expect(testId(page, "rendered-fresh-title")).toHaveText(
        "Fresh Products",
      );

      // Prices loaded — loader read product IDs from handle
      await expect(testId(page, "rendered-fresh-price-count")).toHaveText("2");
      await expect(testId(page, "rendered-fresh-price-widget-a")).toContainText(
        "$9.99",
      );
      await expect(testId(page, "rendered-fresh-price-widget-b")).toContainText(
        "$19.99",
      );
    });

    test("cached handler: loader reads replayed handle data and stays live", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      // First visit populates cache
      await page.goto(f.url("/rendered-barrier/cached"));
      await waitForHydration(page);

      await expect(testId(page, "rendered-cached-title")).toHaveText(
        "Cached Products",
      );
      const ts1 = await testId(page, "rendered-cached-ts").textContent();
      const fetchedAt1 = await testId(
        page,
        "rendered-cached-fetched-at",
      ).textContent();

      // Prices loaded — handler pushes widget-b and widget-c
      await expect(testId(page, "rendered-cached-price-count")).toHaveText("2");
      await expect(
        testId(page, "rendered-cached-price-widget-b"),
      ).toContainText("$19.99");
      await expect(
        testId(page, "rendered-cached-price-widget-c"),
      ).toContainText("$29.99");

      // Small delay so fetchedAt differs on second visit
      await page.waitForTimeout(50);

      // Second visit — handler cached, but loader must re-execute fresh
      await page.goto(f.url("/rendered-barrier/cached"));
      await waitForHydration(page);

      const ts2 = await testId(page, "rendered-cached-ts").textContent();
      const fetchedAt2 = await testId(
        page,
        "rendered-cached-fetched-at",
      ).textContent();

      // Handler is cached — same timestamp
      expect(ts1).toBe(ts2);

      // Loader re-ran fresh — fetchedAt changed
      expect(Number(fetchedAt1)).toBeGreaterThan(0);
      expect(Number(fetchedAt2)).toBeGreaterThan(0);
      expect(Number(fetchedAt2)).toBeGreaterThan(Number(fetchedAt1));

      // Prices still correct
      await expect(testId(page, "rendered-cached-price-count")).toHaveText("2");
    });

    test('"use cache" handler: loader reads handle data from cached handler', async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/rendered-barrier/use-cache"));
      await waitForHydration(page);

      await expect(testId(page, "rendered-usecache-title")).toHaveText(
        "Use Cache Products",
      );

      // Prices loaded for gadgets
      await expect(testId(page, "rendered-usecache-price-count")).toHaveText(
        "2",
      );
      await expect(
        testId(page, "rendered-usecache-price-gadget-x"),
      ).toContainText("$49.99");
      await expect(
        testId(page, "rendered-usecache-price-gadget-y"),
      ).toContainText("$99.99");
    });

    test("prerendered handler: loader reads replayed handle data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/rendered-barrier/prerender"));
      await waitForHydration(page);

      await expect(testId(page, "rendered-prerender-title")).toHaveText(
        "Prerendered Products",
      );

      // Prices loaded — handle data replayed from prerender build artifacts
      await expect(testId(page, "rendered-prerender-price-count")).toHaveText(
        "2",
      );
      await expect(
        testId(page, "rendered-prerender-price-widget-a"),
      ).toContainText("$9.99");
      await expect(
        testId(page, "rendered-prerender-price-widget-c"),
      ).toContainText("$29.99");
    });

    test("layout + route accumulation: loader sees all handle data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/rendered-barrier/accumulate"));
      await waitForHydration(page);

      // Layout pushes widget-a, route pushes widget-b and widget-c
      // Loader should see all 3 product IDs
      await expect(testId(page, "rendered-accumulate-price-count")).toHaveText(
        "3",
      );
      await expect(
        testId(page, "rendered-accumulate-price-widget-a"),
      ).toContainText("$9.99");
      await expect(
        testId(page, "rendered-accumulate-price-widget-b"),
      ).toContainText("$19.99");
      await expect(
        testId(page, "rendered-accumulate-price-widget-c"),
      ).toContainText("$29.99");
    });

    test("SPA navigation: loader re-fetches prices for new route", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/rendered-barrier/fresh"));
      await waitForHydration(page);

      // Verify fresh page has 2 prices
      await expect(testId(page, "rendered-fresh-price-count")).toHaveText("2");

      // Navigate to accumulate page via SPA
      await testId(page, "nav-accumulate").click();

      // Should now show 3 prices (layout widget-a + route widget-b, widget-c)
      await expect(testId(page, "rendered-accumulate-price-count")).toHaveText(
        "3",
      );
    });

    test("streaming tree: rendered() rejects with loading()", async ({
      page,
    }) => {
      // rendered() throws inside the loader because the route has loading().
      // The error propagates through the RSC render. In production it shows
      // a generic React error; in dev it shows the Vite error overlay.
      // Either way, the normal price data should NOT be present.
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await page.goto(f.url("/rendered-barrier/streaming-rejected"));
      await page.waitForTimeout(3000);

      // The price display should NOT have rendered successfully
      const pricesVisible = await testId(page, "rendered-streaming-prices")
        .isVisible()
        .catch(() => false);
      expect(pricesVisible).toBe(false);
    });
  });
}

// Dev and production parity
renderedBarrierTests("dev");
renderedBarrierTests("build");
