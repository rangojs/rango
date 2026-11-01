import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  readState,
  stateEpochOf,
  useKey,
  waitForSettled,
  type ActionStaleFixtureOptions,
} from "./action-stale-fixture.js";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A server action without a directive bumps the write part of the rango
 * state (`{version}:{timestamp}:{write}`, its response's Set-Cookie). The
 * state is what every prefetch and navigation sends as `X-Rango-State`, and
 * responses vary on it, so it keys the browser HTTP cache. Without the bump
 * a prefetch whose response carries its own `Cache-Control: max-age` is
 * answered from the HTTP cache after the write, and the click shows the
 * value from before it with no revalidation: in the tab that ran the action,
 * after a reload, and in a tab opened after the action (which never heard
 * its broadcast, as a tab that shares no segment with the page does not act
 * on it: only the state it sends keeps the HTTP cache from answering).
 *
 * The timestamp stays, so the in-memory prefetches only go stale, as before
 * (action-stale-prefetch-scenario.ts). A tab open across the write that hears
 * no broadcast of it marks its own when it next reads the bumped state, so a
 * prefetch it made before the write is not shown as fresh, and a link to a
 * page in its history cache revalidates that page rather than holding its
 * layout's loaders from the entry.
 *
 * Fixture: action-stale.tsx in each app. /action-stale/bare/max-age reads the
 * cart and answers with `Cache-Control: private, max-age=60`; the bare basket
 * links to it with ?prefetch=max-age, prefetched on hover. The bare layout's
 * add writes the cart and answers at once. /action-stale/basket, under the
 * layout whose `as-cart-default` loader reads the cart with no revalidate(),
 * and the bare basket link to each other, unprefetched. Both apps call this
 * from a dev and a (production) describe.
 */

const SOURCE = "/action-stale/bare/basket?prefetch=max-age";
const TARGET = "/action-stale/bare/max-age";

export interface ActionStaleHttpCacheScenarioOptions extends ActionStaleFixtureOptions {
  /** Load every module the cases use once per worker (a dev server). */
  warmUp: boolean;
}

interface MaxAgePrefetch {
  /** The X-Rango-State it sent. */
  state: string | undefined;
  /** Its response's Cache-Control. */
  cacheControl?: string;
  finished: boolean;
}

/** The prefetches of the max-age page `page` sends from now on. */
function recordMaxAgePrefetches(page: Page): MaxAgePrefetch[] {
  const sent: MaxAgePrefetch[] = [];
  const entries = new Map<object, MaxAgePrefetch>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    const headers = request.headers();
    if (
      !url.pathname.endsWith(TARGET) ||
      !url.searchParams.has("_rsc_partial") ||
      headers["x-rango-prefetch"] === undefined
    ) {
      return;
    }
    const entry: MaxAgePrefetch = {
      state: headers["x-rango-state"],
      finished: false,
    };
    sent.push(entry);
    entries.set(request, entry);
  });
  page.on("response", (response) => {
    const entry = entries.get(response.request());
    if (entry) entry.cacheControl = response.headers()["cache-control"];
  });
  page.on("requestfinished", (request) => {
    const entry = entries.get(request);
    if (entry) entry.finished = true;
  });
  return sent;
}

/** The bare basket under a fresh key (cart 0), recording its prefetches. */
async function openSource(
  page: Page,
  options: ActionStaleHttpCacheScenarioOptions,
): Promise<MaxAgePrefetch[]> {
  const sent = recordMaxAgePrefetches(page);
  await page.goto(options.url(SOURCE));
  await waitForShellHydration(page);
  await expect(page.getByTestId("as-bare-basket")).toBeVisible();
  return sent;
}

/** Hover the link (off it first) and wait until `count` prefetches ended. */
async function hoverPrefetch(
  page: Page,
  sent: MaxAgePrefetch[],
  count: number,
): Promise<void> {
  await page.mouse.move(0, 0);
  await page.getByTestId("as-to-max-age-prefetched").hover();
  await expect
    .poll(() => sent.filter((entry) => entry.finished).length)
    .toBe(count);
}

/** Write once through the bare layout's add, and wait until it settled. */
async function write(page: Page): Promise<void> {
  await page.getByTestId("as-bare-add").click();
  await waitForSettled(page);
  await expect(page.locator("html")).toHaveAttribute("data-as-result", "1");
}

export function runActionStaleHttpCacheTests(
  options: ActionStaleHttpCacheScenarioOptions,
): void {
  test.beforeAll(async ({ browser }) => {
    if (!options.warmUp) return;
    test.setTimeout(60000);
    const page = await browser.newPage();
    try {
      await useKey(page, options, randomUUID());
      const sent = await openSource(page, options);
      await hoverPrefetch(page, sent, 1);
      await write(page);
      await page.getByTestId("as-to-max-age-prefetched").click();
      await expect(page.getByTestId("as-max-age")).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    await useKey(page, options, randomUUID());
  });

  test("a hover after an action is not answered by the HTTP cache: the click shows the write", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const sent = await openSource(page, options);
    await hoverPrefetch(page, sent, 1);
    expect(sent[0]!.cacheControl, "the fixture's own max-age").toBe(
      "private, max-age=60",
    );
    const before = await readState(page);

    await write(page);
    await hoverPrefetch(page, sent, 2);
    await page.getByTestId("as-to-max-age-prefetched").click();
    await expect(page.getByTestId("as-max-age")).toHaveText("max-age:1");

    // The hover sent the state the action's response bumped: only its write
    // part, so the in-memory prefetch keys did not change.
    const after = await readState(page);
    expect(sent[1]!.state).toBe(after);
    expect(after, "the action bumps the state").not.toBe(before);
    expect(stateEpochOf(after), "only its write part").toBe(
      stateEpochOf(before),
    );
  });

  test("after a reload, a hover shows the write", async ({ page }) => {
    test.setTimeout(60000);
    const sent = await openSource(page, options);
    await hoverPrefetch(page, sent, 1);
    await write(page);

    await page.reload();
    await waitForShellHydration(page);
    await expect(page.getByTestId("as-bare-basket")).toHaveText("basket:1");
    await hoverPrefetch(page, sent, 2);
    await page.getByTestId("as-to-max-age-prefetched").click();
    await expect(page.getByTestId("as-max-age")).toHaveText("max-age:1");
  });

  test("a tab opened after an action shows the write on hover", async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    const sent = await openSource(page, options);
    await hoverPrefetch(page, sent, 1);
    await write(page);

    const other = await context.newPage();
    try {
      const otherSent = await openSource(other, options);
      await hoverPrefetch(other, otherSent, 1);
      expect(otherSent[0]!.state).toBe(await readState(page));
      await other.getByTestId("as-to-max-age-prefetched").click();
      await expect(other.getByTestId("as-max-age")).toHaveText("max-age:1");
    } finally {
      await other.close();
    }
  });

  test("a tab that hears no broadcast does not show its pre-write prefetch after another tab's write", async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    // This tab gets no cross-tab message, as a tab whose page shares no
    // segment with the acting page (it ignores the broadcast) or one with
    // crossTabSync: false: the write reaches it only through the state
    // cookie the action's response set in the shared jar.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "BroadcastChannel");
    });
    const sent = await openSource(page, options);
    // The pointer stays on the link, so the click below sends no new hover
    // prefetch: it reads the pre-write entry this one stored.
    await hoverPrefetch(page, sent, 1);
    const before = await readState(page);

    const other = await context.newPage();
    try {
      await openSource(other, options);
      await write(other);
    } finally {
      await other.close();
    }

    await page.getByTestId("as-to-max-age-prefetched").click();
    await expect(page.getByTestId("as-max-age")).toHaveText("max-age:1");
    expect(sent, "no prefetch after the write").toHaveLength(1);
    const after = await readState(page);
    expect(after, "the other tab's action bumped the state").not.toBe(before);
    expect(stateEpochOf(after), "only its write part").toBe(
      stateEpochOf(before),
    );
  });

  test("a tab that hears no broadcast revalidates a page in its history on a link to it after another tab's write", async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    // No cross-tab message, as above. A link to a page in the history cache
    // names the entry's ids, and the server holds each one the default
    // allows: the basket's route (its params and search are the entry's)
    // and its layout's cart loader with no revalidate(). Only once the tab
    // has read the bumped state is the entry stale, so the link names none.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "BroadcastChannel");
    });
    await page.goto(options.url("/action-stale/basket"));
    await waitForShellHydration(page);
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:0");
    await page.getByTestId("as-to-bare-basket").click();
    await expect(page.getByTestId("as-bare-basket")).toHaveText("basket:0");
    await expect(page.getByTestId("as-layout")).toHaveCount(0);
    const before = await readState(page);

    const other = await context.newPage();
    try {
      await openSource(other, options);
      await write(other);
    } finally {
      await other.close();
    }

    // A link, not Back: the basket's entry is in this tab's history cache,
    // fresh as far as the tab knows until it reads the bumped state.
    await page.getByTestId("as-bare-to-basket").click();
    await expect(page.getByTestId("as-basket")).toHaveText("basket:1");
    await expect(page.getByTestId("as-cart-default")).toHaveText("default:1");
    const after = await readState(page);
    expect(after, "the other tab's action bumped the state").not.toBe(before);
    expect(stateEpochOf(after), "only its write part").toBe(
      stateEpochOf(before),
    );
  });
}
