import { expect, test, type Page, type Response } from "@playwright/test";
import { expectConsole } from "./console-guard.js";

/**
 * A Meta title and a Breadcrumbs crumb pushed after `await wait(1000)`, from
 * each place that holds ctx (fixture: handles-after-await.tsx in each app):
 * 1. an async route handler (/handler, under the async layout);
 * 2. an async layout handler (the layout around /handler and /plain);
 * 3. a loader body (/loader, read with useLoader; its layout is synchronous);
 * 4. an async server component handed the route handler's ctx (/component)
 *    or a layout handler's ctx (/component-layout): LateHandlePushError, by
 *    design;
 * 5. the designed path for 4: the layout and route handlers reserve the
 *    slots with .defer() and an async component resolves them after its
 *    await (/defer).
 * Each case checks the document, a client navigation in and away, Back, and
 * which segment keeps a push when a navigation re-runs only the page. Both
 * apps call this from a dev and a (production) describe.
 */

export interface HandlesAfterAwaitScenarioOptions {
  url: (pathname: string) => string;
  production: boolean;
}

const BASE = "/handles-after-await";
// Two sequential 1 s handlers, a 1 s loader, and up to six navigations.
const TEST_TIMEOUT = 60000;
// A navigation that runs one or two 1 s handlers, with dev compile headroom.
const NAV_TIMEOUT = 10000;

const LATE_PUSH_MESSAGE = /was pushed after handle collection completed/;
const DEFER_HINT =
  /reserve the slot there with ctx\.use\(Handle\)\.defer\(\) and resolve it from the component/;
// The RSC error production renders in place of the late-push message.
// A production document answers the recovery document, whose client render
// ends on the root error boundary; production omits the message.
const PRODUCTION_DOCUMENT_ERROR = "Internal Server Error";

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    null,
    { timeout: NAV_TIMEOUT },
  );
}

async function expectPage(
  page: Page,
  title: string,
  crumbs: string[],
): Promise<void> {
  await expect(page).toHaveTitle(title, { timeout: NAV_TIMEOUT });
  await expect(page.getByTestId("haa-crumb")).toHaveText(crumbs, {
    timeout: NAV_TIMEOUT,
  });
}

/** The `<title>` and crumbs the server's HTML carries, before any script runs. */
async function documentHandles(
  response: Response | null,
): Promise<{ title: string | undefined; crumbs: string[] }> {
  expect(response?.status()).toBe(200);
  const html = await response!.text();
  return {
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
    crumbs: [...html.matchAll(/data-testid="haa-crumb">([^<]*)</g)].map(
      (match) => match[1]!,
    ),
  };
}

async function load(
  page: Page,
  options: HandlesAfterAwaitScenarioOptions,
  pathname: string,
): Promise<{ title: string | undefined; crumbs: string[] }> {
  const response = await page.goto(options.url(BASE + pathname));
  const served = await documentHandles(response);
  await waitForHydration(page);
  return served;
}

async function click(page: Page, testId: string, url: RegExp): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page).toHaveURL(url, { timeout: NAV_TIMEOUT });
}

async function textOf(page: Page, testId: string): Promise<string> {
  return (await page.getByTestId(testId).textContent()) ?? "";
}

/**
 * Records every distinct `title | crumbs | page` the document shows from now
 * on, so a test can tell a held value from a blank or a half-applied one.
 */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const states: string[] = [];
    const snapshot = () =>
      [
        document.title,
        Array.from(document.querySelectorAll('[data-testid="haa-crumb"]'))
          .map((node) => node.textContent ?? "")
          .join(" > "),
        document.querySelector('[data-testid="haa-defer-page"]')?.textContent ??
          "",
      ].join(" | ");
    const record = () => {
      const state = snapshot();
      if (states[states.length - 1] !== state) states.push(state);
    };
    record();
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(self, { __haaStates: states });
  });
}

function recordedStates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (self as unknown as { __haaStates: string[] }).__haaStates,
  );
}

/**
 * Across one navigation the title and crumbs show the previous page's until
 * the new ones land: no state shows anything else (no blank, no mix), and the
 * new handles never show over the previous content. `contentFirst` also
 * requires the new content with the previous handles at least once; a
 * same-route search change commits its content just before the swap, too
 * briefly to observe reliably, so it checks the ordering only.
 */
async function expectHeldThenSwapped(
  page: Page,
  from: { title: string; crumbs: string[] },
  to: { title: string; crumbs: string[]; content: string },
  { contentFirst = true }: { contentFirst?: boolean } = {},
): Promise<void> {
  await expectPage(page, to.title, to.crumbs);
  const held = `${from.title} | ${from.crumbs.join(" > ")}`;
  const landed = `${to.title} | ${to.crumbs.join(" > ")}`;
  const states = await recordedStates(page);
  const handles = states.map((state) =>
    state.slice(0, state.lastIndexOf(" | ")),
  );
  expect(new Set(handles)).toEqual(new Set([held, landed]));
  for (const state of states) {
    if (state.startsWith(`${landed} | `)) {
      expect(state).toBe(`${landed} | ${to.content}`);
    }
  }
  if (contentFirst) expect(states).toContain(`${held} | ${to.content}`);
  expect(states[states.length - 1]).toBe(`${landed} | ${to.content}`);
}

export function runHandlesAfterAwaitTests(
  options: HandlesAfterAwaitScenarioOptions,
): void {
  test("an async route handler's title and crumb pushed after await wait(1000) show on the document, a navigation, Back, and only the page's are replaced when only the page re-runs", async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT);
    const served = await load(page, options, "/handler?v=1");
    expect(served).toEqual({
      title: "Handler 1 · Await Layout",
      crumbs: ["Await Layout", "Handler 1"],
    });
    await expectPage(page, "Handler 1 · Await Layout", [
      "Await Layout",
      "Handler 1",
    ]);
    const layoutRun = await textOf(page, "haa-layout-run");

    // Away to a sibling page: the handler's pushes go, the layout's stay.
    await click(page, "haa-link-plain", /\/plain$/);
    await expectPage(page, "Plain · Await Layout", ["Await Layout", "Plain"]);

    // Into the route from another page: only the route handler runs under
    // the held layout, and its pushes join the layout's.
    await click(page, "haa-link-handler-2", /\/handler\?v=2$/);
    await expect(page.getByTestId("haa-handler")).toContainText("handler 2", {
      timeout: NAV_TIMEOUT,
    });
    await expect(page.getByTestId("haa-layout-run")).toHaveText(layoutRun, {
      timeout: NAV_TIMEOUT,
    });
    await expectPage(page, "Handler 2 · Await Layout", [
      "Await Layout",
      "Handler 2",
    ]);

    // A search change re-runs only the route handler: its pushes are
    // replaced, the layout's template and crumb stay.
    await click(page, "haa-link-handler-3", /\/handler\?v=3$/);
    await expect(page.getByTestId("haa-handler")).toContainText("handler 3", {
      timeout: NAV_TIMEOUT,
    });
    await expect(page.getByTestId("haa-layout-run")).toHaveText(layoutRun, {
      timeout: NAV_TIMEOUT,
    });
    await expectPage(page, "Handler 3 · Await Layout", [
      "Await Layout",
      "Handler 3",
    ]);

    // Away out of the layout, then Back onto the page.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);
    await page.goBack();
    await expect(page).toHaveURL(/\/handler\?v=3$/, { timeout: NAV_TIMEOUT });
    await expectPage(page, "Handler 3 · Await Layout", [
      "Await Layout",
      "Handler 3",
    ]);
  });

  test("an async layout handler's title template and crumb pushed after await wait(1000) show on the document, a navigation, Back, and stay when a navigation re-runs only the page", async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT);
    const served = await load(page, options, "/plain");
    expect(served).toEqual({
      title: "Plain · Await Layout",
      crumbs: ["Await Layout", "Plain"],
    });
    await expectPage(page, "Plain · Await Layout", ["Await Layout", "Plain"]);
    const documentRun = await textOf(page, "haa-layout-run");

    // Away out of the layout: its pushes go.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);

    // Into the layout from another page: it runs again and pushes again.
    await click(page, "haa-link-handler", /\/handler\?v=1$/);
    await expect(page.getByTestId("haa-layout-run")).not.toHaveText(
      documentRun,
      { timeout: NAV_TIMEOUT },
    );
    await expectPage(page, "Handler 1 · Await Layout", [
      "Await Layout",
      "Handler 1",
    ]);

    // Observed: a link back to the document's URL shows the layout as the
    // document rendered it (the history cache holds that entry and the
    // server does not re-run the layout), with that render's pushes.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);
    await click(page, "haa-link-plain", /\/plain$/);
    await expect(page.getByTestId("haa-plain")).toBeVisible({
      timeout: NAV_TIMEOUT,
    });
    await expect(page.getByTestId("haa-layout-run")).toHaveText(documentRun, {
      timeout: NAV_TIMEOUT,
    });
    await expectPage(page, "Plain · Await Layout", ["Await Layout", "Plain"]);

    // Back onto a page under the layout.
    await page.goBack();
    await expect(page).toHaveURL(/\/handles-after-await$/, {
      timeout: NAV_TIMEOUT,
    });
    await expectPage(page, "Await Index", ["Await Index"]);
    await page.goBack();
    await expect(page).toHaveURL(/\/handler\?v=1$/, { timeout: NAV_TIMEOUT });
    await expectPage(page, "Handler 1 · Await Layout", [
      "Await Layout",
      "Handler 1",
    ]);

    // To a sibling route under the held layout: only the page runs, the
    // layout's template and crumb stay and the page's are replaced.
    const layoutRun = await textOf(page, "haa-layout-run");
    await click(page, "haa-link-handler-2", /\/handler\?v=2$/);
    await expect(page.getByTestId("haa-handler")).toContainText("handler 2", {
      timeout: NAV_TIMEOUT,
    });
    await expect(page.getByTestId("haa-layout-run")).toHaveText(layoutRun, {
      timeout: NAV_TIMEOUT,
    });
    await expectPage(page, "Handler 2 · Await Layout", [
      "Await Layout",
      "Handler 2",
    ]);
  });

  test("a loader's title and crumb pushed after await wait(1000) miss the server's HTML (late channel) and show after hydration, on a navigation, Back, and only the loader's are replaced when it re-runs", async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT);
    // Observed: the push lands after the handler barrier, so the HTML carries
    // only the layout's pushes; the late handle channel applies the loader's
    // after hydration (race model, /loader "Writing Handles from Loaders").
    const served = await load(page, options, "/loader?v=1");
    expect(served).toEqual({
      title: "Loader Layout",
      crumbs: ["Loader Layout"],
    });
    await expect(page.getByTestId("haa-loader-value")).toContainText(
      "loader 1",
      { timeout: NAV_TIMEOUT },
    );
    await expectPage(page, "Loader 1 · Loader Layout", [
      "Loader Layout",
      "Loader 1",
    ]);

    // Away, then into the route from another page.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);
    await click(page, "haa-link-loader-2", /\/loader\?v=2$/);
    await expect(page.getByTestId("haa-loader-value")).toContainText(
      "loader 2",
      { timeout: NAV_TIMEOUT },
    );
    await expectPage(page, "Loader 2 · Loader Layout", [
      "Loader Layout",
      "Loader 2",
    ]);

    // Away and Back onto the page.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);
    await page.goBack();
    await expect(page).toHaveURL(/\/loader\?v=2$/, { timeout: NAV_TIMEOUT });
    await expectPage(page, "Loader 2 · Loader Layout", [
      "Loader Layout",
      "Loader 2",
    ]);

    // A search change re-runs the loader, not the layout: the loader's pushes
    // are replaced, the layout's template and crumb stay.
    const layoutRun = await textOf(page, "haa-loader-layout-run");
    await click(page, "haa-link-loader-3", /\/loader\?v=3$/);
    await expect(page.getByTestId("haa-loader-value")).toContainText(
      "loader 3",
      { timeout: NAV_TIMEOUT },
    );
    await expect(page.getByTestId("haa-loader-layout-run")).toHaveText(
      layoutRun,
      { timeout: NAV_TIMEOUT },
    );
    await expectPage(page, "Loader 3 · Loader Layout", [
      "Loader Layout",
      "Loader 3",
    ]);
  });

  test("titles and crumbs reserved with .defer() in the layout and route handlers and resolved by an async component after await wait(1000) are in the server's HTML, and a navigation holds the previous ones until they land", async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT);
    // Resolved server-side before the HTML is sent.
    const served = await load(page, options, "/defer?v=1");
    expect(served).toEqual({
      title: "Defer 1 · Defer Layout",
      crumbs: ["Defer Layout", "Defer 1"],
    });
    await expectPage(page, "Defer 1 · Defer Layout", [
      "Defer Layout",
      "Defer 1",
    ]);

    // Into the layout from another page: the new page's content commits
    // while the index's title and crumb hold, then both deferred pairs land.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);
    await recordStates(page);
    await click(page, "haa-link-defer-2", /\/defer\?v=2$/);
    await expectHeldThenSwapped(
      page,
      { title: "Await Index", crumbs: ["Await Index"] },
      {
        title: "Defer 2 · Defer Layout",
        crumbs: ["Defer Layout", "Defer 2"],
        content: "defer 2",
      },
    );

    // A search change re-runs only the route handler under the held layout:
    // the page's previous title and crumb hold until its new ones land, the
    // layout's stay. Observed: the page's content waits for its async
    // component too (React keeps a revealed Suspense boundary's content in a
    // transition), so it commits with the previous handles just before they
    // swap: too briefly to require observing it, so only the ordering is
    // checked.
    const layoutRun = await textOf(page, "haa-defer-layout-run");
    await recordStates(page);
    await click(page, "haa-link-defer-3", /\/defer\?v=3$/);
    await expectHeldThenSwapped(
      page,
      { title: "Defer 2 · Defer Layout", crumbs: ["Defer Layout", "Defer 2"] },
      {
        title: "Defer 3 · Defer Layout",
        crumbs: ["Defer Layout", "Defer 3"],
        content: "defer 3",
      },
      { contentFirst: false },
    );
    await expect(page.getByTestId("haa-defer-layout-run")).toHaveText(
      layoutRun,
    );

    // Away, then Back onto the page.
    await click(page, "haa-link-index", /\/handles-after-await$/);
    await expectPage(page, "Await Index", ["Await Index"]);
    await page.goBack();
    await expect(page).toHaveURL(/\/defer\?v=3$/, { timeout: NAV_TIMEOUT });
    await expectPage(page, "Defer 3 · Defer Layout", [
      "Defer Layout",
      "Defer 3",
    ]);
  });

  for (const variant of [
    {
      name: "route handler",
      path: "/component",
      link: "haa-link-component",
      observed: "",
    },
    {
      name: "layout handler",
      path: "/component-layout",
      link: "haa-link-component-layout",
      observed: " (observed: the dev message names the child route's segment)",
    },
  ]) {
    test(`an async component given the ${variant.name}'s ctx that pushes after await wait(1000) throws LateHandlePushError on the document and on a navigation${variant.observed}`, async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT);
      const response = await page.goto(options.url(BASE + variant.path));
      expect(response?.status()).toBe(500);
      await expect(
        page
          .getByText(
            options.production ? PRODUCTION_DOCUMENT_ERROR : DEFER_HINT,
          )
          .first(),
      ).toBeVisible({ timeout: NAV_TIMEOUT });

      // Provoked on purpose (console guard, console-guard.ts).
      expectConsole(page, {
        allow: [/Unhandled error caught: LateHandlePushError/],
      });
      await load(page, options, "");
      await expectPage(page, "Await Index", ["Await Index"]);
      await click(page, variant.link, new RegExp(`${variant.path}$`));
      // The root error boundary; production omits the message.
      await expect(page.getByText("Internal Server Error").first()).toBeVisible(
        { timeout: NAV_TIMEOUT },
      );
      if (options.production) {
        await expect(page.getByText(LATE_PUSH_MESSAGE)).toHaveCount(0);
      } else {
        await expect(page.getByText(LATE_PUSH_MESSAGE).first()).toBeVisible();
        await expect(page.getByText(DEFER_HINT).first()).toBeVisible();
        // The message names a route segment (an id ending in R<n>; a
        // layout's ends in L<n>). For the layout variant that is the child
        // route's, not the layout's: ctx.use(Handle) reads the request's one
        // ctx's _currentSegmentId when it is called, after the await, by
        // which time the route handler has run.
        await expect(
          page.getByText(/for segment "\w*R\d+" was pushed after/).first(),
        ).toBeVisible();
      }

      // Back onto the page before the error restores its title and crumb.
      await page.goBack();
      await expect(page).toHaveURL(/\/handles-after-await$/, {
        timeout: NAV_TIMEOUT,
      });
      await expectPage(page, "Await Index", ["Await Index"]);
    });
  }
}
