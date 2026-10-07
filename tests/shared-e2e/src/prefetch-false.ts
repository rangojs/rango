import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * `prefetch: false` on `loader()` and `loading()`, as a browser sees it
 * (docs/design/prefetch-false.md). The bodies here run against any app that
 * mounts the fixture below, so the node test-app and the Cloudflare app pin
 * the same behaviour.
 *
 * The fixture is a hub page at `/prefetch-false?run=<id>` with one link per
 * case, each `prefetch="hover"` so the body decides when the prefetch happens.
 * Every unit of server work counts its runs under the `run` of the request;
 * `/prefetch-false/__counts?run=<id>` returns the counters as JSON. A run id
 * is unique per call, so parallel tests and retries never share a counter.
 *
 * For a case `<c>` (a page at `/prefetch-false/<c>`):
 *
 * | Test id           | What it is                                         |
 * | ----------------- | -------------------------------------------------- |
 * | `pf-link-<c>`     | the hub link                                       |
 * | `pf-<c>-page`     | the handler's content                              |
 * | `pf-<c>-fallback` | what shows while the deferred part is missing      |
 * | `pf-<c>-value`    | the deferred loader's value: `<c>.data:<run count>` |
 *
 * Reference implementation:
 * packages/rangojs-router/e2e/test-app/src/urls/prefetch-false.tsx.
 */
export interface PrefetchFalseFixture {
  /** Absolute URL of a path in the app under test. */
  url: (path: string) => string;
}

export interface PrefetchFalseCase {
  /** The case name: the page is `/prefetch-false/<name>`. */
  name: string;
  /**
   * Counters of the work a prefetch must skip and the click must run once.
   * Default: the case's deferred loader, `<name>.data`.
   */
  deferred?: string[];
  /**
   * Counters of work the prefetch runs and the click must not run again
   * (the handler of a stored route, an unflagged loader).
   */
  prefetched?: string[];
  /** Test ids on screen beside the fallback while the fill is in flight. */
  shownWhileMissing?: string[];
}

interface Hub {
  run: string;
  pageUrl: (name: string) => string;
  pathname: (name: string) => string;
  counts: () => Promise<Record<string, number>>;
}

function byId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

function isPartialFor(url: string, pathname: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.pathname === pathname && parsed.searchParams.has("_rsc_partial")
  );
}

function isFill(url: string): boolean {
  return new URL(url).searchParams.has("_rsc_fill");
}

function hubFor(page: Page, fixture: PrefetchFalseFixture, run: string): Hub {
  const pathname = (name: string) => `/prefetch-false/${name}`;
  return {
    run,
    pathname,
    pageUrl: (name) => fixture.url(`${pathname(name)}?run=${run}`),
    counts: async () => {
      const response = await page.request.get(
        fixture.url(`/prefetch-false/__counts?run=${run}`),
      );
      expect(response.ok(), "the counts endpoint answers").toBe(true);
      return (await response.json()) as Record<string, number>;
    },
  };
}

async function openHub(
  page: Page,
  fixture: PrefetchFalseFixture,
  run: string = randomUUID().slice(0, 8),
): Promise<Hub> {
  await page.goto(fixture.url(`/prefetch-false?run=${run}`));
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
  await expect(byId(page, "pf-hub")).toBeVisible();
  return hubFor(page, fixture, run);
}

/** Every request for the case's page, in order: prefetch, navigation, fill. */
function recordPartials(page: Page, pathname: string): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (isPartialFor(request.url(), pathname)) requests.push(request);
  });
  return requests;
}

/** Hover the hub link and wait until its prefetch has been fully received. */
async function prefetchCase(page: Page, hub: Hub, name: string): Promise<void> {
  const prefetched = page.waitForResponse(
    (response) =>
      isPartialFor(response.url(), hub.pathname(name)) &&
      response.request().headers()["x-rango-prefetch"] === "1",
    { timeout: 20_000 },
  );
  await byId(page, `pf-link-${name}`).hover();
  const response = await prefetched;
  await response.finished();
}

/**
 * Hold every fill request until `release()`, so the state between the commit
 * and the fill is observable. A request the page aborts meanwhile never
 * reaches the server.
 */
async function holdFills(
  page: Page,
): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const matcher = (url: URL) => url.searchParams.has("_rsc_fill");
  await page.route(matcher, async (route) => {
    await opened;
    await route.continue().catch(() => {});
  });
  return {
    release: async () => {
      open();
      await page.unroute(matcher);
    },
  };
}

type RequestKind = "prefetch" | "fill" | "navigation";

function kindsOf(requests: Request[]): RequestKind[] {
  return requests.map((request) =>
    isFill(request.url())
      ? "fill"
      : request.headers()["x-rango-prefetch"] === "1"
        ? "prefetch"
        : "navigation",
  );
}

function pick(
  counts: Record<string, number>,
  names: string[],
): Record<string, number> {
  return Object.fromEntries(names.map((name) => [name, counts[name] ?? 0]));
}

function plus(
  counts: Record<string, number>,
  delta: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).map(([name, value]) => [name, value + delta]),
  );
}

/**
 * The contract in one body. A prefetch does not run the flagged work. The
 * click that adopts the prefetch commits at once: the URL changes and the
 * fallback shows while exactly one fill request is in flight. The fill runs
 * the flagged work once, and nothing the prefetch already ran runs again.
 *
 * `run` joins an existing run: its counters are the baseline.
 */
export async function expectPrefetchSkipsFlaggedWorkAndClickFillsIt(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseCase,
  run?: string,
): Promise<Hub> {
  const { name } = spec;
  const deferred = spec.deferred ?? [`${name}.data`];
  const prefetchedWork = spec.prefetched ?? [];
  const hub = await openHub(page, fixture, run);
  const requests = recordPartials(page, hub.pathname(name));
  const baseline = await hub.counts();
  const before = pick(baseline, deferred);
  const valueBefore = baseline[`${name}.data`] ?? 0;

  await prefetchCase(page, hub, name);
  const afterPrefetch = await hub.counts();
  expect(
    pick(afterPrefetch, deferred),
    "the prefetch did not run the flagged work",
  ).toEqual(before);
  for (const counter of prefetchedWork) {
    expect(afterPrefetch[counter], `the prefetch ran ${counter}`).toBe(1);
  }

  const fills = await holdFills(page);
  await byId(page, `pf-link-${name}`).click();
  await expect(page).toHaveURL(hub.pageUrl(name));
  await expect(byId(page, `pf-${name}-fallback`)).toBeVisible();
  for (const id of spec.shownWhileMissing ?? []) {
    await expect(byId(page, id)).toBeVisible();
  }
  await expect(byId(page, `pf-${name}-value`)).toHaveCount(0);
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  expect(
    pick(await hub.counts(), deferred),
    "the fallback shows before the flagged work has run",
  ).toEqual(before);
  // What the click committed: the fill must merge into these very nodes.
  const committed = ["pf-layout", ...(spec.shownWhileMissing ?? [])];
  const nodes = await Promise.all(
    committed.map((id) => byId(page, id).elementHandle()),
  );

  await fills.release();
  await expect(byId(page, `pf-${name}-value`)).toHaveText(
    `${name}.data:${valueBefore + 1}`,
  );
  await expect(byId(page, `pf-${name}-page`)).toBeVisible();
  await expect(byId(page, `pf-${name}-fallback`)).toHaveCount(0);
  for (const [index, id] of committed.entries()) {
    expect(
      await nodes[index]!.evaluate((node) => node.isConnected),
      `the fill did not remount ${id}`,
    ).toBe(true);
  }

  const afterClick = await hub.counts();
  expect(
    pick(afterClick, deferred),
    "the click ran the flagged work exactly once",
  ).toEqual(plus(before, 1));
  expect(
    pick(afterClick, prefetchedWork),
    "the click did not run again what the prefetch ran",
  ).toEqual(pick(afterPrefetch, prefetchedWork));

  expect(
    kindsOf(requests),
    "one prefetch, then one fill, and no navigation",
  ).toEqual(["prefetch", "fill"]);
  const fill = requests[1];
  expect(
    fill.headers()["x-rango-prefetch"],
    "a fill is not a prefetch",
  ).toBeUndefined();
  return hub;
}

/**
 * A flagged loader whose read has no boundary (no `loading()` on its entry,
 * no Suspense around it): nothing can show a fallback, so React holds the
 * page being left until the fill returns. The URL has already changed.
 */
export async function expectNoBoundaryHoldsThePageLeftUntilTheFillReturns(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("bare"));
  await prefetchCase(page, hub, "bare");
  expect((await hub.counts())["bare.data"] ?? 0).toBe(0);

  const fills = await holdFills(page);
  await byId(page, "pf-link-bare").click();
  await expect(page).toHaveURL(hub.pageUrl("bare"));
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  await expect(byId(page, "pf-hub")).toBeVisible();
  await expect(byId(page, "pf-bare-page")).toHaveCount(0);

  await fills.release();
  await expect(byId(page, "pf-bare-value")).toHaveText("bare.data:1");
  await expect(byId(page, "pf-hub")).toHaveCount(0);
  expect((await hub.counts())["bare.data"]).toBe(1);
  expect(requests.filter((r) => isFill(r.url()))).toHaveLength(1);
}

export interface PrefetchFalseOutcome {
  /** The case name: the page is `/prefetch-false/<name>`. */
  name: string;
  /** Test id on screen once the fill has landed, and not before. */
  shows: string;
  /** The case whose page the deferred work redirects to. */
  landsOn?: string;
}

/**
 * Deferred work that ends in something other than a value: an error, a
 * `notFound()`, a `redirect()`, a handle push. The outcome arrives with the
 * fill, where it would for work that streams behind `loading()`: not in the
 * prefetch, and not before the fill returns.
 */
export async function expectDeferredOutcomeArrivesWithTheFill(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseOutcome,
): Promise<void> {
  const { name } = spec;
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname(name));
  await prefetchCase(page, hub, name);
  expect((await hub.counts())[`${name}.data`] ?? 0).toBe(0);

  const fills = await holdFills(page);
  await byId(page, `pf-link-${name}`).click();
  await expect(page).toHaveURL(hub.pageUrl(name));
  await expect(byId(page, `pf-${name}-fallback`)).toBeVisible();
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  await expect(byId(page, spec.shows)).toHaveCount(0);

  await fills.release();
  await expect(byId(page, spec.shows)).toBeVisible();
  await expect(byId(page, `pf-${name}-fallback`)).toHaveCount(0);
  await expect(page).toHaveURL(hub.pageUrl(spec.landsOn ?? name));
  expect((await hub.counts())[`${name}.data`]).toBe(1);
  expect(requests.filter((r) => isFill(r.url()))).toHaveLength(1);
}

/**
 * Control: a route with no flag. The prefetch runs everything, and the click
 * that adopts it sends no request at all.
 */
export async function expectUnflaggedRouteIsPrefetchedWhole(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("control"));

  await prefetchCase(page, hub, "control");
  expect((await hub.counts())["control.data"]).toBe(1);

  await byId(page, "pf-link-control").click();
  await expect(byId(page, "pf-control-value")).toHaveText("control.data:1");
  await expect(page).toHaveURL(hub.pageUrl("control"));
  expect((await hub.counts())["control.data"]).toBe(1);
  expect(requests.length, "the click reused the prefetch").toBe(1);
  expect(requests.some((request) => isFill(request.url()))).toBe(false);
}

/**
 * `ssr: false` with `prefetch: false`: a document request runs the loader
 * (its value is in the HTML), a prefetch still skips it.
 */
export async function expectDocumentAwaitsLoaderThatPrefetchSkips(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const hub = hubFor(page, fixture, run);
  const response = await page.request.get(hub.pageUrl("ssr-false"));
  const html = await response.text();
  expect(html, "the loader's value is in the document").toContain(
    "ssr-false.data:1",
  );
  expect((await hub.counts())["ssr-false.data"]).toBe(1);

  await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(
    page,
    fixture,
    { name: "ssr-false" },
    run,
  );
}

/**
 * History keeps the filled page: back and forward after a fill restore it
 * without a request and without running the flagged work again.
 */
export async function expectBackAndForwardKeepTheFilledPage(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(
    page,
    fixture,
    { name: "loader" },
  );
  const requests = recordPartials(page, hub.pathname("loader"));

  await page.goBack();
  await expect(byId(page, "pf-hub")).toBeVisible();
  await page.goForward();
  await expect(byId(page, "pf-loader-value")).toHaveText("loader.data:1");
  await expect(byId(page, "pf-loader-price")).toHaveText("loader.price:1");
  await expect(byId(page, "pf-loader-fallback")).toHaveCount(0);

  await page.goBack();
  await expect(byId(page, "pf-hub")).toBeVisible();
  await page.goForward();
  await expect(byId(page, "pf-loader-value")).toHaveText("loader.data:1");

  expect(requests, "the filled entry was restored from history").toEqual([]);
  expect((await hub.counts())["loader.data"]).toBe(1);
}

/**
 * Leaving before the fill returns aborts it, and going back to the entry
 * fetches what is missing instead of restoring a fallback nobody fills.
 */
export async function expectLeavingBeforeTheFillAbortsItAndBackRefetches(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "unit");

  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    if (isFill(request.url())) aborted.push(request.failure()?.errorText ?? "");
  });
  const fills = await holdFills(page);
  await byId(page, "pf-link-unit").click();
  await expect(page).toHaveURL(hub.pageUrl("unit"));
  await expect(byId(page, "pf-unit-fallback")).toBeVisible();

  // Leave while the fill is still held.
  await byId(page, "pf-link-control").click();
  await expect(byId(page, "pf-control-value")).toHaveText("control.data:1");
  await expect(byId(page, "pf-unit-fallback")).toHaveCount(0);
  await expect.poll(() => aborted.length, "the fill was aborted").toBe(1);
  await fills.release();
  expect(
    pick(await hub.counts(), ["unit.handler", "unit.data"]),
    "the aborted fill ran nothing",
  ).toEqual({ "unit.handler": 0, "unit.data": 0 });

  await page.goBack();
  await expect(page).toHaveURL(hub.pageUrl("unit"));
  await expect(byId(page, "pf-unit-value")).toHaveText("unit.data:1");
  await expect(byId(page, "pf-unit-fallback")).toHaveCount(0);
  expect(pick(await hub.counts(), ["unit.handler", "unit.data"])).toEqual({
    "unit.handler": 1,
    "unit.data": 1,
  });
}

/**
 * One prefetch serves every click within its TTL, and each click that adopts
 * it sends its own fill: the flagged work is never served from the prefetch.
 */
export async function expectEveryAdoptionSendsItsOwnFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(
    page,
    fixture,
    { name: "loader", prefetched: ["loader.price", "loader.handler"] },
  );
  const requests = recordPartials(page, hub.pathname("loader"));

  await byId(page, "pf-link-hub").click();
  await expect(byId(page, "pf-hub")).toBeVisible();
  await byId(page, "pf-link-loader").click();
  await expect(byId(page, "pf-loader-value")).toHaveText("loader.data:2");
  await expect(byId(page, "pf-loader-price")).toHaveText("loader.price:1");

  expect(
    requests.map((request) => isFill(request.url())),
    "the second click sent a fill and nothing else",
  ).toEqual([true]);
  expect(
    pick(await hub.counts(), ["loader.data", "loader.price", "loader.handler"]),
  ).toEqual({ "loader.data": 2, "loader.price": 1, "loader.handler": 1 });
}

export interface PrefetchFalseScrollCase {
  /** The case name: the page is `/prefetch-false/<name>`. */
  name: string;
  /** Click the link a second time, from the case's own page. */
  samePage?: boolean;
  /** A route with no flag: the click sends no fill. */
  unflagged?: boolean;
}

/**
 * A click from a scrolled page ends at the top. Also when React holds the
 * adoption's commit until the fill returns, so the fill's update is the one
 * that commits: a read with no boundary to show a fallback in, or a second
 * click on the page's own link, whose boundaries are already revealed.
 */
export async function expectClickFromAScrolledPageEndsAtTheTop(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseScrollCase,
): Promise<void> {
  const { name } = spec;
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, name);
  let run = 1;
  if (spec.samePage) {
    await byId(page, `pf-link-${name}`).click();
    await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
    if (!spec.unflagged) run = 2;
  }

  const requests = recordPartials(page, hub.pathname(name));
  const fills = await holdFills(page);
  await page.addStyleTag({ content: "body { min-height: 4000px; }" });
  await page.evaluate(() => window.scrollTo(0, 600));
  expect(await page.evaluate(() => window.scrollY)).toBe(600);
  // A DOM click: Playwright's own would scroll the link into view first.
  await byId(page, `pf-link-${name}`).evaluate((link) =>
    (link as HTMLElement).click(),
  );
  if (!spec.unflagged) {
    await expect
      .poll(() => requests.filter((r) => isFill(r.url())).length)
      .toBe(1);
  }
  await fills.release();

  await expect(byId(page, `pf-${name}-value`)).toHaveText(
    `${name}.data:${run}`,
  );
  await expect(page).toHaveURL(hub.pageUrl(name));
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: "the click scrolled to the top",
    })
    .toBe(0);
}

/**
 * A click while the prefetch is still in flight adopts that prefetch when it
 * answers: one prefetch and one fill, and no navigation request of its own.
 */
export async function expectClickDuringThePrefetchAdoptsIt(
  page: Page,
  fixture: PrefetchFalseFixture,
  name: string,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname(name));
  await page.route(
    (url) =>
      isPartialFor(url.href, hub.pathname(name)) &&
      !url.searchParams.has("_rsc_fill"),
    async (route) => {
      if (route.request().headers()["x-rango-prefetch"] === "1") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.continue().catch(() => {});
    },
  );

  await byId(page, `pf-link-${name}`).hover();
  await expect.poll(() => requests.length, "the prefetch is in flight").toBe(1);
  await byId(page, `pf-link-${name}`).click();

  await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`, {
    timeout: 15_000,
  });
  expect(
    kindsOf(requests),
    "the click adopted the prefetch it found in flight",
  ).toEqual(["prefetch", "fill"]);
  expect((await hub.counts())[`${name}.data`]).toBe(1);
}

/**
 * Two quick clicks on one link are two adoptions of the one prefetch, and the
 * second replaces the first, its fill included. The page ends on the value of
 * the last fill, with no fallback left and no navigation request.
 */
export async function expectDoubleClickEndsOnTheLastFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("loader"));
  await prefetchCase(page, hub, "loader");

  await byId(page, "pf-link-loader").dblclick();
  await expect(page).toHaveURL(hub.pageUrl("loader"));
  // The first fill may or may not have reached the server before the second
  // click replaced it: the value on screen is the last run's either way.
  await expect
    .poll(
      async () => {
        const runs = (await hub.counts())["loader.data"] ?? 0;
        const value = await byId(page, "pf-loader-value")
          .textContent({ timeout: 250 })
          .catch(() => null);
        return runs > 0 && value === `loader.data:${runs}`;
      },
      { message: "the page shows the last fill", timeout: 15_000 },
    )
    .toBe(true);
  await expect(byId(page, "pf-loader-fallback")).toHaveCount(0);

  const kinds = kindsOf(requests);
  expect(kinds[0]).toBe("prefetch");
  expect(kinds).not.toContain("navigation");
  const fills = kinds.filter((kind) => kind === "fill").length;
  expect(fills, "one fill per adoption").toBeGreaterThanOrEqual(1);
  expect(fills).toBeLessThanOrEqual(2);
  expect(
    pick(await hub.counts(), ["loader.price", "loader.handler"]),
    "what the prefetch ran did not run again",
  ).toEqual({ "loader.price": 1, "loader.handler": 1 });
}

/**
 * Back and forward while the fill is in flight. Going back cancels the fill;
 * the entry returned to still holds its placeholders, so it is fetched, never
 * restored with a fallback nobody fills.
 */
export async function expectBackAndForwardDuringAFillEndOnTheFilledPage(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "unit");

  const fills = await holdFills(page);
  await byId(page, "pf-link-unit").click();
  await expect(page).toHaveURL(hub.pageUrl("unit"));
  await expect(byId(page, "pf-unit-fallback")).toBeVisible();

  await page.goBack();
  await expect(byId(page, "pf-hub")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(hub.pageUrl("unit"));
  await fills.release();

  await expect(byId(page, "pf-unit-value")).toHaveText("unit.data:1", {
    timeout: 15_000,
  });
  await expect(byId(page, "pf-unit-fallback")).toHaveCount(0);
  expect(pick(await hub.counts(), ["unit.handler", "unit.data"])).toEqual({
    "unit.handler": 1,
    "unit.data": 1,
  });
}

/**
 * A fill the network drops does not leave the fallback up: the router's
 * network error boundary takes over, as it does for a navigation that failed.
 */
export async function expectFailedFillReachesTheNetworkErrorBoundary(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "loader");
  await page.route(
    (url) => url.searchParams.has("_rsc_fill"),
    (route) => route.abort("failed"),
  );

  await byId(page, "pf-link-loader").click();
  await expect(
    page.getByRole("heading", { name: "Connection Error" }),
  ).toBeVisible();
  await expect(byId(page, "pf-loader-fallback")).toHaveCount(0);
  expect((await hub.counts())["loader.data"] ?? 0).toBe(0);
}
