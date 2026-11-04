import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A prefetch made from inside an open intercept.
 *
 * The modal's link to the next item is prefetched on hover while the
 * intercept is open. That prefetch names the page under the intercept in
 * `X-RSC-Router-Intercept-Source` and is stored under keys partitioned by it
 * (browser/prefetch/fetch.ts, browser/prefetch/cache.ts prefetchKeyPrefix), so
 * the click that follows adopts it: one request for the target, and the item
 * opens in the intercept over the same page.
 *
 * A prefetch is answered against the page under the intercept, so the two
 * sides never share one: a prefetch of the same target made outside an
 * intercept is not adopted inside one, and one made inside is not adopted
 * outside.
 *
 * Fixture: intercept-held* in each app (the /handler intercept links to the
 * next handler item with `prefetch="hover"` and to the index with none; the
 * index links to /handler/2 with `prefetch="hover"`). Both apps call this
 * from a dev and a (production) describe.
 */

export interface InterceptPrefetchInsideScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the fixture's index page (the layout's "/" route). */
  basePath: string;
}

/** One partial request the page made: what the server was told. */
interface PartialRequest {
  pathname: string;
  /** `X-RSC-Router-Client-Path`: the page the request claims to be on. */
  clientPath: string | undefined;
  /** `X-RSC-Router-Intercept-Source`: the page under an open intercept. */
  interceptSource: string | undefined;
  /** `X-Rango-Prefetch`: set on a prefetch, absent on a click's own request. */
  prefetch: string | undefined;
}

/** Every partial request the page makes from now on, in order. */
function recordPartials(page: Page): PartialRequest[] {
  const seen: PartialRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc_partial")) return;
    const headers = request.headers();
    seen.push({
      pathname: url.pathname,
      clientPath: headers["x-rsc-router-client-path"],
      interceptSource: headers["x-rsc-router-intercept-source"],
      prefetch: headers["x-rango-prefetch"],
    });
  });
  return seen;
}

/**
 * The path a header naming a page points at. The prefetch sends the source
 * absolute and a click sends the store's value, which may be a path: both
 * name the same page.
 */
function pathOf(header: string): string {
  return new URL(header, "http://localhost").pathname;
}

/** Hovers `testId` and resolves with the prefetch response it started. */
async function hoverPrefetch(page: Page, testId: string, pathname: string) {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return (
      url.pathname === pathname &&
      url.searchParams.has("_rsc_partial") &&
      candidate.request().headers()["x-rango-prefetch"] !== undefined
    );
  });
  await page.getByTestId(testId).hover();
  const prefetched = await response;
  await prefetched.finished();
  return prefetched;
}

export function runInterceptPrefetchInsideTests(
  options: InterceptPrefetchInsideScenarioOptions,
): void {
  const handlerPath = (id: number) => `${options.basePath}/handler/${id}`;

  async function openIndex(page: Page): Promise<void> {
    await page.goto(options.url(options.basePath));
    await waitForShellHydration(page);
    await expect(page.getByTestId("ih-index")).toBeVisible();
  }

  /** The index, then the /handler/1 intercept over it. */
  async function openIntercept(page: Page): Promise<void> {
    await openIndex(page);
    await page.getByTestId("ih-open-handler").click();
    await expect(page.getByTestId("ih-handler-modal")).toBeVisible();
    await expect(page.getByTestId("ih-handler-modal-id")).toHaveText("1");
    await expect(page.getByTestId("ih-index")).toBeVisible();
  }

  test("a link inside the intercept adopts the prefetch it made: the next item opens in the intercept, in one request", async ({
    page,
  }) => {
    await openIntercept(page);
    // The source page is the index, as the browser names it; the client path
    // stays the intercept's own URL, as for the click.
    const source = new URL(options.url(options.basePath)).href;
    const interceptUrl = new URL(options.url(handlerPath(1))).href;
    const requests = recordPartials(page);

    const prefetched = await hoverPrefetch(
      page,
      "ih-handler-intercept-next-pf",
      handlerPath(2),
    );

    expect(prefetched.headers()["x-rsc-prefetch-scope"]).toBe("source");
    const prefetchRequest = requests.find(
      (request) => request.pathname === handlerPath(2),
    );
    expect(prefetchRequest, "the prefetch went out").toBeDefined();
    expect(prefetchRequest!.prefetch).toBe("intent");
    expect(prefetchRequest!.interceptSource).toBe(source);
    expect(prefetchRequest!.clientPath).toBe(interceptUrl);

    await page.getByTestId("ih-handler-intercept-next-pf").click();

    await expect(page.getByTestId("ih-handler-modal-id")).toHaveText("2");
    await expect(page.getByTestId("ih-index")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${options.basePath}/handler/2$`));
    // Adopted: the click fetched nothing of its own.
    expect(
      requests.filter((request) => request.pathname === handlerPath(2)),
      "one request for the target, the prefetch",
    ).toHaveLength(1);
  });

  test("a prefetch made outside an intercept is not adopted inside one", async ({
    page,
  }) => {
    await openIndex(page);
    // /handler/2 prefetched from the index with no intercept open: the answer
    // is the modal over the index, computed for a click that has no ids of an
    // open intercept to hold.
    const outside = await hoverPrefetch(
      page,
      "ih-open-handler-pf",
      handlerPath(2),
    );
    expect(
      outside.request().headers()["x-rsc-router-intercept-source"],
    ).toBeUndefined();

    const requests = recordPartials(page);
    await page.getByTestId("ih-open-handler").click();
    await expect(page.getByTestId("ih-handler-modal-id")).toHaveText("1");
    // No prefetch: this link has `prefetch="none"`, so the click fetches.
    await page.getByTestId("ih-handler-intercept-next").click();

    await expect(page.getByTestId("ih-handler-modal-id")).toHaveText("2");
    await expect(page.getByTestId("ih-index")).toBeVisible();
    const clickRequest = requests.find(
      (request) => request.pathname === handlerPath(2),
    );
    expect(clickRequest, "the click fetched instead of adopting").toBeDefined();
    expect(clickRequest!.prefetch).toBeUndefined();
    expect(pathOf(clickRequest!.interceptSource!)).toBe(options.basePath);
  });

  test("a prefetch made inside an intercept is not adopted outside one", async ({
    page,
  }) => {
    await openIntercept(page);
    const inside = await hoverPrefetch(
      page,
      "ih-handler-intercept-next-pf",
      handlerPath(2),
    );
    expect(inside.headers()["x-rsc-prefetch-scope"]).toBe("source");

    await page.getByTestId("ih-handler-intercept-to-index").click();
    await expect(page.getByTestId("ih-handler-modal")).toHaveCount(0);
    await expect(page.getByTestId("ih-index")).toBeVisible();

    const requests = recordPartials(page);
    const outside = await hoverPrefetch(
      page,
      "ih-open-handler-pf",
      handlerPath(2),
    );

    expect(
      outside.request().headers()["x-rsc-router-intercept-source"],
    ).toBeUndefined();
    const refetched = requests.filter(
      (request) => request.pathname === handlerPath(2),
    );
    expect(refetched, "the index prefetched the target again").toHaveLength(1);
    expect(refetched[0]!.interceptSource).toBeUndefined();
  });
}
