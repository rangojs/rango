import { expect, test, type Page } from "@playwright/test";
import {
  countViewTransitions,
  viewTransitionReadyScroll,
  viewTransitionTypes,
  viewTransitions,
} from "./view-transition-probe.js";

/**
 * A back/forward restored from the history cache runs a view transition
 * under transition(). React commits a transition started inside the popstate
 * event synchronously, with no view transition, so the router commits the
 * restore on the next task, tagged pop and navigation-back, and scrolls to
 * the saved position in the commit's layout effect, before the transition's
 * new snapshot. Without transition(), and for an entry whose scroll the
 * browser restores itself (history.scrollRestoration "auto"), the restore
 * stays synchronous and adds no type.
 *
 * Fixture in each app: /vt-back/{list,detail/:id} (transition()) and
 * /vt-back-plain/* (none), tall pages whose links sit in a fixed header,
 * under <Html.ScrollRestoration> (test-app urls/vt-back.tsx, from its default
 * document; cloudflare-basic pages/vt-back.tsx, from the fixture's layout).
 *
 * Chromium aborts view transitions in hidden tabs; Playwright's headless
 * page is visible.
 */

export interface VtBackScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

const NAV_TIMEOUT = 10000;
const POP_TYPES = ["pop", "navigation-back"];

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

async function shows(page: Page, label: string): Promise<void> {
  await expect(testId(page, "vtb-page")).toHaveText(label, {
    timeout: NAV_TIMEOUT,
  });
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((target) => window.scrollTo(0, target), y);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
}

// Two animation frames and a tail: the view transition, its rAF scroll pass,
// and anything the browser does after the transition.
function settle(page: Page, tail = 400): Promise<void> {
  return page.evaluate(
    (ms) =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, ms)),
        ),
      ),
    tail,
  );
}

/** The view transitions started since `before`: types and scrollY at ready. */
async function since(
  page: Page,
  before: number,
): Promise<{ types: string[][]; readyScroll: (number | null)[] }> {
  return {
    types: (await viewTransitionTypes(page)).slice(before),
    readyScroll: (await viewTransitionReadyScroll(page)).slice(before),
  };
}

export function runVtBackTests(options: VtBackScenarioOptions): void {
  /** list at 700 -> detail 1 at 2000 [-> detail 2 at 4000]. */
  const visit = async (
    page: Page,
    base: string,
    detail2 = false,
  ): Promise<void> => {
    await countViewTransitions(page);
    await page.goto(options.url(`${base}/list`));
    await options.waitForHydration(page);
    await shows(page, "list");
    await scrollTo(page, 700);
    await testId(page, "vtb-to-detail-1").click();
    await shows(page, "detail 1");
    await settle(page);
    await scrollTo(page, 2000);
    if (detail2) {
      await testId(page, "vtb-to-detail-2").click();
      await shows(page, "detail 2");
      await settle(page);
      await scrollTo(page, 4000);
    }
  };

  test("transition(): Back and Forward animate, tagged pop, at the saved scroll", async ({
    page,
  }) => {
    await visit(page, "/vt-back");

    let before = await viewTransitions(page);
    await page.goBack();
    await shows(page, "list");
    await settle(page);
    expect(await since(page, before)).toEqual({
      types: [POP_TYPES],
      readyScroll: [700],
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(700);

    before = await viewTransitions(page);
    await page.goForward();
    await shows(page, "detail 1");
    await settle(page);
    expect(await since(page, before)).toEqual({
      types: [POP_TYPES],
      readyScroll: [2000],
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(2000);
  });

  test("transition(): the click after a cached Back carries its own types only", async ({
    page,
  }) => {
    await visit(page, "/vt-back");
    await page.goBack();
    await shows(page, "list");
    await settle(page);

    const before = await viewTransitions(page);
    await testId(page, "vtb-to-detail-2").click();
    await shows(page, "detail 2");
    await settle(page);
    expect((await since(page, before)).types).toEqual([["push", "navigation"]]);
  });

  test("transition(): a rapid double Back ends on the right page, and each entry keeps its own scroll", async ({
    page,
  }) => {
    await visit(page, "/vt-back", true);

    const before = await viewTransitions(page);
    // Two traversals in one task: the second popstate arrives before the
    // first one's restore commits.
    await page.evaluate(() => {
      history.back();
      history.back();
    });
    await shows(page, "list");
    await settle(page, 800);
    await shows(page, "list");
    expect(await page.evaluate(() => location.pathname)).toBe("/vt-back/list");
    // One view transition, or two when the first restore committed before
    // the second popstate: each a pop, the last one onto the list.
    const { types } = await since(page, before);
    expect(types.length).toBeGreaterThan(0);
    for (const each of types) expect(each).toEqual(POP_TYPES);
    expect(await page.evaluate(() => window.scrollY)).toBe(700);

    // The second traversal saved the page still on screen (detail 2), not
    // detail 1, which it never showed.
    await page.goForward();
    await shows(page, "detail 1");
    await settle(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(2000);
    await page.goForward();
    await shows(page, "detail 2");
    await settle(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(4000);
  });

  test("transition(): an entry whose scroll the browser restores (scrollRestoration auto) commits in the event, with no view transition", async ({
    page,
  }) => {
    await countViewTransitions(page);
    await page.goto(options.url("/vt-back/list"));
    await options.waitForHydration(page);
    await shows(page, "list");
    // As for an entry created before <Html.ScrollRestoration> mounted: the
    // browser restores it right after the popstate event, so the restored
    // page must be on screen by then.
    await page.evaluate(() => (history.scrollRestoration = "auto"));
    await scrollTo(page, 700);
    await testId(page, "vtb-to-detail-1").click();
    await shows(page, "detail 1");
    await settle(page);
    await scrollTo(page, 2000);

    const before = await viewTransitions(page);
    const shownAfterEvent = page.evaluate(
      () =>
        new Promise<string | null | undefined>((resolve) => {
          window.addEventListener(
            "popstate",
            () =>
              setTimeout(() =>
                resolve(
                  document.querySelector('[data-testid="vtb-page"]')
                    ?.textContent,
                ),
              ),
            { once: true },
          );
        }),
    );
    await page.goBack();
    expect(await shownAfterEvent).toBe("list");
    await settle(page);
    expect(await viewTransitions(page)).toBe(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(700);
  });

  test("no transition(): Back is instant and starts no view transition", async ({
    page,
  }) => {
    await visit(page, "/vt-back-plain");

    const before = await viewTransitions(page);
    // The restore is not deferred: the list is on screen by the next frame.
    const shownNextFrame = page.evaluate(
      () =>
        new Promise<string | null | undefined>((resolve) => {
          window.addEventListener(
            "popstate",
            () =>
              requestAnimationFrame(() =>
                resolve(
                  document.querySelector('[data-testid="vtb-page"]')
                    ?.textContent,
                ),
              ),
            { once: true },
          );
        }),
    );
    await page.goBack();
    expect(await shownNextFrame).toBe("list");
    await settle(page);
    expect(await viewTransitions(page)).toBe(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(700);

    // Nothing the restore queued reaches the next transition commit.
    const next = await viewTransitions(page);
    await testId(page, "vtb-to-animated").click();
    await shows(page, "detail 2");
    await settle(page);
    expect((await since(page, next)).types).toEqual([["push", "navigation"]]);
  });
}
