import { expect, test, type Page, type Request } from "@playwright/test";
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
 * Commits that re-render the entry on screen: router.refresh(), the refresh
 * another tab's server action triggers, an action's follow-up and Back's
 * background revalidation. Each keeps the entry's location state and adds
 * what the handler set. Fixture: the load-more page (LocationStateOptions.tsx
 * and its action in each app); both apps call this from a dev and a
 * (production) describe.
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
 * (`_rsc_segments=`), as an action's follow-up is; prefetches and
 * navigations name theirs.
 */
async function numberLoadMoreRefreshes(page: Page): Promise<void> {
  await numberLoadMoreRequests(page, isRefetchOfWholePage);
}

/** A partial fetch of the load-more page that names no mounted segment. */
const isRefetchOfWholePage = (url: URL): boolean =>
  isLoadMoreUrl(url) &&
  url.searchParams.has("_rsc_partial") &&
  url.searchParams.get("_rsc_segments") === "";

/**
 * Back's background revalidation of the load-more page: a stale request that
 * holds the page's segments (a prefetch is not stale, a refresh holds none).
 */
const isRevalidationOfHeldPage = (url: URL): boolean =>
  isLoadMoreUrl(url) &&
  url.searchParams.has("_rsc_stale") &&
  Boolean(url.searchParams.get("_rsc_segments"));

/**
 * Answers the first partial GET `matches` accepts with the fixture's
 * redirect to page 1 (`x-lm-redirect`), which carries the note
 * "redirected". The navigation that follows it is not redirected again.
 */
async function redirectFirstLoadMoreRequest(
  page: Page,
  matches: (url: URL) => boolean,
): Promise<void> {
  let redirected = false;
  await page.route(matches, (route) => {
    const request = route.request();
    if (request.method() !== "GET" || redirected) return route.fallback();
    redirected = true;
    return route.continue({
      headers: { ...request.headers(), "x-lm-redirect": "1" },
    });
  });
}

/** numberLoadMoreRefreshes for every partial GET `matches` accepts. */
async function numberLoadMoreRequests(
  page: Page,
  matches: (url: URL) => boolean,
): Promise<void> {
  let count = 0;
  await page.route(matches, (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    count += 1;
    return route.continue({
      headers: { ...request.headers(), "x-lm-stamp": String(count) },
    });
  });
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
  // away. That owes the page its follow-up, refresh number 2 here, and the
  // state the handler sets on it reaches the entry and the page.
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
    await expectPageTwoKept(page, 2);
  });

  test("a refresh answered with a redirect follows it in place of the entry", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    const historyLength = await page.evaluate(() => window.history.length);
    await redirectFirstLoadMoreRequest(page, isRefetchOfWholePage);

    await byTestId(page, "lm-refresh").click();
    await expect(page).toHaveURL(`${url}?page=1`);
    await expect(byTestId(page, "lm-page")).toHaveText("1");
    await expect(byTestId(page, "lm-note")).toHaveText("redirected");
    await expect(byTestId(page, "lm-carried-count")).toHaveText("0");
    await expect(byTestId(page, "lm-server-page")).toHaveText("1");
    expect(await page.evaluate(() => window.history.length)).toBe(
      historyLength,
    );

    // Back skips the entry that redirected: page 1 as it was first loaded.
    await page.goBack();
    await expect(page).toHaveURL(`${url}?page=1`);
    await expect(byTestId(page, "lm-note")).toHaveText("none");
    await expect(byTestId(page, "lm-items").locator("li")).toHaveText(
      loadMoreItems(1),
    );
  });

  test("a shallow navigation during a refresh supersedes it", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    // The refresh is held until release(), then answered as refresh 1.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held = page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        isRefetchOfWholePage(new URL(request.url())),
    );
    await page.route(isRefetchOfWholePage, async (route) => {
      const request = route.request();
      if (request.method() !== "GET") return route.fallback();
      await released;
      // Aborted by the page once superseded: nothing left to answer.
      await route
        .continue({ headers: { ...request.headers(), "x-lm-stamp": "1" } })
        .catch(() => {});
    });

    await byTestId(page, "lm-refresh").click();
    const refresh = await held;
    await byTestId(page, "lm-shallow").click();
    const compact = `${url}?page=2&view=compact`;
    await expect(page).toHaveURL(compact);
    await expect(byTestId(page, "lm-url")).toHaveText(
      `${new URL(compact).pathname}?page=2&view=compact`,
    );

    // The refresh's answer, if it still arrives, commits nothing.
    const ended = new Promise<void>((resolve) => {
      const done = (request: Request): void => {
        if (request === refresh) resolve();
      };
      page.on("requestfinished", done);
      page.on("requestfailed", done);
    });
    release();
    await ended;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve, 300)),
        ),
    );
    // The shallow entry's own state (it was pushed with none), not the
    // refreshed one's.
    await expect(page).toHaveURL(compact);
    await expect(byTestId(page, "lm-server-mark")).toHaveText("none");
    await expect(byTestId(page, "lm-carried-count")).toHaveText("0");
  });
}

/**
 * Back's background revalidation and an action's follow-up re-render the
 * page on screen: the state its handler sets reaches the entry and its
 * readers, and a redirect it answers with is followed, as on a refresh.
 */
export function runRevalidationLocationStateTests(
  options: RefreshLocationStateScenarioOptions,
): void {
  test("Back's revalidation of a stale entry brings the state its handler sets", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    // The action marks every history entry stale.
    await byTestId(page, "lm-action").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-lm-action",
      "done",
    );
    await numberLoadMoreRequests(page, isRevalidationOfHeldPage);

    await page.goBack();
    await expect(page).toHaveURL(`${url}?page=1`);
    await expect(byTestId(page, "lm-page")).toHaveText("1");
    await expect(byTestId(page, "lm-server-mark")).toHaveText("1");
    await expect(byTestId(page, "lm-server-page")).toHaveText("1");
    expect(await locationStateSlots(page)).toEqual({
      "ServerPageStamp~r": { page: 1, mark: 1 },
    });
  });

  test("Back's revalidation answered with a redirect follows it", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    await byTestId(page, "lm-action").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-lm-action",
      "done",
    );
    await redirectFirstLoadMoreRequest(page, isRevalidationOfHeldPage);

    await page.goBack();
    await expect(page).toHaveURL(`${url}?page=1`);
    await expect(byTestId(page, "lm-note")).toHaveText("redirected");
    await expect(byTestId(page, "lm-page")).toHaveText("1");
  });

  test("an action's follow-up answered with a redirect follows it", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const url = options.url();
    await openLoadMorePageTwo(page, url);
    const action = await holdLoadMoreAction(page);
    await byTestId(page, "lm-action").click();
    await action.arrived;
    // The action lands on page 3, so the page owes its follow-up.
    await byTestId(page, "lm-more").click();
    await expect(page).toHaveURL(`${url}?page=3`);
    await expect(byTestId(page, "lm-page")).toHaveText("3");
    await redirectFirstLoadMoreRequest(page, isRefetchOfWholePage);

    action.release();
    await expect(page.locator("html")).toHaveAttribute(
      "data-lm-action",
      "done",
    );
    await expect(page).toHaveURL(`${url}?page=1`);
    await expect(byTestId(page, "lm-note")).toHaveText("redirected");
    await expect(byTestId(page, "lm-page")).toHaveText("1");
  });
}
