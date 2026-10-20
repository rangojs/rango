import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A navigation request sent before an in-flight server action lands is stale:
 * it reaches every loader's revalidate() with `stale: true` (the `_rsc_stale`
 * param); one sent after the action landed is not. A layout
 * cart count whose loader returns `stale || defaultShouldRevalidate` shows the
 * action's write with no further navigation. Fixture: action-stale.tsx in each
 * app (a 300 ms cart loader, a product page that answers at once, a second
 * page that answers after 300-500 ms, actions that answer after 0-800 ms
 * before their revalidation); both apps call this from a dev and a
 * (production) describe.
 */

export interface ActionStaleNavigationScenarioOptions {
  url: (pathname: string) => string;
  /** Load every module the cases use once per worker (a dev server). */
  warmUp: boolean;
}

// A state useNavigation() showed, and whether the slow page was on screen.
interface NavigationValue {
  state: string;
  slow: boolean;
}

interface PartialRequest {
  path: string;
  stale: boolean;
  prefetch: boolean;
  at: number;
  finished: boolean;
}

// The fixture's partial requests from now on, in the order they were sent.
function recordPartials(page: Page): PartialRequest[] {
  const sent: PartialRequest[] = [];
  const entries = new Map<Request, PartialRequest>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      !url.searchParams.has("_rsc_partial") ||
      !url.pathname.includes("/action-stale/")
    ) {
      return;
    }
    const entry: PartialRequest = {
      path: url.pathname.slice(url.pathname.indexOf("/action-stale/")),
      stale: url.searchParams.get("_rsc_stale") === "true",
      prefetch: request.headers()["x-rango-prefetch"] === "1",
      at: Date.now(),
      finished: false,
    };
    sent.push(entry);
    entries.set(request, entry);
  });
  page.on("requestfinished", (request) => {
    const entry = entries.get(request);
    if (entry) entry.finished = true;
  });
  return sent;
}

function navigations(sent: PartialRequest[], path: string): PartialRequest[] {
  return sent.filter((entry) => entry.path === path && !entry.prefetch);
}

async function prefetched(sent: PartialRequest[], path: string): Promise<void> {
  await expect
    .poll(() =>
      sent.some(
        (entry) => entry.prefetch && entry.finished && entry.path === path,
      ),
    )
    .toBe(true);
}

async function useKey(
  page: Page,
  options: ActionStaleNavigationScenarioOptions,
  key: string,
): Promise<void> {
  await page
    .context()
    .addCookies([{ name: "as-key", value: key, url: options.url("/") }]);
}

// The fixture sets <html data-as-pending> while an action is in flight.
async function isPending(page: Page): Promise<boolean> {
  return (await page.locator("html").getAttribute("data-as-pending")) !== null;
}

// Resolves on the frame the element appears, not at expect()'s next poll: a
// check made right after it is still inside the action's flight.
async function waitForShown(page: Page, testId: string): Promise<void> {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`) !== null,
    testId,
    { polling: "raf" },
  );
}

async function waitForSettled(page: Page): Promise<void> {
  await expect(page.locator("html")).not.toHaveAttribute("data-as-pending");
}

// Resolves on the frame the action settles, like waitForShown.
async function waitForSettledNow(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.documentElement.hasAttribute("data-as-pending"),
    null,
    { polling: "raf" },
  );
}

// The product page under a fresh key (cart 0), and the partial requests made
// from its load on.
async function openProductPage(
  page: Page,
  options: ActionStaleNavigationScenarioOptions,
  search = "",
): Promise<PartialRequest[]> {
  await useKey(page, options, randomUUID());
  const sent = recordPartials(page);
  await page.goto(options.url(`/action-stale/pdp${search}`));
  await waitForShellHydration(page);
  await expect(page.getByTestId("as-cart")).toHaveText("cart:0");
  return sent;
}

export function runActionStaleNavigationTests(
  options: ActionStaleNavigationScenarioOptions,
): void {
  // The pages, the action and the second page's client chunks, under a
  // throwaway key, so a dev server answers on time.
  test.beforeAll(async ({ browser }) => {
    if (!options.warmUp) return;
    test.setTimeout(60000);
    const page = await browser.newPage();
    try {
      await openProductPage(page, options);
      await page.getByTestId("as-add-first").click();
      await waitForSettled(page);
      await page.getByTestId("as-to-other").click();
      await expect(page.getByTestId("as-other")).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test("a link clicked while an action is in flight shows its write in the held layout", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);

    // The action writes at once and answers 500 ms later; the page answers
    // after 300 ms.
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-other").click();
    await expect(page.getByTestId("as-other")).toBeVisible();
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    const [navigation] = navigations(sent, "/action-stale/other");
    expect(navigation?.stale, "the navigation is stale").toBe(true);
  });

  test("a link clicked while an action is in flight shows its write when the page answers after the action", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options);

    // The action writes at once and commits on the product page once its
    // revalidation reran the 300 ms cart loader, before the second page
    // answers (500 ms).
    await page.getByTestId("as-add-fast").click();
    await page.getByTestId("as-to-other-slow").click();
    await expect(page.getByTestId("as-other")).toBeVisible();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
  });

  test("a prefetched link clicked while an action is in flight shows its page at once and the write after the action", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=render");
    await prefetched(sent, "/action-stale/other");
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-testid="as-other"]')) return;
        Object.assign(self, { __asOtherShownAt: Date.now() });
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-other-prefetched").click();
    await expect(page.getByTestId("as-other")).toBeVisible();
    const shownAt = await page.evaluate(
      () => (self as unknown as { __asOtherShownAt: number }).__asOtherShownAt,
    );
    expect(
      navigations(sent, "/action-stale/other").filter(
        (entry) => entry.at <= shownAt,
      ),
      "the click shows the prefetched page without a request of its own",
    ).toEqual([]);

    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
  });

  test("a prefetched link clicked once the action answered, while its revalidation renders, shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options, "?prefetch=render");
    await prefetched(sent, "/action-stale/other");

    // The action writes at once and answers at once; its commit waits for
    // the 300 ms cart loader of its revalidation. The prefetched click
    // commits inside that wait, so the action drops its commit, and the
    // bridge refetches the page on screen.
    const answered = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.has("_rsc_action"),
    );
    await page.getByTestId("as-add-fast").click();
    await answered;
    await page.getByTestId("as-to-other-prefetched").click();
    await waitForShown(page, "as-other");
    expect(await isPending(page), "the page commits before the action").toBe(
      true,
    );
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    const [refetch] = navigations(sent, "/action-stale/other");
    expect(refetch?.stale, "the refetch is stale").toBe(true);
  });

  test("a navigation answered before the action's write keeps held loaders, then shows the write once the action settles", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options);
    const plain = await page.getByTestId("as-plain").textContent();

    // The action writes 800 ms in, just before it answers; the page answers
    // after 300 ms.
    await page.getByTestId("as-add-last").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    expect(await isPending(page), "the page commits during the flight").toBe(
      true,
    );
    await expect(page.getByTestId("as-cart")).toHaveText("cart:0");
    expect(
      await page.getByTestId("as-plain").textContent(),
      "a held loader without revalidate() stays on its default",
    ).toBe(plain);

    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
  });

  test("a navigation after the action landed is not stale", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);

    await page.getByTestId("as-add-first").click();
    await waitForSettled(page);
    // The action's own revalidation on the page it ran on.
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
    const runs = Number(await page.getByTestId("as-cart-runs").textContent());

    await page.getByTestId("as-to-other").click();
    await expect(page.getByTestId("as-other")).toBeVisible();
    const [toOther] = navigations(sent, "/action-stale/other");
    expect(toOther?.stale, "the navigation is not stale").toBe(false);
    await expect(page.getByTestId("as-cart-runs")).toHaveText(String(runs));

    await page.getByTestId("as-to-pdp").click();
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    const [toProduct] = navigations(sent, "/action-stale/pdp");
    expect(toProduct?.stale, "the next navigation is not").toBe(false);
    await expect(page.getByTestId("as-cart-runs")).toHaveText(String(runs));
  });

  // dc-t114: the action's refetch of the page on screen never supersedes a
  // newer navigation still in flight; it refetches the page that one commits.
  test("a second navigation still in flight when the action answers commits with the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options);
    const sequence: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.includes("/action-stale/")) return;
      sequence.push(
        `${url.searchParams.has("_rsc_action") ? "action" : "partial"} ${url.pathname}`,
      );
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("/action-stale/")) {
        sequence.push(`failed ${url.pathname}`);
      }
    });
    // Every state useNavigation() shows from here on, and whether the slow
    // page was on screen when it did.
    await page.evaluate(() => {
      const read = () =>
        document.querySelector('[data-testid="as-navigation"]')?.textContent;
      const seen: NavigationValue[] = [];
      let last = read();
      new MutationObserver(() => {
        const state = read();
        if (state == null || state === last) return;
        last = state;
        seen.push({
          state,
          slow: !!document.querySelector('[data-testid="as-slow"]'),
        });
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      Object.assign(self, { __asNavigationSeen: seen });
    });

    // The action answers at 500 ms. The 300 ms page commits first; the
    // 900 ms page, clicked right after, is still in flight at 500 ms.
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    expect(await isPending(page), "the action is in flight").toBe(true);
    await page.getByTestId("as-to-slow").click();
    expect(await isPending(page), "the action is still in flight").toBe(true);

    await waitForSettled(page);
    test.info().annotations.push({
      type: "requests",
      description: sequence.join(" | "),
    });
    // The user's navigation stays the one useNavigation() reports until it
    // commits; the action's refetch after it is a background request.
    await expect(page.getByTestId("as-navigation")).toHaveText("idle", {
      timeout: 5000,
    });
    const seen = await page.evaluate(
      () =>
        (self as unknown as { __asNavigationSeen: NavigationValue[] })
          .__asNavigationSeen,
    );
    expect(
      seen.filter((entry) => entry.state === "idle" && !entry.slow),
      `idle before the slow page: ${JSON.stringify(seen)}`,
    ).toEqual([]);
    await expect(page.getByTestId("as-slow")).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/action-stale\/slow$/);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
  });

  // The navigation the action's refetch waits for is superseded by a newer
  // click: the wait moves to that click, and the page it commits gets the
  // refetch. The 300 ms page commits during the flight with the pre-write
  // cart; the 900 ms page is still out when the action settles.
  test("a third navigation that supersedes the one the refetch waits for shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);

    await page.getByTestId("as-add-last").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    expect(await isPending(page), "the action is in flight").toBe(true);
    await page.getByTestId("as-to-slow").click();
    await waitForSettledNow(page);
    await page.getByTestId("as-to-pdp").click();
    const [toSlow] = navigations(sent, "/action-stale/slow");
    expect(toSlow?.finished, "the slow page had not answered").toBe(false);

    await expect(page.getByTestId("as-pdp")).toBeVisible();
    await expect(page).toHaveURL(/\/action-stale\/pdp$/);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1", {
      timeout: 5000,
    });
    await expect(page.getByTestId("as-slow")).toHaveCount(0);
  });

  // dc-q78: a navigation whose server read came before the write commits
  // after the action landed; the action refetches the page it put on screen.
  test("a navigation read before a late write and committed after the action landed shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openProductPage(page, options);
    const carts: string[] = [];
    await page.exposeFunction("__asCart", (value: string) => carts.push(value));
    await page.evaluate(() => {
      let last: string | null | undefined;
      new MutationObserver(() => {
        const value = document.querySelector(
          '[data-testid="as-cart"]',
        )?.textContent;
        if (value == null || value === last) return;
        last = value;
        (self as unknown as { __asCart(value: string): void }).__asCart(value);
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });

    // The action writes 800 ms in and lands once its revalidation reran the
    // 300 ms cart loader. The read page reads the cart as its request
    // arrives and answers after 1800 ms.
    await page.getByTestId("as-add-last").click();
    await page.getByTestId("as-to-read").click();
    await waitForShown(page, "as-read");
    expect(
      await isPending(page),
      "the action landed before the page committed",
    ).toBe(false);
    test.info().annotations.push({
      type: "carts",
      description: carts.join(" -> "),
    });
    await expect(page.getByTestId("as-read")).toHaveText("read:1", {
      timeout: 5000,
    });
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");
  });

  // An action's navigated-away refetch that a newer click supersedes: the
  // page that click commits holds the layout from the page that missed the
  // write, and its request is not stale (the action has settled), so the
  // refetch runs again for it.
  test("a link clicked while the navigated-away refetch is in flight shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openProductPage(page, options);

    // The action writes 800 ms in, just before it answers; the page answers
    // after 300 ms, so it commits during the flight with cart:0. The
    // action's refetch of it answers after 300-600 ms more.
    await page.getByTestId("as-add-last").click();
    await page.getByTestId("as-to-other").click();
    await waitForShown(page, "as-other");
    await waitForSettledNow(page);
    await page.getByTestId("as-to-pdp").click();
    const [, refetch] = navigations(sent, "/action-stale/other");
    expect(refetch?.stale, "the action refetched the page it left").toBe(true);
    expect(refetch?.finished, "the refetch had not answered at the click").toBe(
      false,
    );
    await expect(page.getByTestId("as-pdp")).toBeVisible();
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1", {
      timeout: 5000,
    });
  });
}
