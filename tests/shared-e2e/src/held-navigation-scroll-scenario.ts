import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A navigation whose answer redraws nothing (every segment held, an empty
 * diff) commits with no tree, and applies the same scroll as one that
 * redraws: to the top for a new entry, to the hash target when there is one,
 * none with `scroll={false}`. No React commit follows it, so the scroll is
 * applied where it commits (browser/partial-update.ts), not in
 * NavigationProvider's layout effect.
 *
 * Fixture, in each app: /held-scroll (held-scroll.tsx), whose route never
 * revalidates, with a fixed nav (links to itself and to search variants, and
 * a button that runs an action) and a hash target 3000px down.
 * `held-scroll-render` changes only when the route renders, so each case also
 * shows that nothing redrew. Both apps call this from a dev and a
 * (production) describe.
 */

export interface HeldNavigationScrollScenarioOptions {
  url: (pathname: string) => string;
}

const readScrollY = (page: Page): Promise<number> =>
  page.evaluate(() => Math.round(window.scrollY));

/** The page, scrolled to 1200; returns its render marker. */
async function openScrolled(
  page: Page,
  options: HeldNavigationScrollScenarioOptions,
): Promise<string> {
  await page.goto(options.url("/held-scroll"));
  await waitForShellHydration(page);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect.poll(() => readScrollY(page)).toBe(1200);
  return (await page.getByTestId("held-scroll-render").textContent()) ?? "";
}

export function runHeldNavigationScrollTests(
  options: HeldNavigationScrollScenarioOptions,
): void {
  test("a link to the page on screen after an action ends at the top", async ({
    page,
  }) => {
    await openScrolled(page, options);
    // The count shows once the action settled and marked the entry stale, so
    // the link is answered by the server, not from the history cache.
    await page.getByTestId("held-scroll-action").click();
    await expect(page.getByTestId("held-scroll-actions")).toHaveText("1");
    const render = await page.getByTestId("held-scroll-render").textContent();
    expect(await readScrollY(page)).toBe(1200);

    await page.getByTestId("held-scroll-self").click();
    await expect.poll(() => readScrollY(page)).toBe(0);
    await expect(page.getByTestId("held-scroll-render")).toHaveText(render!);
  });

  test("a search-only change that holds every segment ends at the top", async ({
    page,
  }) => {
    const render = await openScrolled(page, options);

    await page.getByTestId("held-scroll-search").click();
    await expect(page).toHaveURL(options.url("/held-scroll?q=1"));
    await expect.poll(() => readScrollY(page)).toBe(0);
    await expect(page.getByTestId("held-scroll-render")).toHaveText(render);
  });

  test("a search-only change with scroll false keeps its position", async ({
    page,
  }) => {
    const render = await openScrolled(page, options);

    await page.getByTestId("held-scroll-keep").click();
    // The scroll decision is applied with the commit that moves the URL.
    await expect(page).toHaveURL(options.url("/held-scroll?q=2"));
    expect(await readScrollY(page)).toBe(1200);
    await expect(page.getByTestId("held-scroll-render")).toHaveText(render);
  });

  test("a search-only change with a hash scrolls to its target", async ({
    page,
  }) => {
    const render = await openScrolled(page, options);

    await page.getByTestId("held-scroll-hash").click();
    await expect(page).toHaveURL(
      options.url("/held-scroll?q=3#held-scroll-target"),
    );
    await expect
      .poll(() =>
        page
          .getByTestId("held-scroll-target")
          .evaluate((element) =>
            Math.round(element.getBoundingClientRect().top),
          ),
      )
      .toBe(0);
    await expect(page.getByTestId("held-scroll-render")).toHaveText(render);
  });
}
