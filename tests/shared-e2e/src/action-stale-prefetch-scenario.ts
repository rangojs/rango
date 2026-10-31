import { expect, test } from "@playwright/test";
import {
  navigations,
  openProductPage,
  prefetched,
  readNavigationStates,
  readState,
  readTexts,
  recordNavigationStates,
  recordPartials,
  recordTexts,
  sameElement,
  waitForSettled,
  waitForShown,
} from "./action-stale-fixture.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A server action without a directive marks the prefetches made before it
 * stale instead of flushing them, and rotates no state (#1329). A click on a
 * stale prefetch commits it at once; once the click settled, the page
 * revalidates in the background, as Back onto a stale entry does:
 * useNavigation() stays idle and nothing remounts. Visible links do not
 * prefetch again. keepClientCache() keeps the prefetch fresh;
 * invalidateClientCache() in the action still flushes and rotates. Other
 * tabs that share a segment mark theirs stale (or adopt the rotated state)
 * and refresh.
 *
 * Fixture: action-stale.tsx in each app. /action-stale/basket reads the cart
 * in its route after 300 ms; the product page renders prefetching links to
 * it and to /action-stale/other with ?prefetch=render. The add actions
 * answer at once. Both apps call this from a dev and a (production) describe.
 */

export interface ActionStalePrefetchScenarioOptions {
  url: (pathname: string) => string;
  /** Load every module the cases use once per worker (a dev server). */
  warmUp: boolean;
}

function prefetchesOf(
  sent: ReturnType<typeof recordPartials>,
  path: string,
): number {
  return sent.filter((entry) => entry.prefetch && entry.path === path).length;
}

export function runActionStalePrefetchTests(
  options: ActionStalePrefetchScenarioOptions,
): void {
  test.beforeAll(async ({ browser }) => {
    if (!options.warmUp) return;
    test.setTimeout(60000);
    const page = await browser.newPage();
    try {
      const sent = await openProductPage(page, options, "?prefetch=render");
      await prefetched(sent, "/action-stale/basket");
      await page.getByTestId("as-add-keep").click();
      await waitForSettled(page);
      await page.getByTestId("as-add-invalidate").click();
      await waitForSettled(page);
      await page.getByTestId("as-to-basket-prefetched").click();
      await expect(page.getByTestId("as-basket")).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test("a click on a prefetch made before an action shows it at once, then the write, idle and in place", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=render");
    await prefetched(sent, "/action-stale/basket");
    const state = await readState(page);

    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    expect(await readState(page), "the action rotates no state").toBe(state);
    // Visible links keep their (stale) prefetch: none prefetches again.
    await page.waitForTimeout(500);
    expect(prefetchesOf(sent, "/action-stale/basket")).toBe(1);

    await recordTexts(page, "as-basket");
    await recordNavigationStates(page, "as-basket");
    await page.getByTestId("as-to-basket-prefetched").click();
    await waitForShown(page, "as-basket");
    // The revalidation leaves as the click settles, around the same frame.
    expect(
      navigations(sent, "/action-stale/basket").filter((entry) => !entry.stale),
      "the click shows the prefetched page without a request of its own",
    ).toEqual([]);

    await expect(page.getByTestId("as-basket")).toHaveText("basket:1");
    test.info().annotations.push({
      type: "basket",
      description: (await readTexts(page)).join(" -> "),
    });
    expect(
      await readTexts(page),
      "the prefetch's pre-write page, then the revalidated one",
    ).toEqual(["basket:0", "basket:1"]);
    expect(await sameElement(page), "the page is updated in place").toBe(true);
    const [revalidation, ...more] = navigations(sent, "/action-stale/basket");
    expect(revalidation?.stale, "one stale revalidation").toBe(true);
    expect(revalidation?.whole, "it holds the page's segments").toBe(false);
    expect(more).toEqual([]);
    const seen = await readNavigationStates(page);
    expect(
      seen.filter((entry) => entry.shown && entry.state === "loading"),
      `useNavigation() stays idle once the page is shown: ${JSON.stringify(seen)}`,
    ).toEqual([]);
    expect(await readState(page)).toBe(state);
  });

  test("keepClientCache() keeps the prefetch fresh: the click shows it and nothing revalidates", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=render");
    await prefetched(sent, "/action-stale/basket");

    await page.getByTestId("as-add-keep").click();
    await waitForSettled(page);

    await page.getByTestId("as-to-basket-prefetched").click();
    await expect(page.getByTestId("as-basket")).toHaveText("basket:0");
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("as-basket")).toHaveText("basket:0");
    expect(navigations(sent, "/action-stale/basket")).toEqual([]);
  });

  test("invalidateClientCache() in the action rotates the state and the click shows the write first", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options, "?prefetch=render");
    const state = await readState(page);

    await page.getByTestId("as-add-invalidate").click();
    await waitForSettled(page);
    await expect.poll(() => readState(page)).not.toBe(state);

    await recordTexts(page, "as-basket");
    await page.getByTestId("as-to-basket-prefetched").click();
    await expect(page.getByTestId("as-basket")).toHaveText("basket:1");
    expect(await readTexts(page)).toEqual(["basket:1"]);
  });

  test("Back after an action shows the cached page, then the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);
    await page.getByTestId("as-to-basket").click();
    await expect(page.getByTestId("as-basket")).toHaveText("basket:0");
    await page.goBack();
    await expect(page.getByTestId("as-pdp")).toBeVisible();

    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    await recordTexts(page, "as-basket");
    await page.goForward();
    await expect(page.getByTestId("as-basket")).toHaveText("basket:1");
    expect(await readTexts(page)).toEqual(["basket:0", "basket:1"]);
    expect(await sameElement(page)).toBe(true);
    const [, revalidation] = navigations(sent, "/action-stale/basket");
    expect(revalidation?.stale).toBe(true);
  });

  test("another tab refreshes after an action, keeps the state and revalidates its stale prefetch", async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options);
    const state = await readState(page);
    const other = await context.newPage();
    try {
      const sent = recordPartials(other);
      await other.goto(options.url("/action-stale/pdp?prefetch=render"));
      await waitForShellHydration(other);
      await prefetched(sent, "/action-stale/basket");

      await page.getByTestId("as-add-fast").click();
      await waitForSettled(page);
      await expect(other.getByTestId("as-cart")).toHaveText("cart:1");
      expect(await readState(other)).toBe(state);

      await recordTexts(other, "as-basket");
      await other.getByTestId("as-to-basket-prefetched").click();
      await expect(other.getByTestId("as-basket")).toHaveText("basket:1");
      expect(await readTexts(other)).toEqual(["basket:0", "basket:1"]);
    } finally {
      await other.close();
    }
  });

  test("another tab adopts the state an action's invalidateClientCache() rotated and drops its prefetch", async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options);
    const state = await readState(page);
    const other = await context.newPage();
    try {
      const sent = recordPartials(other);
      await other.goto(options.url("/action-stale/pdp?prefetch=render"));
      await waitForShellHydration(other);
      await prefetched(sent, "/action-stale/basket");

      await page.getByTestId("as-add-invalidate").click();
      await waitForSettled(page);
      await expect(other.getByTestId("as-cart")).toHaveText("cart:1");
      const rotated = await readState(other);
      expect(rotated).not.toBe(state);

      await recordTexts(other, "as-basket");
      await other.getByTestId("as-to-basket-prefetched").click();
      await expect(other.getByTestId("as-basket")).toHaveText("basket:1");
      expect(await readTexts(other)).toEqual(["basket:1"]);
      expect(await readState(other)).toBe(rotated);
    } finally {
      await other.close();
    }
  });
}
