import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";

/**
 * Hydration from the stream (/hydration, src/pages/hydration-demo.tsx).
 * Readers hydrate with what the server rendered, also inside a boundary that
 * hydrates after the root, and receive the router store's later values once
 * every boundary has hydrated. A reader re-renders only when its selection
 * changes.
 */

type Url = (pathname: string) => string;

/**
 * How long the late boundary streams (ms). The tests that open a page need the
 * root to hydrate before it resolves; development under parallel workers can
 * take longer than 2.5 s to hydrate.
 */
const STREAM_DELAY = 5000;

/** For an assertion that waits for the late boundary to resolve. */
const PAST_STREAM = { timeout: STREAM_DELAY + 10000 };

function collectHydrationErrors(page: Page): string[] {
  const errors: string[] = [];
  const isHydrationError = (text: string): boolean =>
    /hydrat|did not match|server rendered/i.test(text);
  page.on("console", (message) => {
    if (message.type() === "error" && isHydrationError(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (isHydrationError(error.message)) errors.push(error.message);
  });
  return errors;
}

async function waitForRootHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    undefined,
    { timeout: 20000 },
  );
}

async function rendersOf(page: Page, testId: string): Promise<number> {
  return Number(await page.getByTestId(testId).textContent());
}

async function lateHandlePush(page: Page, url: Url): Promise<void> {
  const errors = collectHydrationErrors(page);
  await page.goto(url(`/hydration/late-handle?delay=${STREAM_DELAY}`), {
    waitUntil: "commit",
  });
  await waitForRootHydration(page);

  // The root has hydrated while the route's boundary still streams.
  await expect(page.getByTestId("hyd-loading")).toBeVisible();
  await expect(page.getByTestId("hyd-note-count")).toHaveText("2");
  const constantRenders = await rendersOf(page, "hyd-constant-renders");
  const countRenders = await rendersOf(page, "hyd-note-count-renders");

  // The boundary hydrates with the notes the server rendered; the late note
  // reaches every reader once the document has streamed.
  await expect(page.getByTestId("hyd-loader-data")).toHaveText(
    "loader data streamed in",
    PAST_STREAM,
  );
  await expect(page.getByTestId("hyd-note")).toHaveText([
    "layout note",
    "route note",
    "late note from the loader",
  ]);
  await expect(page.getByTestId("hyd-note-count")).toHaveText("3");
  await expect(page.getByTestId("hyd-late-content")).toHaveCount(1);

  // Only the reader whose selection changed rendered again.
  expect(await rendersOf(page, "hyd-constant-renders")).toBe(constantRenders);
  expect(await rendersOf(page, "hyd-note-count-renders")).toBeGreaterThan(
    countRenders,
  );
  expect(errors).toEqual([]);
}

async function linkStateNavigation(page: Page, url: Url): Promise<void> {
  const errors = collectHydrationErrors(page);
  await page.goto(url("/hydration"));
  await waitForRootHydration(page);

  // The Link's state reaches the page's reader in the commit that shows the
  // page, while the late boundary still loads.
  await page.getByTestId("hyd-link-state-with-link").click();
  await expect(page.getByTestId("hyd-page-state-value")).toHaveText(
    "sent with the link",
  );
  await expect(page.getByTestId("hyd-state-fallback")).toBeVisible();

  // The boundary's reader gets it when the boundary resolves.
  await expect(page.getByTestId("hyd-state-value")).toHaveText(
    "sent with the link",
  );

  // A reload renders without history state; readers hydrate as "empty", then
  // show the entry's stored state.
  await page.reload({ waitUntil: "commit" });
  await waitForRootHydration(page);
  await expect(page.getByTestId("hyd-page-state-value")).toHaveText(
    "sent with the link",
  );
  await expect(page.getByTestId("hyd-state-value")).toHaveText(
    "sent with the link",
  );
  await expect(page.getByTestId("hyd-state-value")).toHaveCount(1);
  expect(errors).toEqual([]);
}

async function reloadLocationState(page: Page, url: Url): Promise<void> {
  const errors = collectHydrationErrors(page);
  await page.goto(url(`/hydration/late-state?delay=${STREAM_DELAY}`), {
    waitUntil: "commit",
  });
  await waitForRootHydration(page);
  await expect(page.getByTestId("hyd-state-fallback")).toBeVisible();
  await expect(page.getByTestId("hyd-state-value")).toHaveText(
    "empty",
    PAST_STREAM,
  );

  // write() stores the value on the history entry; readers get it when the
  // entry is next restored, not now.
  await page.getByTestId("hyd-state-write").click();
  await expect(page.getByTestId("hyd-state-value")).toHaveText("empty");

  // After a reload the boundary hydrates as the server rendered it, after the
  // root, and then shows the entry's stored state.
  await page.reload({ waitUntil: "commit" });
  await waitForRootHydration(page);
  await expect(page.getByTestId("hyd-state-fallback")).toBeVisible();
  await expect(page.getByTestId("hyd-state-value")).toHaveText(
    "stored value",
    PAST_STREAM,
  );
  await expect(page.getByTestId("hyd-page-state-value")).toHaveText(
    "stored value",
  );
  await expect(page.getByTestId("hyd-state-value")).toHaveCount(1);
  expect(errors).toEqual([]);
}

async function navigateMidStream(page: Page, url: Url): Promise<void> {
  const errors = collectHydrationErrors(page);
  await page.goto(url(`/hydration/late-handle?delay=${STREAM_DELAY}`), {
    waitUntil: "commit",
  });
  await waitForRootHydration(page);
  await expect(page.getByTestId("hyd-loading")).toBeVisible();

  // Leave while the late boundary is still streaming.
  await page.getByTestId("hyd-link-other").click();
  await expect(page.getByTestId("hyd-other")).toHaveCount(1);
  await expect(page.getByTestId("hyd-note-count")).toHaveText("2");
  await expect(page.getByTestId("hyd-other-pathname")).toHaveText(
    "/hydration/other",
  );
  await expect(page.getByTestId("hyd-other-notes")).toHaveText(
    "layout note, other page note",
  );

  // The page the navigation mounted read the destination on every render,
  // its first included: nothing from the page that was still streaming.
  const renders = await page.evaluate(
    () => (window as { __hydOtherRenders?: unknown[] }).__hydOtherRenders ?? [],
  );
  expect(renders.length).toBeGreaterThan(0);
  for (const render of renders) {
    expect(render).toEqual({
      pathname: "/hydration/other",
      notes: "layout note, other page note",
    });
  }
  expect(errors).toEqual([]);
}

devTest.describe("hydration-demo", () => {
  devTest(
    "a late handle push reaches only readers whose selection changes",
    async ({ page, devServerURL }) => {
      await lateHandlePush(page, (p) => devURL(devServerURL, p));
    },
  );
  devTest(
    "a Link's location state shows in the commit that shows the page",
    async ({ page, devServerURL }) => {
      await linkStateNavigation(page, (p) => devURL(devServerURL, p));
    },
  );
  devTest(
    "after a reload, location state read in a slow section hydrates as the server rendered it",
    async ({ page, devServerURL }) => {
      await reloadLocationState(page, (p) => devURL(devServerURL, p));
    },
  );
  devTest(
    "a navigation before the document has streamed mounts the destination from its first render",
    async ({ page, devServerURL }) => {
      await navigateMidStream(page, (p) => devURL(devServerURL, p));
    },
  );
});

test.describe("hydration-demo (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("a late handle push reaches only readers whose selection changes", async ({
    page,
  }) => {
    await lateHandlePush(page, (p) => f.url(p));
  });
  test("a Link's location state shows in the commit that shows the page", async ({
    page,
  }) => {
    await linkStateNavigation(page, (p) => f.url(p));
  });
  test("after a reload, location state read in a slow section hydrates as the server rendered it", async ({
    page,
  }) => {
    await reloadLocationState(page, (p) => f.url(p));
  });
  test("a navigation before the document has streamed mounts the destination from its first render", async ({
    page,
  }) => {
    await navigateMidStream(page, (p) => f.url(p));
  });
});
