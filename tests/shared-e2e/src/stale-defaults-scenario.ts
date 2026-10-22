import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  waitForShellHydration,
  warmShellRequestToHit,
} from "./shell-request.js";

/**
 * Back onto a page a server action made stale. A layout's loader reads a
 * cart count and declares no revalidate(); page A's handler reads the cart
 * too, and the layout counts its own renders. The action marks every history
 * entry stale, so Back to A restores A's cached entry and sends a stale
 * revalidation (`_rsc_stale`). That revalidation applies an action's
 * revalidation defaults: the route segment, the loaders and the route's
 * children re-render, the layout above the route does not. So A shows the
 * write in the layout's count and in its own handler, and the layout keeps
 * its render. Fixture: stale-defaults.tsx in each app, mounted at
 * /stale-defaults; both apps call this from a dev and a (production)
 * describe.
 */

export interface StaleDefaultsScenarioOptions {
  url: (pathname: string) => string;
}

const A = "/stale-defaults";

/** Page A under a fresh cart (cart 0). `query` is A's search. */
async function open(
  page: Page,
  url: (pathname: string) => string,
  query = "",
): Promise<void> {
  await page
    .context()
    .addCookies([{ name: "sd-key", value: randomUUID(), url: url("/") }]);
  await page.goto(url(`${A}${query}`));
  await waitForShellHydration(page);
  await expect(page.getByTestId("sd-a")).toBeVisible();
  await expect(page.getByTestId("sd-cart")).toHaveText("cart:0");
  await expect(page.getByTestId("sd-a-cart")).toHaveText("page:0");
  await expect(page.getByTestId("sd-layout-renders")).toHaveText("layout:1");
}

/** Adds through `button`; the call resolves with the count it wrote. */
async function add(page: Page, button: string): Promise<void> {
  await page.getByTestId(button).click();
  await expect(page.locator("html")).toHaveAttribute("data-sd-result", "1");
  // The action's own revalidation re-runs the layout's loader.
  await expect(page.getByTestId("sd-cart")).toHaveText("cart:1");
}

/** Back to `pathname`, through the stale revalidation it sends. */
async function backTo(page: Page, pathname: string): Promise<void> {
  const revalidated = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return (
      responseUrl.pathname.endsWith(pathname) &&
      responseUrl.searchParams.get("_rsc_stale") === "true"
    );
  });
  await page.goBack();
  await (await revalidated).finished();
}

async function backToA(
  page: Page,
  url: (pathname: string) => string,
): Promise<void> {
  await backTo(page, A);
  await expect(page).toHaveURL(url(A));
  await expect(page.getByTestId("sd-a")).toBeVisible();
}

/** A shows the write; the layout above the route did not render again. */
async function expectWriteOnA(page: Page): Promise<void> {
  await expect(page.getByTestId("sd-cart")).toHaveText("cart:1");
  await expect(page.getByTestId("sd-a-cart")).toHaveText("page:1");
  await expect(page.getByTestId("sd-layout-renders")).toHaveText("layout:1");
}

/**
 * A, then B under the same layout, an action on B, then Back to A: A shows
 * the write. Also semantic-matrix row R5.
 */
export async function expectBackOntoAStalePageShowsTheWrite(
  page: Page,
  url: (pathname: string) => string,
): Promise<void> {
  await open(page, url);
  await page.getByTestId("sd-to-b").click();
  await expect(page.getByTestId("sd-b")).toBeVisible();
  await add(page, "sd-add");
  await backToA(page, url);
  await expectWriteOnA(page);
}

export function runStaleDefaultsTests(
  options: StaleDefaultsScenarioOptions,
): void {
  test("Back to a page an action made stale shows the write in the layout's loader and the page's handler", async ({
    page,
  }) => {
    await expectBackOntoAStalePageShowsTheWrite(page, options.url);
  });

  test("Back out of an intercept after an action in it shows the write in the layout's loader and the page underneath", async ({
    page,
  }) => {
    await open(page, options.url);
    await page.getByTestId("sd-open-item").click();
    await expect(page.getByTestId("sd-intercept")).toBeVisible();
    await expect(page).toHaveURL(options.url(`${A}/item/1`));
    await expect(page.getByTestId("sd-a")).toBeVisible();

    // The action lands while the intercept is on screen.
    await add(page, "sd-intercept-add");
    await backToA(page, options.url);
    await expect(page.getByTestId("sd-intercept")).toHaveCount(0);

    // Back restores A's entry from before the write; its stale
    // revalidation brings the write back.
    await expectWriteOnA(page);
  });

  test("Back to a cache() page after an action on it keeps the write, not the record from before it", async ({
    page,
  }) => {
    const query = `?k=${randomUUID()}`;
    await open(page, options.url, query);
    // A navigation stores the page's record.
    await page.getByTestId("sd-to-cached").click();
    await expect(page.getByTestId("sd-cached-count")).toHaveText("cached:0");

    // The action renders the page live; it stores nothing.
    await add(page, "sd-cached-add");
    await expect(page.getByTestId("sd-cached-count")).toHaveText("cached:1");
    const shown = await page.getByTestId("sd-cached-render").textContent();

    await page.getByTestId("sd-to-b").click();
    await expect(page.getByTestId("sd-b")).toBeVisible();
    await backTo(page, `${A}/cached`);
    await expect(page).toHaveURL(options.url(`${A}/cached${query}`));

    // The stale revalidation re-sends the page: wait for it to commit.
    await expect(page.getByTestId("sd-cached-render")).not.toHaveText(
      shown ?? "",
    );
    await expect(page.getByTestId("sd-cached-count")).toHaveText("cached:1");
    await expect(page.getByTestId("sd-cart")).toHaveText("cart:1");
  });

  test("Back to a ppr page after an action on it keeps the write and bypasses the navigation replay", async ({
    page,
  }) => {
    const shelled = options.url(`${A}/shelled?k=${randomUUID()}`);
    await page
      .context()
      .addCookies([
        { name: "sd-key", value: randomUUID(), url: options.url("/") },
      ]);
    // The shell is captured, and served.
    await warmShellRequestToHit(page.request, shelled);
    await page.goto(shelled);
    await waitForShellHydration(page);
    await expect(page.getByTestId("sd-shelled-count")).toHaveText("shelled:0");

    // The action renders the page live.
    await page.getByTestId("sd-shelled-add").click();
    await expect(page.locator("html")).toHaveAttribute("data-sd-result", "1");
    await expect(page.getByTestId("sd-shelled-count")).toHaveText("shelled:1");
    const shown = await page.getByTestId("sd-shelled-render").textContent();

    await page.getByTestId("sd-shelled-to-b").click();
    await expect(page.getByTestId("sd-b")).toBeVisible();
    const revalidated = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith(`${A}/shelled`) &&
        url.searchParams.get("_rsc_stale") === "true"
      );
    });
    await page.goBack();
    const response = await revalidated;
    expect(response.headers()["x-rango-ppr-replay"]).toBe(
      "BYPASS; reason=stale",
    );
    await response.finished();
    await expect(page).toHaveURL(shelled);

    // The stale revalidation re-sends the page: wait for it to commit.
    await expect(page.getByTestId("sd-shelled-render")).not.toHaveText(
      shown ?? "",
    );
    await expect(page.getByTestId("sd-shelled-count")).toHaveText("shelled:1");
  });
}
