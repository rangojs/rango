import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  followUps,
  isPending,
  navigations,
  openProductPage,
  prefetched,
  readNavigationStates,
  recordNavigationStates,
  recordPartials,
  useKey,
  waitForSettled,
  waitForSettledNow,
  waitForShown,
  type PartialRequest,
} from "./action-stale-fixture.js";
import { expectConsole } from "./console-guard.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * The follow-up revalidation across the cases an action and a navigation can
 * race in (server-action-bridge.ts followUp): an action owes the page on
 * screen one whole, stale refetch when it did not land there, the last exit
 * of the batch runs it after the navigation the user started, and it runs
 * again for the page then on screen when a navigation leaves it before its
 * commit. Covered here: failed actions, keepClientCache(), a navigation that
 * fails, a held transition() navigation, a `prefetch: false` fill,
 * Back/Forward, intercepts, and the document cache, which never answers a
 * stale request (two cached pages, s-maxage=60, keyed per test by ?k).
 * Fixture: action-stale.tsx in each app (as-cart-default is a layout loader
 * with no revalidate() that reads the cart: only a whole refetch shows the
 * write there); both apps call this from a dev and a (production) describe.
 */

export interface ActionFollowUpScenarioOptions {
  url: (pathname: string) => string;
  /** Load every module the cases use once per worker (a dev server). */
  warmUp: boolean;
}

/** A whole, stale refetch of `path` (the follow-up's request shape). */
function isFollowUpOf(path: string): (request: Request) => boolean {
  return (request) => {
    const url = new URL(request.url());
    return (
      url.pathname.endsWith(path) &&
      url.searchParams.get("_rsc_stale") === "true" &&
      !url.searchParams.get("_rsc_segments") &&
      request.headers()["x-rango-prefetch"] !== "1"
    );
  };
}

async function back(page: Page): Promise<void> {
  await page.evaluate(() => window.history.back());
}

/** A router navigation through the link interceptor. */
async function routerNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((href) => {
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, url);
  await expect(page).toHaveURL(url);
}

const CACHED = "/action-stale/cached/";

/**
 * A fresh load of cached page a under `key`: a navigation from it lists the
 * segments a holds, which the document cache key includes.
 */
async function loadCachedPage(
  page: Page,
  options: ActionFollowUpScenarioOptions,
  key: string,
): Promise<void> {
  await page.goto(options.url(`${CACHED}a?k=${key}`));
  await waitForShellHydration(page);
  await expect(page.getByTestId("as-cached-a")).toBeVisible();
}

/**
 * The cached pages' requests: plain ones must reach the document cache (a
 * status), stale ones must not (null).
 */
async function expectStaleSkipsCache(sent: PartialRequest[]): Promise<void> {
  const cached = sent.filter(
    (entry) => entry.path.startsWith(CACHED) && !entry.prefetch,
  );
  await expect
    .poll(
      () => cached.find((entry) => !entry.stale)?.status,
      "a plain navigation reaches the cache",
    )
    .toEqual(expect.any(String));
  const stale = cached.filter((entry) => entry.stale);
  expect(stale.length, "a stale request was sent").toBeGreaterThan(0);
  await expect
    .poll(
      () => stale.every((entry) => entry.status === null),
      "no stale request reaches the cache",
    )
    .toBe(true);
}

/** One more entry than the router's history cache holds (20). */
const EVICTING_ENTRIES = 21;

export function runActionFollowUpTests(
  options: ActionFollowUpScenarioOptions,
): void {
  // The pages, the actions and their client chunks, under a throwaway key,
  // so a dev server answers on time.
  test.beforeAll(async ({ browser }) => {
    if (!options.warmUp) return;
    test.setTimeout(90000);
    const page = await browser.newPage();
    try {
      await openProductPage(page, options, "?prefetch=fill");
      await page.getByTestId("as-to-fill-prefetched").click();
      await expect(page.getByTestId("as-fill")).toBeVisible();
      await back(page);
      await expect(page.getByTestId("as-pdp")).toBeVisible();
      await page.getByTestId("as-to-item").click();
      await expect(page.getByTestId("as-modal")).toBeVisible();
      await page.getByTestId("as-add-first").click();
      await waitForSettled(page);
      await back(page);
      await expect(page.getByTestId("as-modal")).toHaveCount(0);
      await page.getByTestId("as-to-transition").click();
      await expect(page.getByTestId("as-transition")).toBeVisible();
      await routerNavigate(page, options.url("/action-stale/other"));
      await expect(page.getByTestId("as-other")).toBeVisible();
      // A failed action whose page stays on screen is not a case here:
      // leave it, as the cases do.
      await page.getByTestId("as-fail").click();
      await page.getByTestId("as-to-slow").click();
      await expect(page.getByTestId("as-slow")).toBeVisible();
      await waitForSettled(page);
      await loadCachedPage(page, options, randomUUID());
      await page.getByTestId("as-to-cached-b").click();
      await expect(page.getByTestId("as-cached-b")).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test("a failed action the user navigated away from shows the page's data once it settles", async ({
    page,
  }) => {
    test.setTimeout(60000);
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    const sent = await openProductPage(page, options);

    // The action writes at once and throws 500 ms later; the page answers
    // after 300 ms and commits during the flight.
    await page.getByTestId("as-fail").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    expect(await isPending(page), "the page commits during the flight").toBe(
      true,
    );

    await waitForSettled(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-as-result",
      "error",
    );
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    const [navigation, followUp] = navigations(sent, "/action-stale/other");
    expect(navigation?.stale, "the navigation is a normal request").toBe(false);
    expect(followUp?.whole, "the follow-up refetches the page whole").toBe(
      true,
    );
  });

  test("a keepClientCache() action that fails after the user navigated away runs no follow-up", async ({
    page,
  }) => {
    test.setTimeout(60000);
    expectConsole(page, { allow: [/\[Browser\] Action failed/] });
    const sent = await openProductPage(page, options);

    await page.getByTestId("as-fail-keep").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    await waitForSettled(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-as-result",
      "error",
    );
    await expect(page.getByTestId("as-cart")).toHaveText("cart:0");

    // A follow-up would be sent at the action's exit, before this click.
    await page.getByTestId("as-to-pdp").click();
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    expect(followUps(sent), "no follow-up").toEqual([]);
  });

  test("a navigation that fails while the follow-up waits for it keeps its error on screen", async ({
    page,
  }) => {
    test.setTimeout(60000);
    expectConsole(page, {
      allow: [
        /\[Browser\] Unprocessable navigation response/,
        /\[RootErrorBoundary\] Unhandled error caught: Error: Connection closed/,
      ],
    });
    const sent = await openProductPage(page, options);
    // The slow page answers 1200 ms after its request with a body no client
    // can decode.
    await page.route(
      (url) =>
        url.pathname.endsWith("/action-stale/slow") &&
        url.searchParams.has("_rsc_partial"),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route
          .fulfill({
            status: 200,
            contentType: "text/x-component",
            body: "not-a-valid-flight-payload-@#$%^&*",
          })
          .catch(() => {});
      },
    );

    // The action writes at once and lands about 800 ms in. The other page
    // commits during the flight; the slow page, clicked right after, is
    // still out when the action lands.
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    expect(await isPending(page), "the action is in flight").toBe(true);
    await page.getByTestId("as-to-slow").click();
    await waitForSettled(page);

    await expect(page.getByText("Internal Server Error")).toBeVisible({
      timeout: 5000,
    });
    // A follow-up would start as the navigation fails: give its request
    // time to show.
    await page.waitForTimeout(500);
    await expect(page.getByText("Internal Server Error")).toBeVisible();
    expect(followUps(sent), "no follow-up replaces the error").toEqual([]);
  });

  test("an action that lands while a transition() navigation is held shows its write once the follow-up lands", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);

    // The action writes at once and lands about 800 ms in, on the product
    // page; the transition() page answers after 1200 ms with the layout the
    // click copied, from before the land.
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-transition").click();
    await waitForSettledNow(page);
    expect(
      await page.getByTestId("as-transition").count(),
      "the navigation is held at the land",
    ).toBe(0);

    await expect(page.getByTestId("as-transition")).toBeVisible();
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    const [navigation, followUp] = navigations(
      sent,
      "/action-stale/transition",
    );
    expect(navigation?.stale, "the navigation is a normal request").toBe(false);
    expect(followUp?.whole && followUp.stale, "the follow-up after it").toBe(
      true,
    );
  });

  test("a prefetch: false click while an action lands keeps its fill, then shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=fill");

    // The action writes at once and lands about 800 ms in. The fill page's
    // prefetch leaves on hover, after the action started (its start cancels
    // the prefetches in flight); the click right after waits for it (its
    // handler answers in 1500 ms), commits from it and fills the
    // `prefetch: false` loader.
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-fill-prefetched").hover();
    await expect
      .poll(() =>
        sent.some(
          (entry) => entry.prefetch && entry.path === "/action-stale/fill",
        ),
      )
      .toBe(true);
    await page.getByTestId("as-to-fill-prefetched").click();
    await waitForSettledNow(page);
    expect(
      await page.getByTestId("as-fill-page").count(),
      "the click is in flight at the land",
    ).toBe(0);

    await expect(page.getByTestId("as-fill")).toHaveText("fill:1");
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    const fill = sent.find(
      (entry) => entry.fill && entry.path === "/action-stale/fill",
    );
    expect(fill?.failed, "the fill answered, not cancelled").toBe(false);
    const [followUp] = followUps(sent).filter(
      (entry) => entry.path === "/action-stale/fill",
    );
    expect(followUp?.at, "the follow-up starts after the fill").toBeGreaterThan(
      fill!.at,
    );
  });

  test("a prefetch: false click that commits before an action lands keeps its fill, then shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(
      page,
      options,
      "?prefetch=fill&fillDelay=2000",
    );

    // The fill page's prefetch answers before the action starts (its start
    // cancels the prefetches in flight). The click right after the action
    // commits from it at once; its fill answers 2000 ms later, after the
    // action lands (about 800 ms in), and the follow-up waits for it.
    await page.getByTestId("as-to-fill-prefetched").hover();
    await prefetched(sent, "/action-stale/fill");
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-fill-prefetched").click();
    await waitForShown(page, "as-fill-page");
    expect(
      await isPending(page),
      "the click commits before the action lands",
    ).toBe(true);

    await expect(page.getByTestId("as-fill")).toHaveText("fill:1");
    expect(
      followUps(sent).some((entry) => entry.finished),
      "the fill's own answer shows, not the follow-up's",
    ).toBe(false);
    const fill = sent.find(
      (entry) => entry.fill && entry.path === "/action-stale/fill",
    );
    expect(fill?.failed, "the fill answered, not cancelled").toBe(false);

    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    const [followUp] = followUps(sent).filter(
      (entry) => entry.path === "/action-stale/fill",
    );
    expect(fill?.finished, "the fill's response ended").toBe(true);
    expect(
      followUp?.at,
      "the follow-up starts once the fill ended",
    ).toBeGreaterThanOrEqual(fill!.finishedAt!);
  });

  test("Back during an action's flight shows the write on the restored page", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);
    await page.getByTestId("as-to-other").click();
    await expect(page.getByTestId("as-other")).toBeVisible();

    // The action writes 800 ms in, just before it answers. Back restores
    // the product page from the history cache at once.
    await page.getByTestId("as-add-last").click();
    await back(page);
    await waitForShown(page, "as-pdp");
    expect(await isPending(page), "the restored page shows in the flight").toBe(
      true,
    );

    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    expect(
      followUps(sent).map((entry) => entry.path),
      "the follow-up refetches the restored page",
    ).toContain("/action-stale/pdp");
  });

  test("Back with a cache miss during an action's flight shows the page, then the write", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const sent = await openProductPage(page, options);
    // The entry Back returns to answers after 1500 ms; enough entries after
    // it evict it from the history cache.
    await routerNavigate(page, options.url("/action-stale/other?delay=1500"));
    await expect(page.getByTestId("as-other")).toBeVisible();
    for (let n = 1; n <= EVICTING_ENTRIES; n++) {
      await routerNavigate(page, options.url(`/action-stale/pdp?n=${n}`));
    }
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    await recordNavigationStates(page, "as-other");

    // The action writes at once and lands about 800 ms in, while the
    // traversal's own request is still out.
    await page.getByTestId("as-add-first").click();
    await page.evaluate((delta) => window.history.go(-delta), EVICTING_ENTRIES);
    await waitForSettled(page);
    expect(
      await page.getByTestId("as-other").count(),
      "the traversal is in flight at the land",
    ).toBe(0);

    await expect(page.getByTestId("as-other")).toBeVisible();
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    await expect(page.getByTestId("as-navigation")).toHaveText("idle");
    const seen = await readNavigationStates(page);
    expect(
      seen.filter((entry) => entry.state === "idle" && !entry.shown),
      `idle before the restored page: ${JSON.stringify(seen)}`,
    ).toEqual([]);
    const [traversal, followUp] = navigations(
      sent,
      "/action-stale/other",
    ).slice(1);
    expect(traversal?.stale, "the traversal is a normal request").toBe(false);
    expect(followUp?.whole && followUp.stale, "the follow-up after it").toBe(
      true,
    );
  });

  test("Back while the follow-up is in flight shows the write on the restored page", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);
    const followUpSent = page.waitForRequest(
      isFollowUpOf("/action-stale/other"),
      { timeout: 10000 },
    );

    // The action writes 800 ms in; the other page answers after 300 ms and
    // commits during the flight. Its follow-up re-runs the 300 ms cart
    // loader: Back as soon as its request is out.
    await page.getByTestId("as-add-last").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    await followUpSent;
    await back(page);
    const [refetch] = followUps(sent);
    expect(
      refetch?.finished,
      "the follow-up had not answered at the Back",
    ).toBe(false);

    await waitForShown(page, "as-pdp");
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    expect(
      followUps(sent).map((entry) => entry.path),
      "it runs again for the restored page",
    ).toContain("/action-stale/pdp");
  });

  test("an action whose intercept opened during its flight runs no follow-up, and Back revalidates the page underneath", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);

    // The action writes 800 ms in; the intercept answers after 100 ms.
    await page.getByTestId("as-add-last").click();
    await page.getByTestId("as-to-item").click();
    await waitForShown(page, "as-modal");
    expect(await isPending(page), "the intercept opens during the flight").toBe(
      true,
    );

    await waitForSettled(page);
    await expect(page.getByTestId("as-item")).toHaveText("item:0");
    await expect(page.getByTestId("as-cart")).toHaveText("cart:0");
    await expect(page.getByTestId("as-pdp")).toBeVisible();

    // Closing the intercept restores the entry the action marked stale: its
    // revalidation re-runs the cart loader, which revalidates when stale.
    await back(page);
    await expect(page.getByTestId("as-modal")).toHaveCount(0);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    expect(
      followUps(sent).map((entry) => entry.path),
      "no follow-up while the intercept is on screen",
    ).toEqual([]);
  });

  test("Back out of an intercept while its action is in flight shows the action's result and the write on the page underneath", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);
    await page.getByTestId("as-to-item").click();
    await expect(page.getByTestId("as-modal")).toBeVisible();

    // The action, sent from the intercept, writes 800 ms in, just before it
    // answers. Back closes the intercept during its flight.
    await page.getByTestId("as-add-last").click();
    await back(page);
    await expect(page.getByTestId("as-modal")).toHaveCount(0);
    expect(
      await isPending(page),
      "the intercept closed during the flight",
    ).toBe(true);

    await waitForSettled(page);
    await expect(page.locator("html")).toHaveAttribute("data-as-result", "1");
    await expect(page.getByTestId("as-action-result")).toHaveText("1");
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    expect(
      followUps(sent).map((entry) => entry.path),
      "the follow-up refetches the page underneath",
    ).toEqual(["/action-stale/pdp"]);
  });

  test("the follow-up after an action is not answered from the document cache", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const key = randomUUID();
    await useKey(page, options, key);
    const sent = recordPartials(page);
    await loadCachedPage(page, options, key);

    // Two cycles from a: the action writes at once and answers 500 ms later,
    // and b is clicked inside its flight. Both follow-ups to b hold no
    // segments, so a stored first one would answer the second with cart:1.
    for (const cart of [1, 2]) {
      await page.getByTestId("as-add-first").click();
      await page.getByTestId("as-to-cached-b").click();
      await waitForShown(page, "as-cached-b");
      expect(await isPending(page), "b commits during the flight").toBe(true);
      await waitForSettled(page);
      await expect(page.getByTestId("as-cart")).toHaveText(`cart:${cart}`);
      if (cart === 1) {
        await page.getByTestId("as-to-cached-a").click();
        await expect(page.getByTestId("as-cached-a")).toBeVisible();
      }
    }

    expect(
      followUps(sent).map((entry) => entry.path),
      "one follow-up per cycle",
    ).toEqual([`${CACHED}b`, `${CACHED}b`]);
    await expectStaleSkipsCache(sent);
  });

  test("a Back revalidation after an action is not answered from the document cache", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const key = randomUUID();
    await useKey(page, options, key);
    const sent = recordPartials(page);
    await loadCachedPage(page, options, key);

    // b to a, plain, stores the response Back's revalidation of a repeats: the
    // same page, the same segments held.
    await page.getByTestId("as-to-cached-b").click();
    await expect(page.getByTestId("as-cached-b")).toBeVisible();
    await page.getByTestId("as-to-cached-a").click();
    await expect(page.getByTestId("as-cached-a")).toBeVisible();
    await page.getByTestId("as-to-cached-b").click();
    await expect(page.getByTestId("as-cached-b")).toBeVisible();
    // The action lands on b, where the user stayed: no follow-up.
    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    // a's entry is stale: Back shows it and revalidates it in the background.
    await back(page);
    await expect(page.getByTestId("as-cached-a")).toBeVisible();
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    expect(followUps(sent), "no follow-up").toEqual([]);
    await expectStaleSkipsCache(sent);
  });
}
