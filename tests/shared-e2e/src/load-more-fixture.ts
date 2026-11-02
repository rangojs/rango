import { expect, type Locator, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

export function byTestId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

/**
 * The entry's typed location-state slots, keyed by `<ExportName><suffix>`: the
 * tail of the injected key (`__rsc_ls_<path or hash>#<ExportName>`) that is
 * the same in dev and in a build, plus the suffix the definition's
 * `clearOnReload` adds. Values are stored raw.
 */
export async function locationStateSlots(
  page: Page,
): Promise<Record<string, unknown>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries((window.history.state ?? {}) as Record<string, unknown>)
        .filter(([key]) => key.startsWith("__rsc_ls_"))
        .map(([key, value]) => [key.slice(key.lastIndexOf("#") + 1), value]),
    ),
  );
}

export const loadMoreItems = (pageNumber: number): string[] =>
  [1, 2, 3].map((item) => `p${pageNumber}-${item}`);

/** The load-more fixture's pages, whatever the app's prefix. */
export const isLoadMoreUrl = (url: URL): boolean =>
  url.pathname.endsWith("load-more");

/**
 * Loads page 1 of the load-more fixture (both apps: `<url>?page=N`, which
 * renders page N's three items on the server) once hydrated.
 */
export async function openLoadMorePageOne(
  page: Page,
  url: string,
): Promise<void> {
  await page.goto(`${url}?page=1`);
  await waitForShellHydration(page);
  await expect(byTestId(page, "lm-items").locator("li")).toHaveText(
    loadMoreItems(1),
  );
}

/**
 * Opening steps of the #994 "load more" bodies. The fixture's `lm-more`
 * Link goes to page N+1 carrying every item on screen as a `clearOnReload`
 * slot, plus a slot without options (`lm-sort`). The route's handler sets a
 * `clearOnReload` slot of its own on every request (`lm-server-page`),
 * document loads included, unless the request sends `x-lm-stamp: off`
 * (skipLoadMoreServerStamp).
 *
 * Loads page 1, then navigates to page 2 on the client. Leaves the page on an
 * entry holding all three slots.
 */
export async function openLoadMorePageTwo(
  page: Page,
  url: string,
): Promise<void> {
  const items = byTestId(page, "lm-items").locator("li");

  // The document carries what the handler set for this load (#1330): start-up
  // writes it after the clearOnReload pass, so this load keeps it.
  await openLoadMorePageOne(page, url);
  await expect(byTestId(page, "lm-server-page")).toHaveText("1");
  expect(await locationStateSlots(page)).toEqual({
    "ServerPageStamp~r": { page: 1 },
  });

  // A client navigation shows the carried items above the new page's, and
  // delivers the state the handler set for it.
  await byTestId(page, "lm-more").click();
  await expect(page).toHaveURL(`${url}?page=2`);
  await expect(items).toHaveText([...loadMoreItems(1), ...loadMoreItems(2)]);
  await expect(byTestId(page, "lm-server-page")).toHaveText("2");
  expect(await locationStateSlots(page)).toEqual({
    "CarriedItems~r": loadMoreItems(1),
    "ServerPageStamp~r": { page: 2 },
    ListSort: { order: "asc" },
  });
}
