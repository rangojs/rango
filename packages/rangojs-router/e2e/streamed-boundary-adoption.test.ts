import { expect, test } from "@playwright/test";
import { countDomBoundaryMarkers, countHtmlBoundaryMarkers } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * A `loading()` boundary that resolves AFTER the shell hydrated must stay
 * dehydrated and adopt the server HTML Fizz outlines for it ($RC swap), never
 * be client-rendered from the Flight payload. Root cause and mechanism: the
 * contextValue comment in src/theme/ThemeProvider.tsx. Pinned without timing
 * assumptions: every boundary marker the server emitted survives in the
 * settled DOM (countDomBoundaryMarkers).
 */
function boundaryAdoptionTests(f: Fixture) {
  test("a boundary that resolves after hydration adopts the streamed server HTML", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const url = f.url("/slow-streaming");

    // Warm the module graph so hydration reliably beats the 1s loader.
    await page.goto(url);
    await expect(testId(page, "slow-streaming-message")).toBeVisible();

    const document = page.waitForResponse(
      (r) => r.url() === url && r.request().resourceType() === "document",
    );
    await page.goto(url);
    await waitForHydration(page);

    // Hydration can still lose the race on a slow runner; the placeholder
    // shape is only observable while the boundary is pending.
    const pending = await page.evaluate(() => ({
      content: !!document.querySelector(
        '[data-testid="slow-streaming-message"]',
      ),
      placeholder: !!document.querySelector('template[id^="B:"]'),
    }));
    if (!pending.content) {
      expect(pending.placeholder).toBe(true);
    }

    await expect(testId(page, "slow-streaming-message")).toHaveText(
      "Slow data loaded",
    );
    const serverMarkers = countHtmlBoundaryMarkers(
      await (await document).text(),
    );
    expect(serverMarkers).toBeGreaterThan(0);
    await expect.poll(() => countDomBoundaryMarkers(page)).toBe(serverMarkers);
  });
}

test.describe("streamed boundary adoption", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  boundaryAdoptionTests(f);
});

test.describe("streamed boundary adoption (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  boundaryAdoptionTests(f);
});
