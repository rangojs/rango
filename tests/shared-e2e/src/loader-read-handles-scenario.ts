import { expect, test, type Page } from "@playwright/test";

/**
 * A loader read on its own (a `useRefreshLoaders()` group refresh, or the
 * reader's `load()`) applies the handle values the loader's body pushed, as
 * a render does: the document's title and the breadcrumb trail show the new
 * values, in the place the loader's earlier ones had. This is how an app keeps
 * a live part current: a rename that reaches the page through a refresh
 * reaches the tab title too.
 *
 * Fixture in each app, under `base`: a layout that pushes a "Chats" crumb and
 * renders the fixture's crumbs (lrh-crumb) and the Meta title (lrh-title)
 * from useHandle, over `${base}/chat`, which registers a fetchable loader
 * that names the chat by its run (`Chat <n>`) and pushes the title
 * `LRH Chat <n>` and the crumb `Chat <n>`. A reader of the loader in a
 * refresh group shows its name (lrh-name), with a group refresh button
 * (lrh-refresh) and a load() button (lrh-load).
 */

export interface LoaderReadHandlesScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  /** Path prefix of the fixture's pages, e.g. "/loader-read-handles". */
  base: string;
}

const NAME = /^Chat \d+$/;

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reader's name once it shows one other than `previous`. */
async function nameAfter(page: Page, previous: string | null): Promise<string> {
  const handle = await page.waitForFunction(
    ([pattern, prev]) => {
      const text =
        document.querySelector('[data-testid="lrh-name"]')?.textContent ?? "";
      return new RegExp(pattern!).test(text) && text !== prev ? text : null;
    },
    [NAME.source, previous] as const,
  );
  return (await handle.jsonValue()) as string;
}

/** The page shows `name`'s title and crumb, after the layout's crumb. */
async function expectHandlesOf(page: Page, name: string): Promise<void> {
  await expect(page).toHaveTitle(new RegExp(escape(`LRH ${name}`)));
  await expect(testId(page, "lrh-title")).toHaveText(`LRH ${name}`);
  await expect(testId(page, "lrh-crumb")).toHaveText(["Chats", name]);
}

export function runLoaderReadHandlesTests(
  options: LoaderReadHandlesScenarioOptions,
): void {
  const { url, waitForHydration, expectNoPageError, base } = options;

  for (const [how, button] of [
    ["a group refresh", "lrh-refresh"],
    ["load()", "lrh-load"],
  ] as const) {
    test(`${how} applies the loader's new title and crumb in place`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(url(`${base}/chat`));
      await waitForHydration(page);

      const first = await nameAfter(page, null);
      await expectHandlesOf(page, first);

      await testId(page, button).click();
      const second = await nameAfter(page, first);
      await expectHandlesOf(page, second);

      // Again: each read replaces the last one's values, never adds to them.
      await testId(page, button).click();
      const third = await nameAfter(page, second);
      await expectHandlesOf(page, third);
    });
  }
}
