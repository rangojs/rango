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

    test("streaming tree: rendered() waits for the loading() handler, then reads its data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      // The handler is behind loading() and pushes gadget-x/gadget-y only after
      // an await (during the streaming phase, past the render barrier). Before
      // the fix, rendered() threw here. Now it waits for the streaming handler
      // to settle, so the loader reads the pushed IDs and resolves their prices.
      await page.goto(f.url("/rendered-barrier/streaming"));
      await waitForHydration(page);

      await expect(testId(page, "rendered-streaming-title")).toHaveText(
        "Streaming Products",
      );

      // Prices loaded — proves the loader saw the handle data pushed during
      // streaming (an empty/early barrier would yield a count of 0).
      await expect(testId(page, "rendered-streaming-price-count")).toHaveText(
        "2",
      );
      await expect(
        testId(page, "rendered-streaming-price-gadget-x"),
      ).toContainText("$49.99");
      await expect(
        testId(page, "rendered-streaming-price-gadget-y"),
      ).toContainText("$99.99");
    });

    test("streaming + cache hit: rendered() reads replayed handle data on the cached path", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      // A loading() handler under cache(): the streamed handle push must be
      // captured into the cache on the miss and replayed on the hit, so the live
      // loader's rendered() reads it on the cache-hit path (not the empty live
      // store). First visit populates the cache.
      await page.goto(f.url("/rendered-barrier/streaming-cached"));
      await waitForHydration(page);
      await expect(testId(page, "rendered-streaming-cached-title")).toHaveText(
        "Streaming Cached",
      );
      const ts1 = await testId(
        page,
        "rendered-streaming-cached-ts",
      ).textContent();
      await expect(
        testId(page, "rendered-streaming-cached-price-count"),
      ).toHaveText("2");
      await expect(
        testId(page, "rendered-streaming-cached-price-widget-a"),
      ).toContainText("$9.99");
      await expect(
        testId(page, "rendered-streaming-cached-price-widget-b"),
      ).toContainText("$19.99");

      await page.waitForTimeout(50);

      // Second visit — cache HIT: handler (and its streamed handle data) replayed
      // from cache. The handler ts is unchanged; the live loader re-runs and its
      // rendered() reads the replayed handle data on the cache-hit path.
      await page.goto(f.url("/rendered-barrier/streaming-cached"));
      await waitForHydration(page);
      const ts2 = await testId(
        page,
        "rendered-streaming-cached-ts",
      ).textContent();
      expect(ts1).toBe(ts2);
      await expect(
        testId(page, "rendered-streaming-cached-price-count"),
      ).toHaveText("2");
      await expect(
        testId(page, "rendered-streaming-cached-price-widget-a"),
      ).toContainText("$9.99");
      await expect(
        testId(page, "rendered-streaming-cached-price-widget-b"),
      ).toContainText("$19.99");
    });

    test("streaming + prerender replay: rendered() reads replayed handle data", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      // A loading() handler that is build-time prerendered. At runtime the
      // handler output and its streamed handle data are replayed; the live
      // loader's rendered() must read the replayed data on the prerender path.
      await page.goto(f.url("/rendered-barrier/streaming-prerender"));
      await waitForHydration(page);
      await expect(
        testId(page, "rendered-streaming-prerender-title"),
      ).toHaveText("Streaming Prerender");
      await expect(
        testId(page, "rendered-streaming-prerender-price-count"),
      ).toHaveText("2");
      await expect(
        testId(page, "rendered-streaming-prerender-price-widget-a"),
      ).toContainText("$9.99");
      await expect(
        testId(page, "rendered-streaming-prerender-price-widget-c"),
      ).toContainText("$29.99");
    });

    test("streaming deadlock: handler awaiting a rendered() loader errors, does not hang", async ({
      page,
    }) => {
      // A loading() handler awaits a loader that calls rendered() — a cycle.
      // The deadlock guard must surface an error rather than hang, even though
      // rendered() keeps waiting on handleStore.settled AFTER the barrier
      // resolves. We assert the success title did NOT render and that an error
      // signal is present; a regression that reopened the deadlock would instead
      // time this test out.
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      const response = await page.goto(
        f.url("/rendered-barrier/streaming-deadlock"),
      );
      await page.waitForTimeout(2000);

      const titleVisible = await testId(page, "rendered-deadlock-title")
        .isVisible()
        .catch(() => false);
      expect(titleVisible).toBe(false);

      const hasPageError = errors.length > 0;
      const hasErrorStatus = response !== null && response.status() >= 400;
      const hasErrorText = await page
        .locator("text=/error/i")
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      expect(
        hasPageError || hasErrorStatus || hasErrorText,
        `Expected a deadlock error signal, got none. ` +
          `pageErrors=${errors.length}, status=${response?.status()}, ` +
          `errorText=${hasErrorText}`,
      ).toBe(true);
    });
  });
}

// Dev and production parity
renderedBarrierTests("dev");
renderedBarrierTests("build");
