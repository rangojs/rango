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
 * (production) describe. The document cache never answers a stale request
 * either: two cached pages (s-maxage=60, keyed per test by ?k) are navigated
 * with and without one.
 */

export interface ActionStaleNavigationScenarioOptions {
  url: (pathname: string) => string;
  /** Load every module the cases use once per worker (a dev server). */
  warmUp: boolean;
}

interface PartialRequest {
  path: string;
  stale: boolean;
  prefetch: boolean;
  at: number;
  finished: boolean;
  /** x-document-cache-status: undefined until answered, null when not consulted. */
  status?: string | null;
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
  page.on("response", (response) => {
    const entry = entries.get(response.request());
    if (entry) {
      entry.status = response.headers()["x-document-cache-status"] ?? null;
    }
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

const CACHED = "/action-stale/cached/";

// The navigations to the document-cached pages, split by staleness.
function cachedNavigations(sent: PartialRequest[]): {
  plain: PartialRequest[];
  stale: PartialRequest[];
} {
  const cached = sent.filter(
    (entry) => entry.path.startsWith(CACHED) && !entry.prefetch,
  );
  return {
    plain: cached.filter((entry) => !entry.stale),
    stale: cached.filter((entry) => entry.stale),
  };
}

// A fresh load of cached page a, whose held segments are what a navigation
// from it lists: the cache key includes them.
async function loadCachedPage(
  page: Page,
  options: ActionStaleNavigationScenarioOptions,
  key: string,
): Promise<void> {
  await page.goto(options.url(`${CACHED}a?k=${key}`));
  await waitForShellHydration(page);
  await expect(page.getByTestId("as-cached-a")).toBeVisible();
  await expect(page.getByTestId("as-cart")).toHaveText("cart:0");
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
      const key = randomUUID();
      await useKey(page, options, key);
      await loadCachedPage(page, options, key);
      await page.getByTestId("as-to-cached-b").click();
      await expect(page.getByTestId("as-cached-b")).toBeVisible();
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

  test("a navigation sent while an action is in flight is not answered from the document cache", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const key = randomUUID();
    await useKey(page, options, key);
    const sent = recordPartials(page);

    // A plain navigation from a freshly loaded a goes through the cache. The
    // stale request below repeats it from another fresh load.
    await loadCachedPage(page, options, key);
    await page.getByTestId("as-to-cached-b").click();
    await expect(page.getByTestId("as-cached-b")).toBeVisible();
    await loadCachedPage(page, options, key);

    // The action writes at once and answers 500 ms later: the link is
    // clicked inside its flight.
    await page.getByTestId("as-add-first").click();
    await page.getByTestId("as-to-cached-b").click();
    await waitForShown(page, "as-cached-b");
    const shown = await page.getByTestId("as-cart").textContent();
    expect(await isPending(page), "the page commits during the flight").toBe(
      true,
    );
    expect(shown, "the held layout shows the write at the commit").toBe(
      "cart:1",
    );
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    const { plain, stale } = cachedNavigations(sent);
    await expect.poll(() => plain[0]?.status).toEqual(expect.any(String));
    expect(stale.length, "a stale request was sent").toBeGreaterThan(0);
    await expect
      .poll(() => stale.every((entry) => entry.status === null))
      .toBe(true);
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
    await page.getByTestId("as-add-fast").click();
    await waitForSettled(page);
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    // a's entry is stale: Back shows it and revalidates it in the background.
    await page.goBack();
    await expect(page.getByTestId("as-cached-a")).toBeVisible();
    await expect(page.getByTestId("as-cart")).toHaveText("cart:1");

    const { plain, stale } = cachedNavigations(sent);
    await expect.poll(() => plain[0]?.status).toEqual(expect.any(String));
    expect(stale.length, "a stale request was sent").toBeGreaterThan(0);
    await expect
      .poll(() => stale.every((entry) => entry.status === null))
      .toBe(true);
  });
}
