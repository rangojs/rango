import { expect, test, type Page } from "@playwright/test";
import { guardHydrationErrors } from "./hydration-guard.js";
import {
  byTestId,
  isLoadMoreUrl,
  loadMoreItems,
  locationStateSlots,
  openLoadMorePageOne,
  openLoadMorePageTwo,
} from "./load-more-fixture.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * router.refresh() and the refresh another tab's server action triggers
 * re-render the entry on screen and keep its location state. Fixture: the
 * load-more page (LocationStateOptions.tsx and its action in each app); both
 * apps call this from a dev and a (production) describe.
 */

export interface RefreshLocationStateScenarioOptions {
  /** The load-more page's URL; read inside each test, once the server is up. */
  url: () => string;
}

/**
 * Numbers the load-more page's router.refresh() fetches from now on: each
 * sends `x-lm-stamp: <n>` (1, 2, ...), and the handler's stamp carries it as
 * `mark` (`lm-server-mark`), so the test sees which response the page took.
 * A refresh is the partial fetch that names no mounted segment
 * (`_rsc_segments=`); prefetches and an action's follow-up name theirs.
 */
async function numberLoadMoreRefreshes(page: Page): Promise<void> {
  let count = 0;
  await page.route(
    (url) =>
      isLoadMoreUrl(url) &&
      url.searchParams.has("_rsc_partial") &&
      url.searchParams.get("_rsc_segments") === "",
    (route) => {
      const request = route.request();
      if (request.method() !== "GET") return route.fallback();
      count += 1;
      return route.continue({
        headers: { ...request.headers(), "x-lm-stamp": String(count) },
      });
    },
  );
}

/** Clicks `lm-refresh` and waits for the page to show refresh number `n`. */
async function refreshLoadMore(page: Page, n: number): Promise<void> {
  await byTestId(page, "lm-refresh").click();
  await expect(byTestId(page, "lm-server-mark")).toHaveText(String(n));
}

/**
 * Holds the load-more page's server action POST at the network until
 * `release()`, so the action stays in flight while the test refreshes.
 * `arrived` resolves once the POST is held.
 */
async function holdLoadMoreAction(
  page: Page,
): Promise<{ arrived: Promise<void>; release: () => void }> {
  let release!: () => void;
  let arrive!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  await page.route(isLoadMoreUrl, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    arrive();
    await released;
    await route.continue();
  });
  return { arrived, release };
}

/**
 * Page 2 of the load-more fixture with the location state it was opened
 * with (openLoadMorePageTwo) on screen, `extra` slots on the entry, and the
 * handler's stamp of refresh number `mark`.
 */
async function expectPageTwoKept(
  page: Page,
  mark: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await expect(byTestId(page, "lm-page")).toHaveText("2");
  await expect(byTestId(page, "lm-carried-count")).toHaveText("3");
  await expect(byTestId(page, "lm-sort")).toHaveText("asc");
  await expect(byTestId(page, "lm-server-page")).toHaveText("2");
  await expect(byTestId(page, "lm-server-mark")).toHaveText(String(mark));
  await expect(byTestId(page, "lm-items").locator("li")).toHaveText([
    ...loadMoreItems(1),
    ...loadMoreItems(2),
  ]);
  expect(await locationStateSlots(page)).toEqual({
    "CarriedItems~r": loadMoreItems(1),
    "ServerPageStamp~r": { page: 2, mark },
    ListSort: { order: "asc" },
    ...extra,
  });
}

export function runRefreshLocationStateTests(
  options: RefreshLocationStateScenarioOptions,
): void {
  test("router.refresh() keeps the entry's location state and merges the handler's", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    await numberLoadMoreRefreshes(page);

    await refreshLoadMore(page, 1);
    await expectPageTwoKept(page, 1);

    // Back then Forward restores the kept entry.
    await page.goBack();
    await expect(page).toHaveURL(`${url}?page=1`);
    await expect(byTestId(page, "lm-page")).toHaveText("1");
    await expect(byTestId(page, "lm-carried-count")).toHaveText("0");

    await page.goForward();
    await expect(page).toHaveURL(`${url}?page=2`);
    await expectPageTwoKept(page, 1);
  });

  test("another tab's action refreshes this tab and keeps its location state", async ({
    page,
    context,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    await numberLoadMoreRefreshes(page);

    const otherTab = await context.newPage();
    await otherTab.goto(`${url}?page=1`);
    await waitForShellHydration(otherTab);
    await byTestId(otherTab, "lm-action").click();
    await expect(otherTab.locator("html")).toHaveAttribute(
      "data-lm-action",
      "done",
    );

    await expect(byTestId(page, "lm-server-mark")).toHaveText("1");
    await expectPageTwoKept(page, 1);
    await otherTab.close();
  });

  test("a flash already shown stays off the entry through refreshes, Back and a reload", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    const flash = byTestId(page, "lm-flash");
    const flashOnEntry = async (): Promise<boolean> =>
      "LoadMoreFlash" in (await locationStateSlots(page));

    await openLoadMorePageOne(page, url);
    await byTestId(page, "lm-more-flash").click();
    await expect(page).toHaveURL(`${url}?page=2`);
    await expect(flash).toHaveText("loaded");
    // The reader clears it from the entry after paint.
    await expect.poll(flashOnEntry).toBe(false);
    await numberLoadMoreRefreshes(page);

    await refreshLoadMore(page, 1);
    await expect(flash).toHaveText("loaded");
    await expect(byTestId(page, "lm-carried-count")).toHaveText("3");
    expect(await flashOnEntry()).toBe(false);

    await refreshLoadMore(page, 2);
    expect(await flashOnEntry()).toBe(false);
    await expect(byTestId(page, "lm-carried-count")).toHaveText("3");

    await byTestId(page, "lm-more").click();
    await expect(page).toHaveURL(`${url}?page=3`);
    await expect(byTestId(page, "lm-page")).toHaveText("3");
    await expect(flash).toHaveText("none");

    await page.goBack();
    await expect(page).toHaveURL(`${url}?page=2`);
    await expect(byTestId(page, "lm-page")).toHaveText("2");
    await expect(byTestId(page, "lm-carried-count")).toHaveText("3");
    await expect(flash).toHaveText("none");
    expect(await flashOnEntry()).toBe(false);

    await page.reload();
    await waitForShellHydration(page);
    // ListSort comes from history.state: once it shows, the client state is in.
    await expect(byTestId(page, "lm-sort")).toHaveText("asc");
    await expect(flash).toHaveText("none");
    expect(await flashOnEntry()).toBe(false);
  });

  test("a refresh after an action keeps the state the action set", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    await openLoadMorePageTwo(page, options.url());
    await byTestId(page, "lm-action").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-lm-action",
      "done",
    );
    await expect(byTestId(page, "lm-note")).toHaveText("from-action");
    await numberLoadMoreRefreshes(page);

    await refreshLoadMore(page, 1);
    await expect(byTestId(page, "lm-note")).toHaveText("from-action");
    await expectPageTwoKept(page, 1, {
      LoadMoreNote: { text: "from-action" },
    });
  });

  // The action then settles on an entry that moved on (its scroll key is
  // new): the state it set is dropped, as for an action whose user navigated
  // away.
  test("a refresh that commits during an action keeps the page's state", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    await openLoadMorePageTwo(page, options.url());
    await numberLoadMoreRefreshes(page);
    const action = await holdLoadMoreAction(page);

    await byTestId(page, "lm-action").click();
    await action.arrived;
    await refreshLoadMore(page, 1);
    await expect(page.locator("html")).not.toHaveAttribute("data-lm-action");
    await expectPageTwoKept(page, 1);

    action.release();
    await expect(page.locator("html")).toHaveAttribute(
      "data-lm-action",
      "done",
    );
    await expect(byTestId(page, "lm-note")).toHaveText("none");
    await expectPageTwoKept(page, 1);
  });
}
