import { expect, test, type Page, type Response } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * Four partials nothing may reuse leave with `private, no-cache`, unless the
 * route sent `no-store`, which they keep: a hover prefetch scoped to its
 * source page, a hover prefetch that defers `prefetch: false` work, the fill
 * the click that adopts it sends, and the stale partial router.refresh()
 * sends. Fixture: not-reused-no-store* in each app, mounted at
 * "/not-reused-no-store": /private sends `private, no-store` from its
 * layout's middleware, /public sends nothing. Both apps call this from a dev
 * and a (production) describe.
 *
 * Headers only, read from the response event (waitForResponse). Chromium
 * reports a streamed `no-store` body as canceled though every byte arrived,
 * so `response.finished()` and `response.body()` never settle on the
 * /private responses: never wait on them here.
 */
export interface NotReusedNoStoreScenarioOptions {
  url: (pathname: string) => string;
}

const BASE = "/not-reused-no-store";

const AREAS = [
  { area: "private", cacheControl: "private, no-store" },
  { area: "public", cacheControl: "private, no-cache" },
] as const;

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForShellHydration(page);
}

/** The next partial response to `pathname` that `matches`. */
function nextPartial(
  page: Page,
  pathname: string,
  matches: (url: URL, response: Response) => boolean,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === pathname &&
      url.searchParams.has("_rsc_partial") &&
      matches(url, response)
    );
  });
}

const isPrefetch = (_url: URL, response: Response) =>
  response.request().headers()["x-rango-prefetch"] !== undefined;

export function runNotReusedNoStoreTests(
  options: NotReusedNoStoreScenarioOptions,
): void {
  for (const { area, cacheControl } of AREAS) {
    const at = (name: string) => `${BASE}/${area}/${name}`;

    test(`${area}: a prefetch scoped to its source page is sent ${cacheControl}`, async ({
      page,
    }) => {
      await open(page, options.url(at("a")));
      const prefetched = nextPartial(page, at("b"), isPrefetch);
      await page.getByTestId("nrns-to-b").hover();
      const response = await prefetched;
      expect(response.headers()["x-rsc-prefetch-scope"]).toBe("source");
      expect(response.headers()["cache-control"]).toBe(cacheControl);
    });

    test(`${area}: a deferring prefetch and the fill after it are sent ${cacheControl}`, async ({
      page,
    }) => {
      await open(page, options.url(at("a")));
      const prefetched = nextPartial(page, at("deferring"), isPrefetch);
      await page.getByTestId("nrns-to-deferring").hover();
      const prefetch = await prefetched;
      expect(prefetch.headers()["x-rsc-prefetch-scope"]).toBe("source");
      expect(prefetch.headers()["cache-control"]).toBe(cacheControl);

      const filled = nextPartial(page, at("deferring"), (url) =>
        url.searchParams.has("_rsc_fill"),
      );
      await page.getByTestId("nrns-to-deferring").click();
      const fill = await filled;
      expect(fill.headers()["cache-control"]).toBe(cacheControl);
      await expect(page.getByTestId("nrns-page")).toHaveText(
        `${area}:deferring`,
      );
    });

    test(`${area}: a stale partial is sent ${cacheControl}`, async ({
      page,
    }) => {
      await open(page, options.url(at("a")));
      const refreshed = nextPartial(
        page,
        at("a"),
        (url) => url.searchParams.get("_rsc_stale") === "true",
      );
      await page.getByTestId("nrns-refresh").click();
      const response = await refreshed;
      expect(response.headers()["cache-control"]).toBe(cacheControl);
      await expect(page.getByTestId("nrns-page")).toHaveText(`${area}:a`);
    });
  }
}
