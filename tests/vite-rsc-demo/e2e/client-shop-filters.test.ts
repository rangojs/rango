import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * Same-route revalidation content-hold, pinned on the /client-shop category
 * filters. A filter click is a SAME-ROUTE navigation (search change only):
 * the list loader re-runs while the route segment stays mounted. The commit
 * contract (isSameStructureNav in browser/partial-update.ts): a navigation
 * that mounts no new segments commits inside startTransition — the visible
 * grid HOLDS while the 400ms loader streams, instead of re-suspending the
 * already-revealed boundary into its skeleton for the loader's full duration.
 * Meanwhile useOutlet().pending reports the in-flight nav (ClientUrlsRoot
 * treats ANY group intent as pending, same-route included), so the layout's
 * aria-busy dims the held content.
 *
 * The rAF recorder is installed pre-click and samples every frame: a
 * transient skeleton frame or a content gap cannot slip between Playwright
 * polls.
 */

interface FilterSample {
  skeleton: boolean;
  cards: number;
  busy: string | null;
}

async function installRecorder(page: Page) {
  await page.evaluate(() => {
    const recs: Array<{
      skeleton: boolean;
      cards: number;
      busy: string | null;
    }> = [];
    (window as any).__filterRecs = recs;
    (window as any).__filterRecsActive = true;
    const sample = () => {
      recs.push({
        skeleton: !!document.querySelector(
          '[data-testid="client-shop-grid-skeleton"]',
        ),
        cards: document.querySelectorAll('[data-testid^="client-shop-card-"]')
          .length,
        busy:
          document
            .querySelector('[data-testid="client-shop"]')
            ?.getAttribute("aria-busy") ?? null,
      });
      if ((window as any).__filterRecsActive !== false) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  });
}

async function readRecorder(page: Page): Promise<FilterSample[]> {
  return page.evaluate(() => {
    (window as any).__filterRecsActive = false;
    return (window as any).__filterRecs;
  });
}

async function runFilterHoldSpec(page: Page, base: string) {
  await page.goto(new URL("/client-shop", base).href);
  await waitForHydration(page);
  const allCards = page.locator('[data-testid^="client-shop-card-"]');
  await expect(
    page.locator('[data-testid="client-shop-card-wireless-headphones"]'),
  ).toBeVisible();
  const initialCount = await allCards.count();
  expect(initialCount).toBeGreaterThan(0);

  await installRecorder(page);
  await page.click('[data-testid="client-shop-filter-electronics"]');

  // Filtered list lands (fewer cards, every card in the category).
  await expect
    .poll(async () => allCards.count(), { timeout: 10000 })
    .toBeLessThan(initialCount);
  const filteredCount = await allCards.count();
  expect(filteredCount).toBeGreaterThan(0);
  for (const text of await allCards.allTextContents()) {
    expect(text).toContain("electronics");
  }
  expect(page.url()).toContain("category=electronics");
  await expect(page.locator('[data-testid="client-shop"]')).toHaveAttribute(
    "aria-busy",
    "false",
  );

  const recs = await readRecorder(page);
  expect(recs.length).toBeGreaterThan(0);
  // The held commit: the grid skeleton never rendered, and the card count
  // went directly initial -> filtered with no empty frame in between.
  expect(recs.some((r) => r.skeleton)).toBe(false);
  const counts = [...new Set(recs.map((r) => r.cards))];
  expect(counts.every((c) => c === initialCount || c === filteredCount)).toBe(
    true,
  );
  // The pending signal: aria-busy=true frames were observable while the old
  // content held (the urgent setIntent), and only over held content.
  expect(recs.some((r) => r.busy === "true")).toBe(true);
  expect(recs.some((r) => r.busy === "true" && r.cards === initialCount)).toBe(
    true,
  );

  // setSearchParams leg: the programmatic clear button navigates the same
  // route with an empty search (RR wholesale-replace) — the commit holds the
  // filtered grid exactly like the Link filters did.
  await installRecorder(page);
  await page.click('[data-testid="client-shop-filter-clear"]');
  await expect
    .poll(async () => allCards.count(), { timeout: 10000 })
    .toBe(initialCount);
  expect(new URL(page.url()).search).toBe("");
  const clearRecs = await readRecorder(page);
  expect(clearRecs.some((r) => r.skeleton)).toBe(false);
  expect(clearRecs.some((r) => r.busy === "true")).toBe(true);
}

devTest.describe("client-shop filters: same-route content-hold", () => {
  devTest(
    "filter change holds the visible grid with aria-busy instead of flashing the skeleton",
    async ({ page, devServerURL }) => {
      // Warm the module graph so the nav window is bounded by the 400ms
      // loader, not dev compile time.
      await page.goto(devURL(devServerURL, "/client-shop?category=home"));
      await waitForHydration(page);
      await runFilterHoldSpec(page, devServerURL);
    },
  );
});

prodDescribe("client-shop filters: same-route content-hold", (f) => {
  test("filter change holds the visible grid with aria-busy instead of flashing the skeleton", async ({
    page,
  }) => {
    await runFilterHoldSpec(page, f.url("/"));
  });
});
