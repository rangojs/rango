import { randomUUID } from "node:crypto";
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
  useKey,
  waitForSettled,
  waitForSettledNow,
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
 * and refresh. Only a click takes a stale prefetch, once (rango-d239): Back
 * onto an entry the history cache evicted fetches the page.
 *
 * Every case where a stale value shows asserts (a) the stale value at once,
 * (b) exactly one stale revalidation, (c) the fresh value in place.
 *
 * Fixture: action-stale.tsx in each app. /action-stale/basket reads the cart
 * in its route after 300 ms; the product page renders prefetching links to
 * it and to /action-stale/other with ?prefetch=render (=inflight: a slow
 * basket on hover; =transition: a transition() basket).
 * /action-stale/counted is a layout whose loader re-runs on every
 * navigation, and /action-stale/bare/* a basket and a chain of pages under a
 * layout with no revalidate(). The add actions answer at once. Both apps
 * call this from a dev and a (production) describe.
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
    // Exactly one request: let a second one, if any, leave.
    await page.waitForTimeout(500);
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
    // Exactly one request after the click's own: the revalidation.
    await page.waitForTimeout(500);
    const [, revalidation, ...more] = navigations(sent, "/action-stale/basket");
    expect(revalidation?.stale).toBe(true);
    expect(more).toEqual([]);
  });

  // Only a click takes a stale prefetch: it revalidates after it. Back onto
  // an entry the 20-entry history cache evicted fetches the page, and must
  // not be answered by the basket's prefetch, which an action made stale:
  // nothing would revalidate it, and the pre-write page would be cached as
  // fresh. The bare pages' prefetch is stored in the slot every source page
  // shares, so Back from another page finds it.
  test("Back after an action onto an entry evicted from the history cache shows fresh data, never pre-write", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await useKey(page, options, randomUUID());
    const sent = recordPartials(page);
    await page.goto(options.url("/action-stale/bare/basket"));
    await waitForShellHydration(page);
    await expect(page.getByTestId("as-bare-basket")).toHaveText("basket:0");

    // 22 entries evict the basket's from the history cache.
    await page.getByTestId("as-to-hop").click();
    await expect(page.getByTestId("as-hop-n")).toHaveText("hop:1");
    for (let n = 2; n <= 22; n++) {
      await page.getByTestId("as-to-next-hop").click();
      await expect(page.getByTestId("as-hop-n")).toHaveText(`hop:${n}`);
    }

    // The last hop prefetches the basket (basket:0); then the write.
    await prefetched(sent, "/action-stale/bare/basket");
    await page.getByTestId("as-bare-add").click();
    await waitForSettled(page);
    await expect(page.locator("html")).toHaveAttribute("data-as-result", "1");

    const before = navigations(sent, "/action-stale/bare/basket").length;
    await recordTexts(page, "as-bare-basket");
    await page.evaluate(() => history.go(-22));
    await expect(page.getByTestId("as-bare-basket")).toHaveText("basket:1");
    expect(
      await readTexts(page),
      "the page is fetched: the stale prefetch never shows",
    ).toEqual(["basket:1"]);
    expect(
      navigations(sent, "/action-stale/bare/basket").length,
      "Back fetched the page",
    ).toBeGreaterThan(before);
  });

  // A prefetch still in flight when the action lands finishes and is stored
  // stale with its whole body (it is never aborted): the click shows it, then
  // revalidates.
  test("a prefetch in flight when the action lands is served stale, then revalidated", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=inflight");
    // A hover prefetch: an action's start cancels queued prefetches
    // (NavigationProvider), not a direct one.
    await page.getByTestId("as-to-slow-basket-prefetched").hover();
    await expect
      .poll(() =>
        sent.some(
          (entry) => entry.prefetch && entry.path === "/action-stale/basket",
        ),
      )
      .toBe(true);
    const inflight = sent.find(
      (entry) => entry.prefetch && entry.path === "/action-stale/basket",
    )!;

    await page.getByTestId("as-add-fast").click();
    await waitForSettledNow(page);
    expect(inflight.finished, "the prefetch was in flight at the landing").toBe(
      false,
    );
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await prefetched(sent, "/action-stale/basket");

    await recordTexts(page, "as-basket");
    // A click with no pointer move over the link: a hover would replace the
    // stale prefetch with a fresh one.
    await page
      .getByTestId("as-to-slow-basket-prefetched")
      .dispatchEvent("click");
    await waitForShown(page, "as-basket");
    // (a) the prefetch, at once, with no request of the click's own.
    expect(await readTexts(page)).toEqual(["basket:0"]);
    expect(
      navigations(sent, "/action-stale/basket").filter((entry) => !entry.stale),
    ).toEqual([]);
    // (c) then the write, in place, (b) after one stale revalidation.
    await expect(page.getByTestId("as-basket")).toHaveText("basket:1");
    expect(await readTexts(page)).toEqual(["basket:0", "basket:1"]);
    expect(await sameElement(page)).toBe(true);
    await page.waitForTimeout(500);
    expect(
      navigations(sent, "/action-stale/basket").map((entry) => [
        entry.stale,
        entry.whole,
      ]),
    ).toEqual([[true, false]]);
  });

  test("a newer navigation while the stale revalidation is out leaves nothing stale: Back revalidates the page", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=render");
    await prefetched(sent, "/action-stale/basket");
    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    await page.getByTestId("as-to-basket-prefetched").click();
    await waitForShown(page, "as-basket");
    await expect(page.getByTestId("as-basket")).toHaveText("basket:0");
    // The basket's revalidation answers after 300 ms: leave before it does.
    await page.getByTestId("as-to-pdp").click();
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(
      page.getByTestId("as-basket"),
      "the dropped revalidation commits nothing",
    ).toHaveCount(0);
    await expect(page.getByTestId("as-pdp")).toBeVisible();

    // The basket entry was marked stale before its revalidation left, so
    // Back onto it shows it, then revalidates it.
    const before = navigations(sent, "/action-stale/basket").length;
    await recordTexts(page, "as-basket");
    await page.goBack();
    await expect(page.getByTestId("as-basket")).toHaveText("basket:1");
    expect(await readTexts(page)).toEqual(["basket:0", "basket:1"]);
    expect(await sameElement(page)).toBe(true);
    await page.waitForTimeout(500);
    const afterBack = navigations(sent, "/action-stale/basket").slice(before);
    expect(afterBack.map((entry) => entry.stale)).toEqual([true]);
  });

  test("a transition() route: the stale prefetch, then the write, idle and in place", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=transition");
    await prefetched(sent, "/action-stale/basket-transition");
    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    await recordTexts(page, "as-basket-transition");
    await recordNavigationStates(page, "as-basket-transition");
    await page.getByTestId("as-to-basket-transition-prefetched").click();
    await expect(page.getByTestId("as-basket-transition")).toHaveText(
      "basket:1",
    );
    expect(await readTexts(page)).toEqual(["basket:0", "basket:1"]);
    expect(await sameElement(page)).toBe(true);
    await page.waitForTimeout(500);
    const requests = navigations(sent, "/action-stale/basket-transition");
    expect(requests.map((entry) => [entry.stale, entry.whole])).toEqual([
      [true, false],
    ]);
    const seen = await readNavigationStates(page);
    expect(
      seen.filter((entry) => entry.shown && entry.state === "loading"),
      `useNavigation() stays idle once the page is shown: ${JSON.stringify(seen)}`,
    ).toEqual([]);
  });

  // rango-d170: a layout loader that re-runs on every navigation is in every
  // prefetch under it. The click shows the count from before the write, then
  // its revalidation the new one: the accepted flash, recorded.
  test("a layout loader every prefetch carries: the count goes back, then forward, in place", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);
    await page.goto(options.url("/action-stale/counted"));
    await waitForShellHydration(page);
    await expect(page.getByTestId("as-count")).toHaveText("count:0");
    await prefetched(sent, "/action-stale/counted/next");

    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-count")).toHaveText("count:1");

    await recordTexts(page, "as-count");
    await page.getByTestId("as-to-counted-next-prefetched").click();
    await expect(page.getByTestId("as-counted-next")).toBeVisible();
    await expect(page.getByTestId("as-count")).toHaveText("count:1");
    const flash = await readTexts(page);
    test.info().annotations.push({
      type: "count",
      description: flash.join(" -> "),
    });
    expect(flash).toEqual(["count:1", "count:0", "count:1"]);
    expect(await sameElement(page)).toBe(true);
    await page.waitForTimeout(500);
    expect(
      navigations(sent, "/action-stale/counted/next").map(
        (entry) => entry.stale,
      ),
    ).toEqual([true]);
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
      // (a) the stale prefetch, (c) then the write in place, (b) after one
      // stale revalidation and no request of the click's own.
      expect(await readTexts(other)).toEqual(["basket:0", "basket:1"]);
      expect(await sameElement(other)).toBe(true);
      await other.waitForTimeout(500);
      expect(
        navigations(sent, "/action-stale/basket").map((entry) => [
          entry.stale,
          entry.whole,
        ]),
      ).toEqual([[true, false]]);
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
