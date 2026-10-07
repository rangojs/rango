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
 * `&slow=1` on the hub makes every `<c>.data` loader take 600 ms longer.
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
  /**
   * Test id of the fallback the click shows. Default `pf-<name>-fallback`; a
   * route deferred with a flagged layout above it shows the layout's.
   */
  fallback?: string;
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

function hubFor(
  page: Page,
  fixture: PrefetchFalseFixture,
  run: string,
  slow: boolean = false,
): Hub {
  const pathname = (name: string) => `/prefetch-false/${name}`;
  const query = `run=${run}${slow ? "&slow=1" : ""}`;
  return {
    run,
    pathname,
    pageUrl: (name) => fixture.url(`${pathname(name)}?${query}`),
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
  slow: boolean = false,
): Promise<Hub> {
  await page.goto(
    fixture.url(`/prefetch-false?run=${run}${slow ? "&slow=1" : ""}`),
  );
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
  await expect(byId(page, "pf-hub")).toBeVisible();
  return hubFor(page, fixture, run, slow);
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
  const fallback = spec.fallback ?? `pf-${name}-fallback`;
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
  await expect(byId(page, fallback)).toBeVisible();
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
  await expect(byId(page, fallback)).toHaveCount(0);
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
  /**
   * What reaches the page first. The body forces the order; it is never left
   * to timing.
   *
   * - `"fill"`: the fill's update, while React still holds the adoption's
   *   commit. React cannot commit a tree that suspends where no fallback can
   *   show: the route has no boundary, or (`samePage`) the click is on the
   *   page's own link, whose boundary is already revealed. The fill is held
   *   meanwhile, and the body checks that nothing of the adoption is on screen.
   * - `"fallback"`: the adoption's commit. The fill is held until the fallback
   *   is on screen.
   * - `"none"`: a route with no flag. The click sends no fill.
   */
  first: "fill" | "fallback" | "none";
  /** Click the link a second time, from the case's own page. */
  samePage?: boolean;
  /**
   * `first: "fallback"` only: scroll down again while the fallback shows. The
   * fill must leave that position alone, so the page ends there, not at the
   * top.
   */
  scrollWhileWaiting?: boolean;
}

/**
 * A click from a scrolled page scrolls to the top, once, whichever of the
 * adoption's commit and the fill reaches the page first. Scroll belongs to
 * the navigation; a fill says nothing about it.
 *
 * Scar tissue: the fill used to carry "do not scroll", and it replaced the
 * navigation's pending scroll whenever it reached the page before React had
 * committed the adoption. The fill's update is emitted on the first chunk of
 * its response, a few milliseconds after the click, so from the hub that was
 * a race the fill usually won.
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
    run = 2;
  }

  const requests = recordPartials(page, hub.pathname(name));
  const fills = await holdFills(page);
  const scrollY = () => page.evaluate(() => window.scrollY);
  const scrollTo = async (y: number) => {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    expect(await scrollY(), `the page can scroll to ${y}`).toBe(y);
  };
  await page.addStyleTag({ content: "body { min-height: 4000px; }" });
  await scrollTo(600);
  // A DOM click: Playwright's own would scroll the link into view first.
  await byId(page, `pf-link-${name}`).evaluate((link) =>
    (link as HTMLElement).click(),
  );

  if (spec.first !== "none") {
    await expect
      .poll(
        () => requests.filter((r) => isFill(r.url())).length,
        "the fill is in flight, and held",
      )
      .toBe(1);
  }
  if (spec.first === "fill") {
    // Long enough for a fallback React meant to show to be on screen.
    await page.waitForTimeout(500);
    await expect(
      byId(page, `pf-${name}-fallback`),
      "React holds the adoption's commit: no fallback",
    ).toHaveCount(0);
    if (spec.samePage) {
      await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
    } else {
      await expect(byId(page, "pf-hub")).toBeVisible();
      await expect(byId(page, `pf-${name}-page`)).toHaveCount(0);
    }
  }
  if (spec.first === "fallback") {
    await expect(byId(page, `pf-${name}-fallback`)).toBeVisible();
    await expect
      .poll(scrollY, "the adoption's commit scrolled to the top")
      .toBe(0);
    if (spec.scrollWhileWaiting) await scrollTo(300);
  }
  await fills.release();

  await expect(byId(page, `pf-${name}-value`)).toHaveText(
    `${name}.data:${run}`,
  );
  await expect(byId(page, `pf-${name}-fallback`)).toHaveCount(0);
  await expect(page).toHaveURL(hub.pageUrl(name));
  // Past the layout effect of the commit that showed the value.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  if (spec.scrollWhileWaiting) {
    expect(await scrollY(), "the fill did not scroll").toBe(300);
  } else {
    await expect
      .poll(scrollY, { message: "the click scrolled to the top" })
      .toBe(0);
  }
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
 * second replaces the first, its fill included. The page ends on what the
 * last adoption's fill returned, with no fallback left and no navigation
 * request.
 *
 * "The last fill" is the last one the page sent, not the highest run count.
 * The two fills leave a millisecond apart and the first is aborted only after
 * it is on the wire, so the server can start them in either order (it did, 1
 * run in 30 on workerd). The body reads each fill's answer itself and
 * compares the page with the one the last request got.
 */
export async function expectDoubleClickEndsOnTheLastFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("loader"));
  await prefetchCase(page, hub, "loader");

  // One entry per fill, in the order the page sent them.
  const answers: Array<{ run?: string }> = [];
  await page.route(
    (url) => url.searchParams.has("_rsc_fill"),
    async (route) => {
      const answer: { run?: string } = {};
      answers.push(answer);
      try {
        const response = await route.fetch();
        const body = await response.text();
        answer.run = /"name":"loader\.data","n":(\d+)/.exec(body)?.[1];
        await route.fulfill({ response, body });
      } catch {
        // The page aborted this fill: the next adoption replaced it.
      }
    },
  );

  await byId(page, "pf-link-loader").dblclick();
  await expect(page).toHaveURL(hub.pageUrl("loader"));
  // Both adoptions have sent what they send once the network is quiet.
  await page.waitForLoadState("networkidle");
  const last = answers[answers.length - 1];
  expect(last?.run, "the last adoption's fill was answered").toBeDefined();
  await expect(
    byId(page, "pf-loader-value"),
    "the page shows what the last adoption's fill returned",
  ).toHaveText(`loader.data:${last!.run}`);
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

/**
 * A fill answered with something the client cannot use (here a 500 with a
 * text body) ends like a navigation answered that way: the router's error
 * boundary replaces the page, no fallback is left waiting, and nothing is
 * thrown outside React. Call it under the suite's page-error guard.
 */
export async function expectUnusableFillReachesTheErrorBoundary(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "loader");
  await page.route(
    (url) => url.searchParams.has("_rsc_fill"),
    (route) =>
      route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }),
  );

  await byId(page, "pf-link-loader").click();
  await expect(
    page.getByRole("heading", { name: "Internal Server Error" }),
  ).toBeVisible();
  await expect(byId(page, "pf-loader-fallback")).toHaveCount(0);
  await expect(byId(page, "pf-loader-value")).toHaveCount(0);
  // Long enough for a rejection nobody handles to be reported.
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// The flag applies only to a segment the client does not have yet
// ---------------------------------------------------------------------------

/** What `watchPage` saw between its start and its `stop()`. */
export interface PrefetchFalseObservation {
  /**
   * Every fallback that was visible at some point: `pf-*-fallback`, and a
   * route's own `pf-*-loading`.
   */
  fallbacks: string[];
  /** Held elements that were detached or not visible at some point. */
  hidden: string[];
  /** The page box (`pf-outlet`) had nothing visible in it at some point. */
  blank: boolean;
  /**
   * What the page box showed, one entry per change: the visible `pf-*`
   * elements in it, leaves with their text.
   */
  timeline: string[];
  /** When each `timeline` entry began, in ms since the watch started. */
  times: number[];
  /** `pf-*` test ids in the order they first became visible. */
  order: string[];
  /** When each `order` entry became visible, in ms since the watch started. */
  seenAt: number[];
  /** useNavigation() as `state/isStreaming`, one entry per change. */
  nav: string[];
  /** Calls of document.startViewTransition. */
  viewTransitions: number;
}

/**
 * Record what a reader could see from now until `stop()`. Installed in the
 * page before the click, on a MutationObserver and a frame poll, so a state
 * that shows for one frame is recorded: an assertion made after the fact
 * would miss it.
 *
 * `held`: test ids of elements on screen now that the next page keeps. Each
 * is watched by node identity: detached, replaced or hidden counts.
 */
async function watchPage(
  page: Page,
  held: string[],
): Promise<{ stop: () => Promise<PrefetchFalseObservation> }> {
  await page.evaluate((heldIds) => {
    const visible = (el: Element | null): boolean =>
      el !== null && el.isConnected && el.getClientRects().length > 0;
    const find = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`);
    const heldNodes = heldIds.map((id) => [id, find(id)] as const);
    const fallbacks = new Set<string>();
    const hidden = new Set<string>();
    const order: string[] = [];
    const seenAt: number[] = [];
    const timeline: string[] = [];
    const times: number[] = [];
    const started = performance.now();
    const nav: string[] = [];
    let blank = false;
    let viewTransitions = 0;

    // Untyped on purpose: older DOM typings lack the method.
    const doc = document as unknown as {
      startViewTransition?: (...args: unknown[]) => unknown;
    };
    const startViewTransition = doc.startViewTransition;
    if (startViewTransition) {
      doc.startViewTransition = function (...args: unknown[]) {
        viewTransitions++;
        return startViewTransition.apply(document, args);
      };
    }

    const sample = (): void => {
      for (const el of document.querySelectorAll('[data-testid^="pf-"]')) {
        if (!visible(el)) continue;
        const id = el.getAttribute("data-testid")!;
        if (id.startsWith("pf-link-")) continue;
        if (!order.includes(id)) {
          order.push(id);
          seenAt.push(Math.round(performance.now() - started));
        }
        if (id.endsWith("-fallback") || id.endsWith("-loading")) {
          fallbacks.add(id);
        }
      }
      for (const [id, node] of heldNodes) {
        if (!visible(node)) hidden.add(id);
      }
      const outlet = find("pf-outlet");
      const shown = outlet
        ? [...outlet.querySelectorAll('[data-testid^="pf-"]')]
            .filter(visible)
            .map((el) => {
              const id = el.getAttribute("data-testid")!;
              return el.childElementCount === 0
                ? `${id}=${el.textContent}`
                : id;
            })
        : [];
      if (shown.length === 0) blank = true;
      const snapshot = shown.join(" ");
      if (timeline[timeline.length - 1] !== snapshot) {
        timeline.push(snapshot);
        times.push(Math.round(performance.now() - started));
      }
      const state = find("pf-nav");
      const reading = `${state?.getAttribute("data-state")}/${state?.getAttribute("data-streaming")}`;
      if (nav[nav.length - 1] !== reading) nav.push(reading);
    };

    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    let frame = 0;
    const poll = (): void => {
      sample();
      frame = requestAnimationFrame(poll);
    };
    poll();

    (window as unknown as { __pfWatch: () => unknown }).__pfWatch = () => {
      sample();
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (startViewTransition) doc.startViewTransition = startViewTransition;
      return {
        fallbacks: [...fallbacks].sort(),
        hidden: [...hidden].sort(),
        blank,
        timeline,
        times,
        order,
        seenAt,
        nav,
        viewTransitions,
      };
    };
  }, held);
  return {
    stop: () =>
      page.evaluate(() =>
        (
          window as unknown as { __pfWatch: () => PrefetchFalseObservation }
        ).__pfWatch(),
      ),
  };
}

/** Click a hub link without moving the mouse, so nothing is prefetched. */
async function clickWithoutHover(page: Page, name: string): Promise<void> {
  await byId(page, `pf-link-${name}`).evaluate((link) =>
    (link as HTMLElement).click(),
  );
}

/** The router is idle and no stream is open: the page has settled. */
async function settled(page: Page): Promise<void> {
  await expect(byId(page, "pf-nav")).toHaveAttribute("data-state", "idle");
  await expect(byId(page, "pf-nav")).toHaveAttribute("data-streaming", "false");
}

/**
 * Inside a section whose layout has a flagged `loading()`, the client holds
 * the layout, so its flag has no say: a route with no flag of its own is
 * prefetched whole and the click sends nothing, while a route that is new
 * and has its own flagged `loading()` is still its own unit. The section
 * layout stays on screen throughout, and never re-renders.
 */
export async function expectHeldFlaggedLayoutLeavesRoutesToTheirOwnFlags(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "section");
  await byId(page, "pf-link-section").click();
  await expect(byId(page, "pf-section-value")).toHaveText("section.data:1");
  await settled(page);
  const section = await byId(page, "pf-section-layout").elementHandle();
  const work = [
    "section.layout",
    "section-plain.handler",
    "section-plain.data",
    "section-own.handler",
    "section-own.data",
  ];
  const zero = Object.fromEntries(work.map((name) => [name, 0]));
  const counts = async () => ({ ...zero, ...pick(await hub.counts(), work) });

  // No loading() of its own: the handler and the loader run in the prefetch.
  const plain = recordPartials(page, hub.pathname("section-plain"));
  await prefetchCase(page, hub, "section-plain");
  expect(await counts(), "the prefetch ran the route whole").toEqual({
    ...zero,
    "section.layout": 1,
    "section-plain.handler": 1,
    "section-plain.data": 1,
  });
  let watch = await watchPage(page, ["pf-layout", "pf-section-layout"]);
  await byId(page, "pf-link-section-plain").click();
  await expect(byId(page, "pf-section-plain-value")).toHaveText(
    "section-plain.data:1",
  );
  await expect(page).toHaveURL(hub.pageUrl("section-plain"));
  await settled(page);
  let seen = await watch.stop();
  expect(kindsOf(plain), "the click sent nothing").toEqual(["prefetch"]);
  expect(seen.fallbacks, "no fallback showed").toEqual([]);
  expect(seen.hidden, "the section stayed on screen").toEqual([]);
  expect(await counts(), "the click ran nothing").toEqual({
    ...zero,
    "section.layout": 1,
    "section-plain.handler": 1,
    "section-plain.data": 1,
  });

  // Its own flagged loading(): a unit of its own, fetched by the click.
  const own = recordPartials(page, hub.pathname("section-own"));
  await prefetchCase(page, hub, "section-own");
  expect(
    pick(await counts(), ["section-own.handler", "section-own.data"]),
    "the prefetch skipped the route",
  ).toEqual({ "section-own.handler": 0, "section-own.data": 0 });
  const fills = await holdFills(page);
  watch = await watchPage(page, ["pf-layout", "pf-section-layout"]);
  await byId(page, "pf-link-section-own").click();
  await expect(byId(page, "pf-section-own-fallback")).toBeVisible();
  await expect(byId(page, "pf-section-layout")).toBeVisible();
  await expect.poll(() => own.filter((r) => isFill(r.url())).length).toBe(1);
  await fills.release();
  await expect(byId(page, "pf-section-own-value")).toHaveText(
    "section-own.data:1",
  );
  await settled(page);
  seen = await watch.stop();
  expect(kindsOf(own), "one prefetch, then one fill").toEqual([
    "prefetch",
    "fill",
  ]);
  expect(seen.fallbacks).toEqual(["pf-section-own-fallback"]);
  expect(seen.hidden, "the section stayed on screen").toEqual([]);
  expect(await counts(), "the fill ran the route once").toEqual({
    "section.layout": 1,
    "section-plain.handler": 1,
    "section-plain.data": 1,
    "section-own.handler": 1,
    "section-own.data": 1,
  });
  expect(
    await section!.evaluate((node) => node.isConnected),
    "the section layout was never remounted",
  ).toBe(true);
}

/**
 * A prefetch is answered for the page that sent it, and the browser may
 * adopt it on another (the prefetch cache is not keyed by the source page).
 * Taken on the hub, where the section layout is new, a prefetch defers the
 * layout as a unit; adopted inside the section, that unit is a layout the
 * page shows. Its content must stay: no fallback over it, never detached,
 * and the click still ends on the new page after one fill.
 */
export async function expectPrefetchFromAnotherPageKeepsWhatIsOnScreen(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  for (const name of ["section-plain", "section-own"]) {
    const hub = await openHub(page, fixture);
    await prefetchCase(page, hub, name);
    await prefetchCase(page, hub, "section");
    await byId(page, "pf-link-section").click();
    await expect(byId(page, "pf-section-value")).toHaveText("section.data:1");
    await settled(page);
    const layoutRuns = (await hub.counts())["section.layout"];

    const requests = recordPartials(page, hub.pathname(name));
    const fills = await holdFills(page);
    const watch = await watchPage(page, ["pf-layout", "pf-section-layout"]);
    await clickWithoutHover(page, name);
    await expect
      .poll(() => requests.filter((r) => isFill(r.url())).length)
      .toBe(1);
    // Long enough for a fallback React meant to show to be on screen.
    await page.waitForTimeout(400);
    await expect(
      byId(page, "pf-section-value"),
      `${name}: the page being left stays while the fill is in flight`,
    ).toHaveText("section.data:1");
    await fills.release();
    await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
    await expect(page).toHaveURL(hub.pageUrl(name));
    await settled(page);
    const seen = await watch.stop();

    expect(kindsOf(requests), `${name}: the hub's prefetch, one fill`).toEqual([
      "fill",
    ]);
    expect(
      seen.fallbacks.filter((id) => id !== `pf-${name}-fallback`),
      `${name}: no fallback over what was on screen`,
    ).toEqual([]);
    expect(seen.hidden, `${name}: the section stayed on screen`).toEqual([]);
    expect(seen.blank, `${name}: the page was never blank`).toBe(false);
    expect(
      (await hub.counts())["section.layout"],
      `${name}: the fill rendered the layout the prefetch had skipped`,
    ).toBe(layoutRuns + 1);
  }
}

/**
 * A `cache()` route under a flagged layout uses its record. With the layout
 * held nothing above the record is skipped, so the prefetch reads and writes
 * it like any request: the same prefetch three times runs the handler once.
 *
 * Scar tissue: whether the layout could be skipped was decided per tree, so
 * every prefetch of the tree bypassed the record and ran the handler.
 */
export async function expectCachedRouteUnderHeldFlaggedLayoutUsesItsRecord(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "section");
  await byId(page, "pf-link-section").click();
  await expect(byId(page, "pf-section-value")).toHaveText("section.data:1");
  await settled(page);

  const requests = recordPartials(page, hub.pathname("section-cached"));
  await prefetchCase(page, hub, "section-cached");
  expect(kindsOf(requests)).toEqual(["prefetch"]);
  const prefetch = requests[0];
  const headers = await prefetch.allHeaders();
  const handlerRuns = async () =>
    (await hub.counts())["section-cached.handler"] ?? 0;
  // The browser keeps its prefetch: this sends the same request again.
  const prefetchAgain = async () => {
    const response = await page.request.get(prefetch.url(), { headers });
    expect(response.ok()).toBe(true);
    expect(await response.text(), "nothing is deferred").not.toContain(
      '"deferred":true',
    );
  };

  // The first prefetch writes the record once its response has streamed:
  // ask until a request is served from it, then twice more.
  await expect
    .poll(
      async () => {
        const before = await handlerRuns();
        await prefetchAgain();
        return (await handlerRuns()) - before;
      },
      { message: "a prefetch is served from the record", timeout: 10_000 },
    )
    .toBe(0);
  const stored = await handlerRuns();
  await prefetchAgain();
  await prefetchAgain();
  expect(
    pick(await hub.counts(), ["section-cached.handler", "section.layout"]),
    "the record is used, and the held layout does not run",
  ).toEqual({ "section-cached.handler": stored, "section.layout": 1 });

  await byId(page, "pf-link-section-cached").click();
  await expect(byId(page, "pf-section-cached-value")).toHaveText(
    "section-cached.data:1",
  );
  expect(kindsOf(requests), "the click sent nothing").toEqual(["prefetch"]);
  expect(await handlerRuns()).toBe(stored);
}

/**
 * A same-route navigation (`item/a` to `item/b`): the client holds the route
 * and its loader segment, so nothing is deferred. The prefetch runs the
 * flagged loader, the click sends no fill, no fallback shows at any point
 * and the old content stays until the new content replaces it. The route's
 * twin without the flag must show the very same sequence.
 */
export async function expectSameRouteNavigationIsNeverDeferred(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const run = async (name: "item" | "item-twin") => {
    const hub = await openHub(page, fixture);
    await prefetchCase(page, hub, `${name}/a`);
    await byId(page, `pf-link-${name}/a`).click();
    await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
    await expect(byId(page, `pf-${name}-id`)).toHaveText("a");
    await settled(page);

    const requests = recordPartials(page, hub.pathname(`${name}/b`));
    await prefetchCase(page, hub, `${name}/b`);
    expect(
      pick(await hub.counts(), [`${name}.data`, `${name}.handler`]),
      "the prefetch ran the handler and the loader",
    ).toEqual({ [`${name}.data`]: 2, [`${name}.handler`]: 2 });

    const watch = await watchPage(page, ["pf-layout"]);
    await byId(page, `pf-link-${name}/b`).click();
    await expect(byId(page, `pf-${name}-id`)).toHaveText("b");
    await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:2`);
    await expect(page).toHaveURL(hub.pageUrl(`${name}/b`));
    await settled(page);
    const seen = await watch.stop();

    expect(kindsOf(requests), `${name}: the click sent nothing`).toEqual([
      "prefetch",
    ]);
    expect(
      pick(await hub.counts(), [`${name}.data`, `${name}.handler`]),
      `${name}: the click ran nothing`,
    ).toEqual({ [`${name}.data`]: 2, [`${name}.handler`]: 2 });
    expect(seen.fallbacks, `${name}: no fallback at any point`).toEqual([]);
    expect(seen.blank, `${name}: the page was never blank`).toBe(false);
    expect(seen.hidden, `${name}: the layout was never hidden`).toEqual([]);
    expect(seen.timeline[0], `${name}: starts on the old content`).toBe(
      `pf-${name}-page pf-${name}-id=a pf-${name}-value=${name}.data:1`,
    );
    expect(
      seen.timeline[seen.timeline.length - 1],
      `${name}: ends on the new content`,
    ).toBe(`pf-${name}-page pf-${name}-id=b pf-${name}-value=${name}.data:2`);
    // The flagged route and its twin must read the same.
    const neutral = (text: string) => text.split(name).join("item");
    return {
      timeline: seen.timeline.map(neutral),
      nav: seen.nav,
      kinds: kindsOf(requests),
    };
  };

  const twin = await run("item-twin");
  const flagged = await run("item");
  expect(
    flagged,
    "the flag changes nothing on a same-route navigation",
  ).toEqual(twin);
}

export interface PrefetchFalseParityCase {
  /** The destination case: the page is `/prefetch-false/<name>`. */
  name: string;
  /** The case to stand on before the click. Default: the hub. */
  from?: string;
  /**
   * Test ids on screen before the click that the destination keeps, beside
   * the fixture layout (a section layout when moving inside the section).
   */
  held?: string[];
  /**
   * Run with `&slow=1`: the deferred loader outlasts everything else. For a
   * flagged read with a boundary of its own inside the route's `loading()`:
   * React keeps the route's fallback up for 300 ms before it reveals the
   * page, so a plain navigation only gets to show the inner fallback when
   * the read is slower than that.
   */
  slow?: boolean;
  /**
   * Where the destination's prefetch is taken. Default: on the page the
   * click happens on. `"hub"`: on the hub, before moving to `from`. The
   * browser's prefetch cache is not keyed by the source page, so the click
   * adopts a payload the server answered for another page: one that defers
   * segments the page now holds.
   */
  prefetchedOn?: "hub";
  /**
   * The stem of the destination's test ids when it is not the name: a param
   * route's `item/b` renders `pf-item-*`. `from` takes the same stem.
   */
  stem?: string;
}

/** The fixture's cases, as `expectAdoptedClickIsNeverWorseThanAPlainClick` runs them. */
export const PREFETCH_FALSE_PARITY_CASES: PrefetchFalseParityCase[] = [
  { name: "loader", slow: true },
  { name: "unit" },
  { name: "section" },
  { name: "section-plain" },
  { name: "section-own" },
  { name: "section-cached" },
  { name: "slot" },
  { name: "bare" },
  { name: "handle" },
  { name: "cached" },
  { name: "prerendered" },
  { name: "ppr" },
  { name: "ssr-false" },
  { name: "vt" },
  { name: "control" },
  { name: "section-plain", from: "section", held: ["pf-section-layout"] },
  { name: "section-own", from: "section", held: ["pf-section-layout"] },
  { name: "section-cached", from: "section", held: ["pf-section-layout"] },
  // A same-route navigation: the page holds the route and its loader.
  { name: "item/b", from: "item/a", stem: "item" },
  // A prefetch the server answered for the hub, adopted on a page that holds
  // what it deferred: the loader of the same route, the section layout.
  { name: "item/b", from: "item/a", stem: "item", prefetchedOn: "hub" },
  {
    name: "section-plain",
    from: "section",
    held: ["pf-section-layout"],
    prefetchedOn: "hub",
  },
  {
    name: "section-own",
    from: "section",
    held: ["pf-section-layout"],
    prefetchedOn: "hub",
  },
];

/**
 * The invariant: a click that adopts a prefetch with deferred units is never
 * worse than the same click with no prefetch at all. The body does the click
 * twice on fresh pages, once as a plain navigation (the link is clicked
 * without being hovered) and once after its prefetch has been received, and
 * records each from before the click until the router is idle again.
 *
 * - A fallback shows with the prefetch only where the plain navigation
 *   shows the same fallback.
 * - Content that was on screen and belongs to the new page is never
 *   detached or hidden, and the page is never blank.
 * - The fill starts no view transition of its own.
 *
 * Returns both records, for a case that pins more.
 */
export async function expectAdoptedClickIsNeverWorseThanAPlainClick(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseParityCase,
): Promise<{
  plain: PrefetchFalseObservation;
  adopted: PrefetchFalseObservation;
}> {
  const { plain, adopted } = await recordPlainAndAdoptedClick(
    page,
    fixture,
    spec,
  );
  const where = `${spec.from ?? "hub"} to ${spec.name}`;
  expect(
    adopted.fallbacks.filter((id) => !plain.fallbacks.includes(id)),
    `${where}: a fallback the plain navigation does not show`,
  ).toEqual([]);
  expect(
    adopted.hidden,
    `${where}: content on screen was detached or hidden`,
  ).toEqual([]);
  expect(adopted.blank, `${where}: the page was blank`).toBe(false);
  expect(
    adopted.viewTransitions,
    `${where}: a view transition the plain navigation does not start`,
  ).toBeLessThanOrEqual(plain.viewTransitions);
  return { plain, adopted };
}

/** The two clicks of `expectAdoptedClickIsNeverWorseThanAPlainClick`. */
export async function recordPlainAndAdoptedClick(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseParityCase,
): Promise<{
  plain: PrefetchFalseObservation;
  adopted: PrefetchFalseObservation;
}> {
  const held = ["pf-layout", ...(spec.held ?? [])];
  const click = async (prefetched: boolean) => {
    const hub = await openHub(page, fixture, undefined, spec.slow);
    const early = prefetched && spec.prefetchedOn === "hub";
    if (early) await prefetchCase(page, hub, spec.name);
    if (spec.from) {
      await prefetchCase(page, hub, spec.from);
      await byId(page, `pf-link-${spec.from}`).click();
      await expect(
        byId(page, `pf-${spec.stem ?? spec.from}-value`),
      ).toBeVisible();
      await expect(page).toHaveURL(hub.pageUrl(spec.from));
      await settled(page);
    }
    if (prefetched && !early) await prefetchCase(page, hub, spec.name);
    const watch = await watchPage(page, held);
    await clickWithoutHover(page, spec.name);
    await expect(page).toHaveURL(hub.pageUrl(spec.name));
    await expect(
      byId(page, `pf-${spec.stem ?? spec.name}-value`),
    ).toBeVisible();
    await settled(page);
    return watch.stop();
  };

  const plain = await click(false);
  const adopted = await click(true);
  return { plain, adopted };
}

/**
 * What `useNavigation()` reads while a fill is in flight: `idle` and
 * `isStreaming: true`, which is what it reads on a plain navigation that has
 * committed and whose loader is still streaming. It never reads `loading`
 * for a fill: the page has committed.
 */
export async function expectPendingFillReadsLikeAStreamingNavigation(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const reading = async () => ({
    state: await byId(page, "pf-nav").getAttribute("data-state"),
    isStreaming: await byId(page, "pf-nav").getAttribute("data-streaming"),
  });

  // A plain navigation, its loader 700 ms away.
  let hub = await openHub(page, fixture, undefined, true);
  await clickWithoutHover(page, "unit");
  await expect(byId(page, "pf-unit-fallback")).toBeVisible();
  const streaming = await reading();
  expect(streaming).toEqual({ state: "idle", isStreaming: "true" });
  await expect(byId(page, "pf-unit-value")).toBeVisible();
  await settled(page);

  // The same click with the prefetch adopted, its fill held.
  hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "unit");
  const fills = await holdFills(page);
  await byId(page, "pf-link-unit").click();
  await expect(byId(page, "pf-unit-fallback")).toBeVisible();
  await expect.poll(reading).toEqual(streaming);
  // Still, a moment later: it is not on its way to another reading.
  await page.waitForTimeout(100);
  expect(await reading()).toEqual(streaming);

  await fills.release();
  await expect(byId(page, "pf-unit-value")).toBeVisible();
  await settled(page);
}
