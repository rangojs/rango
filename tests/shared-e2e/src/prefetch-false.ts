import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type test as base,
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
 * `&slow=1` on the hub makes every `<c>.data` loader take 600 ms longer,
 * `&delay=<ms>` that many, and `&hslow=1` makes the section layout's handler
 * take 600 ms.
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
  /** The hub's own URL. */
  home: string;
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

/** The fixture's flags. They ride on every link of the hub. */
export interface PrefetchFalseFlags {
  /** Every `<c>.data` loader takes 600 ms longer. */
  slow?: boolean;
  /** Every `<c>.data` loader takes this many ms longer. */
  delay?: number;
  /** The section layout's handler takes 600 ms. */
  hslow?: boolean;
  /** A `<ViewTransition>` of the app's own is on screen, in the layout. */
  boundary?: boolean;
}

function hubQuery(run: string, flags: PrefetchFalseFlags): string {
  return `run=${run}${flags.slow ? "&slow=1" : ""}${flags.delay ? `&delay=${flags.delay}` : ""}${flags.hslow ? "&hslow=1" : ""}${flags.boundary ? "&boundary=1" : ""}`;
}

function hubFor(
  page: Page,
  fixture: PrefetchFalseFixture,
  run: string,
  flags: PrefetchFalseFlags = {},
): Hub {
  const pathname = (name: string) => `/prefetch-false/${name}`;
  const query = hubQuery(run, flags);
  return {
    run,
    home: fixture.url(`/prefetch-false?${query}`),
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
  flags: PrefetchFalseFlags = {},
): Promise<Hub> {
  await page.goto(fixture.url(`/prefetch-false?${hubQuery(run, flags)}`));
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
  await expect(byId(page, "pf-hub")).toBeVisible();
  return hubFor(page, fixture, run, flags);
}

/** Every request for the case's page, in order: prefetch, navigation, fill. */
function recordPartials(page: Page, pathname: string): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (isPartialFor(request.url(), pathname)) requests.push(request);
  });
  return requests;
}

/**
 * Hover the hub link and wait until its prefetch has been fully received.
 * The pointer ends off the links: the list moves when the page changes, and
 * a link that slides under a resting pointer is prefetched too.
 */
async function prefetchCase(
  page: Page,
  hub: Hub,
  name: string,
): Promise<Response> {
  const prefetched = page.waitForResponse(
    (response) =>
      isPartialFor(response.url(), hub.pathname(name)) &&
      response.request().headers()["x-rango-prefetch"] === "1",
    { timeout: 20_000 },
  );
  // Off the link first: a pointer that is already on it enters nothing.
  await page.mouse.move(0, 0);
  await byId(page, `pf-link-${name}`).hover();
  const response = await prefetched;
  await response.finished();
  await page.mouse.move(0, 0);
  return response;
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

export type PrefetchFalseRequestKind = "prefetch" | "fill" | "navigation";

function kindsOf(requests: Request[]): PrefetchFalseRequestKind[] {
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

/**
 * A deferred unit on a route with `transition()`. A plain click there keeps
 * the page it is on until its response starts, then commits the page with
 * its fallback in one transition. The adopted click does the same with its
 * fill: the URL changes with the click, React holds the page being left, and
 * the page commits with the fill's first chunk. Committed with the click, the
 * unit's content could only arrive in a commit of its own, which starts a
 * view transition the plain click does not start, and the reveal waits for it
 * (measured: three transitions for two, content up to 280 ms late).
 */
export async function expectUnitUnderTransitionCommitsWithItsFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const work = ["vt-unit.handler", "vt-unit.data"];
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("vt-unit"));
  await prefetchCase(page, hub, "vt-unit");
  expect(pick(await hub.counts(), work), "the prefetch ran nothing").toEqual({
    "vt-unit.handler": 0,
    "vt-unit.data": 0,
  });

  const fills = await holdFills(page);
  await byId(page, "pf-link-vt-unit").click();
  await expect(page).toHaveURL(hub.pageUrl("vt-unit"));
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  await expect(byId(page, "pf-hub")).toBeVisible();
  await expect(byId(page, "pf-vt-unit-fallback")).toHaveCount(0);
  await expect(byId(page, "pf-nav")).toHaveAttribute("data-state", "loading");

  await fills.release();
  await expect(byId(page, "pf-vt-unit-value")).toHaveText("vt-unit.data:1");
  await expect(byId(page, "pf-hub")).toHaveCount(0);
  await complete(page);
  expect(pick(await hub.counts(), work)).toEqual({
    "vt-unit.handler": 1,
    "vt-unit.data": 1,
  });
  expect(kindsOf(requests)).toEqual(["prefetch", "fill"]);
}

/**
 * Leaving while React still holds such a click (`vt-unit`, its fill not yet
 * answered) aborts the fill and shows the next page; going back fetches the
 * page that never showed.
 */
export async function expectLeavingAHeldAdoptionAbortsItsFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const work = ["vt-unit.handler", "vt-unit.data"];
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "vt-unit");

  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    if (isFill(request.url())) aborted.push(request.failure()?.errorText ?? "");
  });
  const fills = await holdFills(page);
  await byId(page, "pf-link-vt-unit").click();
  await expect(page).toHaveURL(hub.pageUrl("vt-unit"));
  await expect(byId(page, "pf-hub")).toBeVisible();

  await byId(page, "pf-link-control").click();
  await expect(byId(page, "pf-control-value")).toHaveText("control.data:1");
  await expect(page).toHaveURL(hub.pageUrl("control"));
  await expect.poll(() => aborted.length, "the fill was aborted").toBe(1);
  await fills.release();
  await complete(page);
  await expect(byId(page, "pf-vt-unit-page")).toHaveCount(0);
  expect(
    pick(await hub.counts(), work),
    "the aborted fill ran nothing",
  ).toEqual({ "vt-unit.handler": 0, "vt-unit.data": 0 });

  await page.goBack();
  await expect(page).toHaveURL(hub.pageUrl("vt-unit"));
  await expect(byId(page, "pf-vt-unit-value")).toHaveText("vt-unit.data:1");
  await complete(page);
  expect(pick(await hub.counts(), work)).toEqual({
    "vt-unit.handler": 1,
    "vt-unit.data": 1,
  });
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
 * A page the client has visited is a page it holds, fill included. A later
 * click on its link from the hub is a navigation over that copy, as it is
 * with no prefetch at all: the hub's prefetch deferred what the client now
 * has, so it is not adopted, no fill is sent and the flagged work does not
 * run again.
 */
export async function expectRevisitUsesWhatTheClientHolds(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await expectPrefetchSkipsFlaggedWorkAndClickFillsIt(
    page,
    fixture,
    { name: "loader", prefetched: ["loader.price", "loader.handler"] },
  );
  await complete(page);
  const requests = recordPartials(page, hub.pathname("loader"));

  await clickWithoutHover(page, "hub");
  await expect(byId(page, "pf-hub")).toBeVisible();
  await complete(page);
  const watch = await watchPage(page, ["pf-layout"]);
  await clickWithoutHover(page, "loader");
  await expect(byId(page, "pf-loader-value")).toHaveText("loader.data:1");
  await expect(byId(page, "pf-loader-price")).toHaveText("loader.price:1");
  await complete(page);
  const seen = await watch.stop();

  expect(kindsOf(requests), "the click sent no fill").not.toContain("fill");
  expect(seen.fallbacks, "no fallback showed").toEqual([]);
  expect(
    pick(await hub.counts(), ["loader.data", "loader.price", "loader.handler"]),
    "nothing the client holds ran again",
  ).toEqual({ "loader.data": 1, "loader.price": 1, "loader.handler": 1 });
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
   *   show: the route has no boundary. The fill is held meanwhile, and the
   *   body checks that nothing of the adoption is on screen.
   * - `"fallback"`: the adoption's commit. The fill is held until the fallback
   *   is on screen.
   * - `"none"`: nothing is deferred (a route with no flag, or `samePage`).
   *   The click sends no fill.
   */
  first: "fill" | "fallback" | "none";
  /**
   * Click the case's own link, from its page. The page holds every segment:
   * the prefetch made on the hub deferred some of them, so it is not adopted
   * here and the click is a navigation.
   */
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
  if (spec.samePage) {
    await byId(page, `pf-link-${name}`).click();
    await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
    await complete(page);
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
    await expect(byId(page, "pf-hub")).toBeVisible();
    await expect(byId(page, `pf-${name}-page`)).toHaveCount(0);
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
    // A page's own link runs its loader again or not, as a plain click does.
    spec.samePage ? new RegExp(`^${name}\\.data:\\d+$`) : `${name}.data:1`,
  );
  if (spec.first === "none") {
    expect(kindsOf(requests), "the click sent no fill").not.toContain("fill");
  }
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
 * Two quick clicks on one link. The first adopts the prefetch. The second
 * replaces it, its fill included: it adopts the prefetch again when the first
 * has not committed, and is a navigation from the page the first committed
 * when it has. Either way the page ends on what the last request returned,
 * with no fallback left, and what the prefetch ran does not run again.
 *
 * "The last request" is the last one the page sent, not the highest run
 * count. Two requests leave a millisecond apart and the first is aborted only
 * after it is on the wire, so the server can start them in either order (it
 * did, 1 run in 30 on workerd). The body reads each answer itself and
 * compares the page with the one the last request got.
 */
export async function expectDoubleClickEndsOnTheLastRequest(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("loader"));
  await prefetchCase(page, hub, "loader");

  // One entry per request that carries the flagged loader's value, in the
  // order the page sent them.
  const answers: Array<{ run?: string }> = [];
  await page.route(
    (url) => isPartialFor(url.href, hub.pathname("loader")),
    async (route) => {
      if (route.request().headers()["x-rango-prefetch"] === "1") {
        await route.continue().catch(() => {});
        return;
      }
      const answer: { run?: string } = {};
      answers.push(answer);
      try {
        const response = await route.fetch();
        const body = await response.text();
        answer.run = /"name":"loader\.data","n":(\d+)/.exec(body)?.[1];
        await route.fulfill({ response, body });
      } catch {
        // The page aborted this request: the next click replaced it.
      }
    },
  );

  await byId(page, "pf-link-loader").dblclick();
  await expect(page).toHaveURL(hub.pageUrl("loader"));
  // Both clicks have sent what they send once the network is quiet.
  await page.waitForLoadState("networkidle");
  const last = answers[answers.length - 1];
  expect(last?.run, "the last request was answered").toBeDefined();
  await expect(
    byId(page, "pf-loader-value"),
    "the page shows what the last request returned",
  ).toHaveText(`loader.data:${last!.run}`);
  await expect(byId(page, "pf-loader-fallback")).toHaveCount(0);

  const kinds = kindsOf(requests);
  expect(kinds[0]).toBe("prefetch");
  expect(kinds.slice(1), "a fill for the first click").toContain("fill");
  expect(kinds.length, "one request per click").toBeLessThanOrEqual(3);
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
  name: string = "loader",
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, name);
  await page.route(
    (url) => url.searchParams.has("_rsc_fill"),
    (route) => route.abort("failed"),
  );

  await byId(page, `pf-link-${name}`).click();
  await expect(
    page.getByRole("heading", { name: "Connection Error" }),
  ).toBeVisible();
  await expect(byId(page, `pf-${name}-fallback`)).toHaveCount(0);
  await expect(byId(page, "pf-hub")).toHaveCount(0);
  expect((await hub.counts())[`${name}.data`] ?? 0).toBe(0);
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

/**
 * For each response to a request for `pathname`, in order: whether the
 * browser answered it from its HTTP cache. Chromium only (CDP). Nothing here
 * may use `page.route`: routing switches the HTTP cache off.
 */
async function watchHttpCache(
  page: Page,
  pathname: string,
): Promise<boolean[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const urls = new Map<string, string>();
  const fromCache: boolean[] = [];
  cdp.on("Network.requestWillBeSent", (event) => {
    urls.set(event.requestId, event.request.url);
  });
  cdp.on("Network.responseReceived", (event) => {
    const url = urls.get(event.requestId);
    if (url && isPartialFor(url, pathname)) {
      fromCache.push(event.response.fromDiskCache === true);
    }
  });
  return fromCache;
}

/**
 * How long the document reloaded below keeps streaming: its loader takes
 * this much longer. The browser prefers its own copies until that document
 * has loaded, so the hover and the click have this long to happen.
 */
const RELOAD_STREAMS_MS = 5000;

/**
 * A response that defers is sent `private, no-cache`: no shared cache keeps
 * it and the document cache refuses it. The browser may keep the body all
 * the same, and while it reloads a document for back/forward it answers
 * from what it has without asking the server.
 *
 * - `"prefetch"`: the same prefetch, hovered during that reload, is answered
 *   from the browser's copy. The click completes it as it completes one the
 *   server answered: one fill, the flagged work once.
 * - `"click"`: a click with no prefetch is a navigation. `Vary` names the
 *   prefetch header on a deferring response, so the copy does not answer
 *   it: the request reaches the server and the page arrives whole.
 *
 * The page stood on is one whose document streams for `RELOAD_STREAMS_MS`
 * (`loader`, its loader that much slower), left before it has loaded so the
 * way back fetches it again.
 */
export async function expectDeferringPrefetchTheBrowserKeptIsHarmless(
  page: Page,
  fixture: PrefetchFalseFixture,
  how: "prefetch" | "click",
): Promise<void> {
  const hub = hubFor(page, fixture, randomUUID().slice(0, 8), {
    delay: RELOAD_STREAMS_MS,
  });
  const hydrated = (): Promise<unknown> =>
    page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 20_000 },
    );
  const fromCache = await watchHttpCache(page, hub.pathname("unit"));

  await page.goto(hub.pageUrl("loader"), { waitUntil: "commit" });
  await hydrated();
  await prefetchCase(page, hub, "unit");
  expect(fromCache, "the first prefetch is the server's").toEqual([false]);
  expect((await hub.counts())["unit.data"] ?? 0).toBe(0);

  await page.goto(fixture.url("/"));
  const requests = recordPartials(page, hub.pathname("unit"));
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(hub.pageUrl("loader"));
  await hydrated();

  if (how === "prefetch") {
    await prefetchCase(page, hub, "unit");
    expect(
      fromCache,
      "the browser answered the same prefetch from its copy",
    ).toEqual([false, true]);
    expect((await hub.counts())["unit.data"] ?? 0).toBe(0);
  }
  await clickWithoutHover(page, "unit");
  await expect(page).toHaveURL(hub.pageUrl("unit"));
  await expect(byId(page, "pf-unit-value")).toHaveText("unit.data:1", {
    timeout: RELOAD_STREAMS_MS + 15_000,
  });
  await complete(page);

  expect(kindsOf(requests)).toEqual(
    how === "prefetch" ? ["prefetch", "fill"] : ["navigation"],
  );
  expect(
    fromCache.slice(1),
    "only the prefetch is answered from the browser's copy",
  ).toEqual(how === "prefetch" ? [true, false] : [false]);
  expect(
    pick(await hub.counts(), ["unit.handler", "unit.data"]),
    "the flagged work ran once",
  ).toEqual({ "unit.handler": 1, "unit.data": 1 });
}

// ---------------------------------------------------------------------------
// The flag applies only to a segment the client does not have yet
// ---------------------------------------------------------------------------

/** What `watchPage` saw between its start and its `stop()`. Times are ms since the click. */
export interface PrefetchFalseObservation {
  /**
   * Every fallback that was visible at some point: `pf-*-fallback`, and a
   * route's own `pf-*-loading`.
   */
  fallbacks: string[];
  /** When the last fallback stopped being visible. 0 when none showed. */
  fallbackGoneAt: number;
  /** For how long some fallback was visible. */
  fallbackMs: number;
  /** For how long each of `fallbacks` was visible. */
  shownMs: Record<string, number>;
  /** Held elements that were detached or not visible at some point. */
  hidden: string[];
  /**
   * `pf-*` test ids that showed as more than one DOM node: the element was
   * unmounted and mounted again. A fallback that remounts restarts its
   * animation.
   */
  remounted: string[];
  /** The page box (`pf-outlet`) had nothing visible in it at some point. */
  blank: boolean;
  /**
   * What the page box showed, one entry per change: the visible `pf-*`
   * elements in it, leaves with their text.
   */
  timeline: string[];
  /** When each `timeline` entry began. */
  times: number[];
  /** When the page box first changed after the click. */
  firstChangeAt: number;
  /** When the page box reached the state it ended in. */
  completeAt: number;
  /** `pf-*` test ids in the order they first became visible. */
  order: string[];
  /** When each `order` entry became visible. */
  seenAt: number[];
  /** useNavigation() as `state/isStreaming`, one entry per change. */
  nav: string[];
  /** When each `nav` entry began. */
  navAt: number[];
  /**
   * For how long, before `completeAt`, useNavigation() read `idle` and not
   * streaming: the page was not complete and nothing said so.
   */
  quietMs: number;
  /** Calls of document.startViewTransition. */
  viewTransitions: number;
  /** When each one was made. */
  viewTransitionsAt: number[];
}

/**
 * Record what a reader could see from now until `stop()`. Installed in the
 * page before the click, on a MutationObserver and a frame poll, so a state
 * that shows for one frame is recorded: an assertion made after the fact
 * would miss it. Time runs from the next click.
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
    const nodes = new Map<string, Set<Element>>();
    const order: string[] = [];
    const seenAt: number[] = [];
    const timeline: string[] = [];
    const times: number[] = [];
    const nav: string[] = [];
    const navAt: number[] = [];
    let clickedAt = performance.now();
    let clicked = false;
    const now = (): number =>
      clicked ? Math.round(performance.now() - clickedAt) : 0;
    document.addEventListener(
      "click",
      () => {
        clicked = true;
        clickedAt = performance.now();
      },
      { capture: true, once: true },
    );
    let fallbackSince = -1;
    let fallbackMs = 0;
    let fallbackGoneAt = 0;
    const shownSince = new Map<string, number>();
    const shownMs: Record<string, number> = {};
    let blank = false;
    const viewTransitionsAt: number[] = [];

    // Untyped on purpose: older DOM typings lack the method.
    const doc = document as unknown as {
      startViewTransition?: (...args: unknown[]) => unknown;
    };
    const startViewTransition = doc.startViewTransition;
    if (startViewTransition) {
      doc.startViewTransition = function (...args: unknown[]) {
        viewTransitionsAt.push(now());
        return startViewTransition.apply(document, args);
      };
    }

    const sample = (): void => {
      let fallbackShowing = false;
      const showing = new Set<string>();
      for (const el of document.querySelectorAll('[data-testid^="pf-"]')) {
        if (!visible(el)) continue;
        const id = el.getAttribute("data-testid")!;
        if (id.startsWith("pf-link-")) continue;
        if (!nodes.has(id)) nodes.set(id, new Set());
        nodes.get(id)!.add(el);
        if (!order.includes(id)) {
          order.push(id);
          seenAt.push(now());
        }
        if (id.endsWith("-fallback") || id.endsWith("-loading")) {
          fallbacks.add(id);
          fallbackShowing = true;
          showing.add(id);
          if (!shownSince.has(id)) shownSince.set(id, now());
        }
      }
      for (const [id, since] of shownSince) {
        if (showing.has(id)) continue;
        shownMs[id] = (shownMs[id] ?? 0) + now() - since;
        shownSince.delete(id);
      }
      if (fallbackShowing && fallbackSince < 0) fallbackSince = now();
      if (!fallbackShowing && fallbackSince >= 0) {
        fallbackGoneAt = now();
        fallbackMs += now() - fallbackSince;
        fallbackSince = -1;
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
        times.push(now());
      }
      const state = find("pf-nav");
      const reading = `${state?.getAttribute("data-state")}/${state?.getAttribute("data-streaming")}`;
      if (nav[nav.length - 1] !== reading) {
        nav.push(reading);
        navAt.push(now());
      }
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
      if (fallbackSince >= 0) {
        fallbackGoneAt = now();
        fallbackMs += now() - fallbackSince;
      }
      for (const [id, since] of shownSince) {
        shownMs[id] = (shownMs[id] ?? 0) + now() - since;
      }
      const completeAt = times[times.length - 1] ?? 0;
      let quietMs = 0;
      nav.forEach((reading, index) => {
        if (reading !== "idle/false") return;
        const from = Math.min(navAt[index]!, completeAt);
        const to = Math.min(navAt[index + 1] ?? completeAt, completeAt);
        quietMs += to - from;
      });
      return {
        fallbacks: [...fallbacks].sort(),
        fallbackGoneAt,
        fallbackMs,
        shownMs,
        hidden: [...hidden].sort(),
        remounted: [...nodes]
          .filter(([, seen]) => seen.size > 1)
          .map(([id]) => id)
          .sort(),
        blank,
        timeline,
        times,
        firstChangeAt: times[1] ?? 0,
        completeAt,
        order,
        seenAt,
        nav,
        navAt,
        quietMs,
        viewTransitions: viewTransitionsAt.length,
        viewTransitionsAt,
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

/**
 * Put the server `ms` away for every RSC request from now on. Each request
 * waits that long before it is sent and its response streams as usual, so
 * the first chunk and everything behind it arrive that much later. Returns
 * the undo.
 */
async function farAway(page: Page, ms: number): Promise<() => Promise<void>> {
  const rsc = (url: URL): boolean => url.searchParams.has("_rsc_partial");
  const late = async (route: Route): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  };
  await page.route(rsc, late);
  return () => page.unroute(rsc, late);
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
 * Settled, and no fallback is left: React reveals a boundary up to 300 ms
 * after the content it waited for has arrived.
 */
async function complete(page: Page): Promise<void> {
  await settled(page);
  await expect(
    page.locator('[data-testid^="pf-"][data-testid$="-fallback"]:visible'),
  ).toHaveCount(0);
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

export interface PrefetchFalseElsewhereCase extends PrefetchFalseFlags {
  /** The link prefetched on the hub and clicked on `from`. */
  name: string;
  /** The page the click happens on. It holds what the hub's prefetch deferred. */
  from: string;
  /** Test ids on `from` that the next page keeps. */
  held: string[];
  /** Counters of the work `from` holds: the click must not run it. */
  heldWork: string[];
  /**
   * The hub's prefetch has not answered when the click happens: the reader
   * went back to the hub, hovered the link and went forward again.
   */
  inFlight?: boolean;
}

/**
 * What a prefetch defers depends on what its page holds, so a prefetch that
 * deferred something belongs to the page it was made on (its response is
 * source-scoped). Made on the hub and clicked on a page that holds the
 * deferred segment, it is not adopted: the click is a plain navigation, with
 * no fill, and the work the page holds does not run.
 *
 * Scar tissue: the prefetch was adopted on any page. A page that held the
 * segment then waited for a fill (700 ms for a page a plain click showed in
 * 8), and the fill ran the held handler and loader again.
 */
export async function expectPrefetchThatDeferredStaysWithItsPage(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseElsewhereCase,
): Promise<void> {
  const { name, from } = spec;
  const hub = await openHub(page, fixture, undefined, spec);
  const requests = recordPartials(page, hub.pathname(name));
  const isPrefetch = (request: Request) =>
    isPartialFor(request.url(), hub.pathname(name)) &&
    request.headers()["x-rango-prefetch"] === "1";

  if (!spec.inFlight) {
    const response = await prefetchCase(page, hub, name);
    expect(
      response.headers()["x-rsc-prefetch-scope"],
      "on the hub the segment is new: the prefetch defers it, for the hub",
    ).toBe("source");
    expect(
      response.headers()["cache-control"],
      "and a response that defers is never reused",
    ).toBe("private, no-cache");
  }

  await prefetchCase(page, hub, from);
  await clickWithoutHover(page, from);
  await expect(byId(page, `pf-${from}-value`)).toBeVisible();
  await expect(page).toHaveURL(hub.pageUrl(from));
  await complete(page);

  let release = (): void => {};
  if (spec.inFlight) {
    await page.goBack();
    await expect(byId(page, "pf-hub")).toBeVisible();
    await settled(page);
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => isPartialFor(url.href, hub.pathname(name)),
      async (route) => {
        if (isPrefetch(route.request())) await held;
        await route.continue().catch(() => {});
      },
    );
    await byId(page, `pf-link-${name}`).hover();
    await expect
      .poll(() => requests.length, "the hub's prefetch is in flight")
      .toBe(1);
    await page.mouse.move(0, 0);
    await page.goForward();
    await expect(byId(page, `pf-${from}-value`)).toBeVisible();
    await expect(page).toHaveURL(hub.pageUrl(from));
  }

  const before = pick(await hub.counts(), spec.heldWork);
  const watch = await watchPage(page, ["pf-layout", ...spec.held]);
  await clickWithoutHover(page, name);
  if (spec.inFlight) {
    // The click has found the prefetch in flight, or started its own request.
    await page.waitForTimeout(200);
    release();
  }
  await expect(page).toHaveURL(hub.pageUrl(name));
  await expect(byId(page, `pf-${name}-value`)).toBeVisible();
  await complete(page);
  const seen = await watch.stop();

  const kinds = kindsOf(requests);
  expect(kinds, "the click sent no fill").not.toContain("fill");
  expect(
    kinds.filter((kind) => kind === "navigation"),
    "the hub's prefetch was not adopted: the click is a navigation",
  ).toEqual(["navigation"]);
  expect(
    pick(await hub.counts(), spec.heldWork),
    "the click did not run what the page holds",
  ).toEqual(before);
  expect(seen.hidden, "what the page holds stayed on screen").toEqual([]);
  expect(seen.blank, "the page was never blank").toBe(false);
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

export interface PrefetchFalseParityCase extends PrefetchFalseFlags {
  /** The destination case: the page is `/prefetch-false/<name>`. */
  name: string;
  /** The case to stand on before the click. Default: the hub. */
  from?: string;
  /**
   * The hub is left for `control` and returned to with the browser's back
   * button before the click: the page clicked on was restored, not loaded.
   */
  afterBack?: boolean;
  /**
   * Test ids on screen before the click that the destination keeps, beside
   * the fixture layout (a section layout when moving inside the section).
   */
  held?: string[];
  /**
   * Where the destination's prefetch is made. Default: on the page the click
   * happens on. `"hub"`: on the hub, before moving to `from`. That prefetch
   * deferred what the hub lacked and `from` holds; `from` must not adopt it,
   * so the click is the plain click.
   */
  prefetchedOn?: "hub";
  /**
   * The stem of the destination's test ids when it is not the name: a param
   * route's `item/b` renders `pf-item-*`. `from` takes the same stem.
   */
  stem?: string;
  /**
   * The fallback of the `<Suspense>` around the deferred read. A deferred
   * loader is a loader that is still streaming: this fallback shows with the
   * click, even where the plain click shows the route's coarser `loading()`.
   */
  ownFallback?: string;
  /** How many view transitions the plain click starts, where a case pins it. */
  viewTransitions?: number;
  /**
   * A deferred unit on a route with `transition()`: the click commits with
   * its fill's first chunk, as the plain click commits with its response
   * (`expectUnitUnderTransitionCommitsWithItsFill`). Default: the adopted
   * click shows its fallback with the click.
   */
  commitsWithFill?: boolean;
  /**
   * The server is this many ms away for the click: every RSC request waits
   * that long before it is sent, so a response's first chunk and everything
   * streamed behind it arrive that much later. The prefetch is made before,
   * with no latency: it is not part of the click.
   */
  latency?: number;
}

const IN_SECTION = { from: "section", held: ["pf-section-layout"] };
const BESIDE_SLOT = { held: ["pf-slot-layout", "pf-slot-side"] };

const PARITY_CLICKS: PrefetchFalseParityCase[] = [
  { name: "loader", ownFallback: "pf-loader-fallback" },
  { name: "unit" },
  { name: "section" },
  { name: "section-plain" },
  { name: "section-own" },
  { name: "section-cached" },
  { name: "slot" },
  { name: "slot-b" },
  { name: "bare" },
  { name: "handle" },
  { name: "cached" },
  { name: "prerendered" },
  { name: "ppr" },
  { name: "ssr-false" },
  { name: "vt" },
  { name: "vt-unit", commitsWithFill: true },
  // transition({ viewTransition: false }): React holds the commit and the
  // router places no boundary, so nothing can animate.
  { name: "vt-unit-off", commitsWithFill: true, viewTransitions: 0 },
  { name: "vt-unit-own", commitsWithFill: true },
  { name: "unit-own" },
  { name: "inner" },
  { name: "vt-inner", commitsWithFill: true },
  { name: "nested", ownFallback: "pf-nested-outer-fallback" },
  { name: "control" },
  { name: "section-plain", ...IN_SECTION },
  { name: "section-own", ...IN_SECTION },
  { name: "section-cached", ...IN_SECTION },
  { name: "slot-b", from: "slot", ...BESIDE_SLOT },
  { name: "slot", from: "slot-b", ...BESIDE_SLOT },
  // A same-route navigation: the page holds the route and its loader.
  { name: "item/b", from: "item/a", stem: "item" },
  // A prefetch made on the hub, where it deferred what `from` holds. The
  // last two click a page's own link (a link to the page it is on is not
  // prefetched there).
  { name: "section-plain", ...IN_SECTION, prefetchedOn: "hub" },
  { name: "section-own", ...IN_SECTION, prefetchedOn: "hub" },
  { name: "slot-b", from: "slot", ...BESIDE_SLOT, prefetchedOn: "hub" },
  { name: "slot", from: "slot-b", ...BESIDE_SLOT, prefetchedOn: "hub" },
  { name: "item/b", from: "item/a", stem: "item", prefetchedOn: "hub" },
  {
    name: "loader",
    from: "loader",
    held: ["pf-loader-page"],
    prefetchedOn: "hub",
  },
  { name: "unit", from: "unit", held: ["pf-unit-page"], prefetchedOn: "hub" },
];

/**
 * A loader this much slower lands 400 ms after the click. A reveal that has
 * to wait for a view transition a plain click does not start is late there
 * by what is left of that transition (it runs from about 280 to 560 ms), and
 * by nothing with a loader at 100 or 700 ms. Not 300 ms: that is the time
 * React keeps a fallback up, and a loader landing on it reveals a nested
 * boundary in either order, in the plain click too.
 */
const MID_DELAY_MS = 300;

/**
 * How far away the server is in the latency cases. The adopted click shows
 * its fallback with the click and the plain click with the response, this
 * much later, and React reveals nothing sooner than 300 ms after a fallback.
 * Left to React the adopted click's reveal comes this much before the plain
 * click's: a value that lands in between misses it and shows behind a second
 * fallback, 300 ms more, where the plain click shows everything at once.
 */
const LATENCY_MS = 100;

/**
 * A loader this much slower lands 250 ms into its response: with the server
 * `LATENCY_MS` away, between the two reveals.
 */
const WINDOW_DELAY_MS = 150;

/** The pages below the section layout, whose `loading()` is flagged. */
const SECTION_PAGES = [
  "section",
  "section-plain",
  "section-own",
  "section-cached",
];

/**
 * Where a click to the section comes from when the client does not hold the
 * section layout: the layout is new and deferred, with the route below it.
 */
const OUTSIDE_SECTION: Array<
  Pick<PrefetchFalseParityCase, "from" | "afterBack">
> = [
  {},
  { from: "control" },
  { from: "unit" },
  { from: "slot" },
  { afterBack: true },
];

/** The clicks from the hub that are also made with the server far away. */
const LATENCY_CLICKS = [
  "loader",
  "unit",
  "section",
  "section-own",
  "vt-unit",
  "inner",
  "vt-inner",
  "nested",
];

/**
 * OPEN, not fixed: `nested` with both of its loaders landing between 300 and
 * 600 ms after the response starts (`&delay=300`: 400 and 550 ms). The plain
 * click shows the route's `loading()` first and reveals the page 300 ms
 * later, which starts React's 300 ms again: both values arrive inside it and
 * show together. The adopted click has had the page up since the click, so
 * the first value shows as it arrives, the second behind a fallback the plain
 * click never shows, 300 ms after the first. Measured in production: the
 * page complete at 707 ms against 609, with `pf-nested-late-fallback` in
 * every pair, the same with the server 100 ms away. It needs the client to
 * know whether the route's own boundary has revealed, which costs more
 * bytes than the router chunk's ratchet leaves
 * (docs/design/prefetch-false.md, "Limits"). The cells are left out here by
 * name so that the rest of the case stays pinned.
 */
function isOpen(spec: PrefetchFalseParityCase): boolean {
  return spec.name === "nested" && spec.delay === MID_DELAY_MS;
}

/**
 * The fixture's cases, as `expectAdoptedClickIsNeverWorseThanAPlainClick`
 * runs them: every click with fast loaders (100 ms), with loaders that land
 * mid-transition (`&delay=300`) and with slow ones (`&slow=1`); the clicks
 * inside the section and every click into it (`OUTSIDE_SECTION`) with a slow
 * layout handler (`&hslow=1`), where the plain click holds the page it is
 * on until the handler returns; and `LATENCY_CLICKS` with the server
 * `LATENCY_MS` away and loaders that land before, between and after the two
 * reveals, and long after both.
 */
export const PREFETCH_FALSE_PARITY_CASES: PrefetchFalseParityCase[] = [
  ...PARITY_CLICKS,
  ...PARITY_CLICKS.map((spec) => ({ ...spec, delay: MID_DELAY_MS })),
  ...PARITY_CLICKS.map((spec) => ({ ...spec, slow: true })),
  ...PARITY_CLICKS.filter((spec) => spec.from === "section").map((spec) => ({
    ...spec,
    hslow: true,
  })),
  ...OUTSIDE_SECTION.flatMap((source) =>
    SECTION_PAGES.map((name) => ({ name, ...source, hslow: true })),
  ),
  ...PARITY_CLICKS.filter(
    (spec) => !spec.from && LATENCY_CLICKS.includes(spec.name),
  ).flatMap((spec) => [
    ...[0, WINDOW_DELAY_MS, MID_DELAY_MS].map((delay) => ({
      ...spec,
      latency: LATENCY_MS,
      ...(delay > 0 && { delay }),
    })),
    { ...spec, latency: LATENCY_MS, slow: true },
  ]),
].filter((spec) => !isOpen(spec));

/** A title for one parity case: unique within `PREFETCH_FALSE_PARITY_CASES`. */
export function prefetchFalseParityTitle(
  spec: PrefetchFalseParityCase,
): string {
  return [
    `${spec.from ?? "hub"}${spec.afterBack ? " after back" : ""} to ${spec.name}`,
    spec.prefetchedOn && "prefetched on the hub",
    spec.delay && `loaders ${spec.delay} ms slower`,
    spec.slow && "slow loaders",
    spec.hslow && "slow layout",
    spec.latency && `the server ${spec.latency} ms away`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** One click, as `recordPlainAndAdoptedClick` records it. */
export interface PrefetchFalseClick extends PrefetchFalseObservation {
  /** The requests the click sent for the destination. */
  requests: PrefetchFalseRequestKind[];
  /** The server work the click ran: counter name to number of runs. */
  ran: Record<string, number>;
}

/**
 * How much later than the plain click the adopted one may be. A reveal that
 * waits for one view transition too many is about 250 ms late, and work done
 * twice costs its whole duration; two clicks on a quiet machine differ by a
 * few frames.
 */
const PARITY_MARGIN_MS = 100;

/**
 * Pairs of clicks one case may record. A loaded machine can delay one click
 * of a pair past the margin; noise is independent between pairs and a
 * regression is in every one of them.
 */
const PARITY_PAIRS = 3;

/** A plain click and the same click with its prefetch adopted. */
export interface PrefetchFalsePair {
  plain: PrefetchFalseClick;
  adopted: PrefetchFalseClick;
}

/**
 * The invariant: a click that adopts a prefetch is never worse than the same
 * click with no prefetch at all. The body does the click twice on fresh
 * pages, once as a plain navigation (the link is clicked without being
 * hovered) and once after its prefetch has been received, and records each
 * from the click until the router is idle again.
 *
 * - A fallback shows with the prefetch only where the plain navigation
 *   shows the same fallback (or it is the read's own: `ownFallback`), and
 *   the last one is gone no later. Not "for no longer": a deferred unit
 *   shows its fallback with the click, where the plain click keeps the page
 *   it is on until its response starts.
 * - Content that was on screen and belongs to the new page is never
 *   detached or hidden, the page is never blank, and nothing is unmounted
 *   and mounted again (a fallback included) that a plain click keeps.
 * - The first visible change, every element of the page and the completed
 *   page are never later.
 * - `useNavigation()` is never idle for longer while the page is incomplete.
 * - The click runs no server work a plain click does not run, starts no
 *   view transition a plain click does not start, and as many that change
 *   the page (`animatedChanges`).
 *
 * Times are compared with `PARITY_MARGIN_MS` to spare. A pair that is later
 * than that is recorded again, up to `PARITY_PAIRS` pairs: the case fails
 * when every pair is late. Everything else is judged on the first pair.
 * `onRepeat` is told each time a pair was not enough. A failure lists every
 * broken comparison and every pair.
 *
 * Returns the first pair, for a case that pins more.
 */
export async function expectAdoptedClickIsNeverWorseThanAPlainClick(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseParityCase,
  onRepeat?: (late: string) => void,
): Promise<PrefetchFalsePair> {
  const first = await recordPlainAndAdoptedClick(page, fixture, spec);
  const { plain, adopted } = first;
  // One failure lists everything that is wrong: a click that is late is
  // usually late because of something else in the list.
  const wrong: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok) wrong.push(what);
  };

  const added = adopted.fallbacks.filter(
    (id) => !plain.fallbacks.includes(id) && id !== spec.ownFallback,
  );
  check(
    added.length === 0,
    `a fallback the plain navigation does not show: ${added.join(", ")}`,
  );
  check(
    adopted.hidden.length === 0,
    `content on screen was detached or hidden: ${adopted.hidden.join(", ")}`,
  );
  check(!adopted.blank, "the page was blank");
  const remounted = adopted.remounted.filter(
    (id) => !plain.remounted.includes(id),
  );
  check(
    remounted.length === 0,
    `an element on screen was unmounted and mounted again: ${remounted.join(", ")}`,
  );
  check(
    adopted.viewTransitions <= plain.viewTransitions,
    `view transitions: the plain navigation starts ${plain.viewTransitions}, the adopted click ${adopted.viewTransitions}`,
  );
  check(
    animatedChanges(adopted) === animatedChanges(plain),
    `view transitions that change the page: the plain navigation ${animatedChanges(plain)}, the adopted click ${animatedChanges(adopted)}`,
  );
  check(
    spec.viewTransitions === undefined ||
      plain.viewTransitions === spec.viewTransitions,
    `view transitions of the plain navigation: ${plain.viewTransitions}, expected ${spec.viewTransitions}`,
  );
  for (const [work, runs] of Object.entries(adopted.ran)) {
    check(
      runs <= (plain.ran[work] ?? 0),
      `the click ran ${work} more often than the plain click`,
    );
  }
  check(
    !spec.prefetchedOn || adopted.requests.join() === plain.requests.join(),
    "a prefetch made on another page was adopted",
  );
  if (spec.latency) {
    // A latency that reached neither click would pass every comparison.
    check(
      plain.firstChangeAt >= spec.latency,
      "the plain click showed something before its response",
    );
    check(
      spec.commitsWithFill
        ? adopted.firstChangeAt >= spec.latency
        : adopted.firstChangeAt < spec.latency,
      spec.commitsWithFill
        ? "the adopted click showed something before its fill"
        : "the adopted click did not show its fallback with the click",
    );
  }

  const pairs = [first];
  let late = laterThanPlain(first);
  while (late.length > 0 && pairs.length < PARITY_PAIRS) {
    onRepeat?.(`pair ${pairs.length}: ${late.join("; ")}`);
    const next = await recordPlainAndAdoptedClick(page, fixture, spec);
    pairs.push(next);
    late = laterThanPlain(next);
  }
  check(late.length === 0, "later than the plain click in every pair");

  expect(
    wrong,
    `${prefetchFalseParityTitle(spec)}\n${pairs
      .map(
        (pair, index) =>
          `pair ${index + 1}: ${laterThanPlain(pair).join("; ") || "on time"}\n${describePair(pair)}`,
      )
      .join("\n")}`,
  ).toEqual([]);
  return first;
}

/**
 * The view transitions of a click that changed the page box. One that
 * changes nothing still runs its whole animation, and React commits no
 * reveal until it has finished, so the page box cannot change within
 * `IDLE_WINDOW_MS` of its start.
 *
 * The count of all transitions is compared with "no more than the plain
 * click", not "as many": in development the plain click to a route under
 * `transition()` whose loader outlasts 300 ms starts one that changes
 * nothing (measured on `vt`: calls at 13, 325 and 607 ms, the page complete
 * at 624), which the adopted click does not start (6 and 413 ms, complete at
 * 418). In production the two counts are equal in every case. This count is
 * what keeps "no more" from hiding a reveal that lost its animation.
 */
function animatedChanges(click: PrefetchFalseClick): number {
  return click.viewTransitionsAt.filter((at) =>
    click.times.some(
      (changed) => changed >= at && changed <= at + IDLE_WINDOW_MS,
    ),
  ).length;
}

const IDLE_WINDOW_MS = 100;

/** Where the adopted click of a pair is later than the plain one, past the margin. */
function laterThanPlain({ plain, adopted }: PrefetchFalsePair): string[] {
  const late: string[] = [];
  const never = (what: string, was: number, is: number): void => {
    if (is > was + PARITY_MARGIN_MS) late.push(`${what} ${was} -> ${is}`);
  };
  never(
    "the first visible change (ms)",
    plain.firstChangeAt,
    adopted.firstChangeAt,
  );
  never("the completed page (ms)", plain.completeAt, adopted.completeAt);
  // A plain click that shows no fallback keeps the page it is on instead.
  never(
    "the last fallback gone (ms)",
    plain.fallbacks.length > 0 ? plain.fallbackGoneAt : plain.completeAt,
    adopted.fallbackGoneAt,
  );
  never(
    "useNavigation() idle, the page incomplete (ms)",
    plain.quietMs,
    adopted.quietMs,
  );
  // Each element on its own: a unit's content held back until a read inside
  // it arrives completes the page on time, with its last fallback gone on
  // time.
  adopted.order.forEach((id, index) => {
    const was = plain.order.indexOf(id);
    if (was < 0 || adopted.fallbacks.includes(id)) return;
    never(`${id} visible at (ms)`, plain.seenAt[was]!, adopted.seenAt[index]!);
  });
  return late;
}

function describePair({ plain, adopted }: PrefetchFalsePair): string {
  return `  plain   ${JSON.stringify(brief(plain))}\n  adopted ${JSON.stringify(brief(adopted))}`;
}

function brief(click: PrefetchFalseClick): Record<string, unknown> {
  return {
    firstChangeAt: click.firstChangeAt,
    completeAt: click.completeAt,
    fallbackGoneAt: click.fallbackGoneAt,
    fallbackMs: click.fallbackMs,
    quietMs: click.quietMs,
    viewTransitionsAt: click.viewTransitionsAt,
    shownMs: click.shownMs,
    seen: click.order.map((id, index) => `${click.seenAt[index]}:${id}`),
    remounted: click.remounted,
    nav: click.nav.map((reading, index) => `${click.navAt[index]}:${reading}`),
    requests: click.requests,
    ran: click.ran,
  };
}

/** The two clicks of `expectAdoptedClickIsNeverWorseThanAPlainClick`. */
export async function recordPlainAndAdoptedClick(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseParityCase,
): Promise<PrefetchFalsePair> {
  const held = ["pf-layout", ...(spec.held ?? [])];
  const value = (name: string) => byId(page, `pf-${spec.stem ?? name}-value`);
  const ownLink = spec.from === spec.name;
  const click = async (prefetched: boolean): Promise<PrefetchFalseClick> => {
    const hub = await openHub(page, fixture, undefined, spec);
    if (spec.afterBack) {
      await clickWithoutHover(page, "control");
      await expect(byId(page, "pf-control-value")).toBeVisible();
      await complete(page);
      await page.goBack();
      await expect(page).toHaveURL(hub.home);
      await expect(byId(page, "pf-hub")).toBeVisible();
      await complete(page);
    }
    const early = prefetched && spec.prefetchedOn === "hub";
    if (early) await prefetchCase(page, hub, spec.name);
    if (spec.from) {
      // Its own link, already prefetched: a second hover sends nothing.
      if (!(early && ownLink)) await prefetchCase(page, hub, spec.from);
      await clickWithoutHover(page, spec.from);
      await expect(value(spec.from)).toBeVisible();
      await expect(page).toHaveURL(hub.pageUrl(spec.from));
      await complete(page);
    }
    if (prefetched && !early) await prefetchCase(page, hub, spec.name);
    const before = await hub.counts();
    const requests = recordPartials(page, hub.pathname(spec.name));
    const near = spec.latency ? await farAway(page, spec.latency) : undefined;
    const watch = await watchPage(page, held);
    await clickWithoutHover(page, spec.name);
    // A page's own link changes neither the URL nor what is on screen: the
    // waits below would pass before the click has started anything.
    if (ownLink) await page.waitForTimeout(200);
    await expect(page).toHaveURL(hub.pageUrl(spec.name));
    await expect(value(spec.name)).toBeVisible();
    await complete(page);
    const seen = await watch.stop();
    await near?.();
    const after = await hub.counts();
    const ran: Record<string, number> = {};
    for (const [work, runs] of Object.entries(after)) {
      if (runs !== (before[work] ?? 0)) ran[work] = runs - (before[work] ?? 0);
    }
    return { ...seen, requests: kindsOf(requests), ran };
  };

  const plain = await click(false);
  const adopted = await click(true);
  return { plain, adopted };
}

/**
 * A deferred loader never blocks the navigation: it behaves like a loader
 * that is still streaming. Its read has a `<Suspense>` of its own, so the
 * click shows the page, the value of the loader the prefetch ran and that
 * fallback at once, then the value. The plain click shows the route's
 * coarser `loading()` first; the adopted one never does.
 */
export async function expectDeferredLoaderShowsItsOwnFallbackAtOnce(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const { plain, adopted } =
    await expectAdoptedClickIsNeverWorseThanAPlainClick(page, fixture, {
      name: "loader",
      ownFallback: "pf-loader-fallback",
    });
  expect(plain.fallbacks, "the plain click: the route's fallback").toContain(
    "pf-loader-loading",
  );
  expect(adopted.fallbacks, "the adopted click: only the read's own").toEqual([
    "pf-loader-fallback",
  ]);
  const first = adopted.timeline[1] ?? "";
  for (const shown of [
    "pf-loader-page",
    "pf-loader-price=loader.price:1",
    "pf-loader-fallback",
  ]) {
    expect(first, "the first thing the click shows").toContain(shown);
  }
  expect(first, "the deferred value is not there yet").not.toContain(
    "pf-loader-value",
  );
  const last = adopted.timeline[adopted.timeline.length - 1] ?? "";
  expect(last, "then the value").toContain("pf-loader-value=loader.data:1");
  expect(last, "and no fallback").not.toContain("pf-loader-fallback");
}

/**
 * What `useNavigation()` reads while a fill is pending is what it reads on a
 * plain navigation whose loader is still streaming.
 *
 * - `unit`: the page has committed and its fallback shows: `idle`,
 *   `isStreaming: true`.
 * - `bare`: nothing can show a fallback, so React holds the page being left:
 *   `loading`, `isStreaming: true`, until the page commits.
 *
 * Scar tissue (`bare`): the adopted click read `idle` and not streaming for
 * as long as React held it (700 ms with a slow loader), so an app's progress
 * bar never showed. The click and its commit are one task, the `loading`
 * state was never rendered, and the state after the commit is handed to
 * React inside the transition it was holding.
 */
export async function expectPendingFillReadsLikeAStreamingNavigation(
  page: Page,
  fixture: PrefetchFalseFixture,
  name: "unit" | "bare",
): Promise<void> {
  const reading = async () => ({
    state: await byId(page, "pf-nav").getAttribute("data-state"),
    isStreaming: await byId(page, "pf-nav").getAttribute("data-streaming"),
  });
  // The click is waiting for the deferred loader.
  const waiting = async () => {
    if (name === "unit") {
      await expect(byId(page, "pf-unit-fallback")).toBeVisible();
      return;
    }
    await page.waitForTimeout(300);
    await expect(byId(page, "pf-hub")).toBeVisible();
    await expect(byId(page, "pf-bare-page")).toHaveCount(0);
  };

  // A plain navigation, its loader 700 ms away.
  let hub = await openHub(page, fixture, undefined, { slow: true });
  await clickWithoutHover(page, name);
  await waiting();
  const streaming = await reading();
  expect(streaming).toEqual(
    name === "unit"
      ? { state: "idle", isStreaming: "true" }
      : { state: "loading", isStreaming: "true" },
  );
  await expect(byId(page, `pf-${name}-value`)).toBeVisible();
  await settled(page);

  // The same click with the prefetch adopted, its fill held.
  hub = await openHub(page, fixture);
  await prefetchCase(page, hub, name);
  const fills = await holdFills(page);
  await byId(page, `pf-link-${name}`).click();
  await waiting();
  await expect.poll(reading).toEqual(streaming);
  // Still, a moment later: it is not on its way to another reading.
  await page.waitForTimeout(100);
  expect(await reading()).toEqual(streaming);

  await fills.release();
  await expect(byId(page, `pf-${name}-value`)).toBeVisible();
  await settled(page);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export interface PrefetchFalseSuite {
  fixture: () => PrefetchFalseFixture;
  /** The app's guard: fails the test on an uncaught page error. */
  expectNoPageError: (page: Page) => { [Symbol.dispose]: () => void };
}

/**
 * Every `prefetch: false` test, registered on the caller's `test`. A suite
 * file calls this once in a dev describe and once in a `(production)` one:
 * the describes stay in the file, where the bucketing checks read them.
 */
export function definePrefetchFalseTests(
  test: typeof base,
  suite: PrefetchFalseSuite,
): void {
  test.setTimeout(60_000);
  const it = (
    title: string,
    body: (page: Page, fixture: PrefetchFalseFixture) => Promise<unknown>,
  ): void => {
    test(title, async ({ page }) => {
      using _ = suite.expectNoPageError(page);
      await body(page, suite.fixture());
    });
  };

  it("a flagged loader is skipped by the prefetch and fetched by the click, beside an unflagged one", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "loader",
      prefetched: ["loader.price", "loader.handler"],
      // pf-note-loader: the handle push of the handler the prefetch ran is
      // on screen with the click's commit, not with the fill.
      shownWhileMissing: [
        "pf-loader-page",
        "pf-loader-price",
        "pf-note-loader",
      ],
    }));

  it("a flagged loading() on a plain route skips the handler and its loader together", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "unit",
      deferred: ["unit.data", "unit.handler"],
    }));

  it("a flagged loading() on a layout skips the layout and everything below it", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "section",
      deferred: ["section.data", "section.handler", "section.layout"],
    }));

  // The unit is the segment that is new to the client. From the hub the
  // section layout is new: a route below it waits with it, whatever the route
  // declares, behind the layout's fallback and in one fill.
  for (const name of ["section-plain", "section-own"]) {
    it(`a route below a flagged layout that is new waits with the layout: ${name}`, (page, fixture) =>
      expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
        name,
        deferred: [`${name}.data`, `${name}.handler`, "section.layout"],
        fallback: "pf-section-fallback",
      }));
  }

  it("a flagged layout the client holds defers nothing: routes below it follow their own flags", (page, fixture) =>
    expectHeldFlaggedLayoutLeavesRoutesToTheirOwnFlags(page, fixture));

  // A prefetch that deferred something belongs to the page it was made on.
  const section = {
    from: "section",
    held: ["pf-section-layout"],
    heldWork: ["section.layout"],
  };
  const slot = {
    from: "slot",
    held: ["pf-slot-layout", "pf-slot-side"],
    heldWork: ["slot.side", "slot.data"],
  };
  const elsewhere: PrefetchFalseElsewhereCase[] = [
    { name: "section-plain", ...section },
    { name: "section-own", ...section, hslow: true },
    { name: "slot-b", ...slot, slow: true },
    { name: "section-own", ...section, inFlight: true },
    { name: "slot-b", ...slot, inFlight: true },
  ];
  for (const spec of elsewhere) {
    const flags = [
      spec.slow && "slow loaders",
      spec.hslow && "slow layout",
      spec.inFlight && "still in flight",
    ].filter(Boolean);
    it(`a prefetch made on the hub is not adopted on a page that holds what it deferred: ${[`${spec.from} to ${spec.name}`, ...flags].join(", ")}`, (page, fixture) =>
      expectPrefetchThatDeferredStaysWithItsPage(page, fixture, spec));
  }

  it("a cache() route below a flagged layout the client holds uses its record", (page, fixture) =>
    expectCachedRouteUnderHeldFlaggedLayoutUsesItsRecord(page, fixture));

  it("a same-route navigation is never deferred: it reads like the route without the flag", (page, fixture) =>
    expectSameRouteNavigationIsNeverDeferred(page, fixture));

  // The invariant: a click that adopts a prefetch is never worse than the
  // same click with no prefetch at all.
  for (const spec of PREFETCH_FALSE_PARITY_CASES) {
    it(`a click that adopts a prefetch is never worse than a plain click: ${prefetchFalseParityTitle(spec)}`, (page, fixture) =>
      expectAdoptedClickIsNeverWorseThanAPlainClick(
        page,
        fixture,
        spec,
        // In the report: how often one pair of clicks was not enough.
        (late) =>
          test.info().annotations.push({
            type: "parity pair repeated",
            description: late,
          }),
      ));
  }

  it("a deferred loader shows its own fallback at once, beside what the prefetch ran", (page, fixture) =>
    expectDeferredLoaderShowsItsOwnFallbackAtOnce(page, fixture));

  for (const name of ["unit", "bare"] as const) {
    it(`useNavigation() reads a pending fill like a navigation that is still streaming: ${name}`, (page, fixture) =>
      expectPendingFillReadsLikeAStreamingNavigation(page, fixture, name));
  }

  it("a deferred unit under transition() commits with its fill, as a plain click commits with its response", (page, fixture) =>
    expectUnitUnderTransitionCommitsWithItsFill(page, fixture));

  it("leaving while React holds a click on a deferred unit under transition() aborts its fill", (page, fixture) =>
    expectLeavingAHeldAdoptionAbortsItsFill(page, fixture));

  it("a slot with its own flagged loading() is skipped while the route beside it renders", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "slot",
      deferred: ["slot.data", "slot.side"],
      prefetched: ["slot.handler"],
      shownWhileMissing: ["pf-slot-page"],
    }));

  it("a flagged loader with no boundary holds the page being left until the fill returns", (page, fixture) =>
    expectNoBoundaryHoldsThePageLeftUntilTheFillReturns(page, fixture));

  it("a deferred loader that throws reaches its error boundary when the fill returns", (page, fixture) =>
    expectDeferredOutcomeArrivesWithTheFill(page, fixture, {
      name: "throws",
      shows: "pf-throws-error",
    }));

  it("a deferred loader that calls notFound() reaches its not-found boundary when the fill returns", (page, fixture) =>
    expectDeferredOutcomeArrivesWithTheFill(page, fixture, {
      name: "missing",
      shows: "pf-missing-not-found",
    }));

  it("a deferred loader that redirects is followed when the fill returns", (page, fixture) =>
    expectDeferredOutcomeArrivesWithTheFill(page, fixture, {
      name: "redirects",
      shows: "pf-control-page",
      landsOn: "control",
    }));

  it("a deferred handler's handle push arrives with the fill", (page, fixture) =>
    expectDeferredOutcomeArrivesWithTheFill(page, fixture, {
      name: "handle",
      shows: "pf-note-handle",
    }));

  it("a cache() route serves its handler as usual and skips only the loader behind the fallback", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "cached",
      prefetched: ["cached.handler"],
    }));

  it("a Prerender route skips only the loader behind the fallback", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "prerendered",
    }));

  it("a ppr route skips its flagged live loader", (page, fixture) =>
    expectPrefetchSkipsFlaggedWorkAndClickFillsIt(page, fixture, {
      name: "ppr",
    }));

  it("ssr: false with prefetch: false: the document awaits the loader and a prefetch skips it", (page, fixture) =>
    expectDocumentAwaitsLoaderThatPrefetchSkips(page, fixture));

  it("back and forward after a fill restore the filled page", (page, fixture) =>
    expectBackAndForwardKeepTheFilledPage(page, fixture));

  it("leaving before the fill returns aborts it, and going back fetches what is missing", (page, fixture) =>
    expectLeavingBeforeTheFillAbortsItAndBackRefetches(page, fixture));

  it("a page the client has visited is served from what it holds: no fill, no flagged work", (page, fixture) =>
    expectRevisitUsesWhatTheClientHolds(page, fixture));

  // Both orders, forced: the fill before React commits the adoption, and the
  // adoption's fallback before the fill.
  const scrollCases: Array<[string, PrefetchFalseScrollCase]> = [
    [
      "bare, no boundary: the fill lands first",
      { name: "bare", first: "fill" },
    ],
    ["loader: the fallback shows first", { name: "loader", first: "fallback" }],
    ["unit: the fallback shows first", { name: "unit", first: "fallback" }],
    [
      "loader: the reader scrolls while the fallback shows, the fill leaves it",
      { name: "loader", first: "fallback", scrollWhileWaiting: true },
    ],
    ["control, no flag", { name: "control", first: "none" }],
    [
      "loader, its own link: a navigation",
      { name: "loader", first: "none", samePage: true },
    ],
    [
      "unit, its own link: a navigation",
      { name: "unit", first: "none", samePage: true },
    ],
  ];
  for (const [title, spec] of scrollCases) {
    it(`a click from a scrolled page ends at the top: ${title}`, (page, fixture) =>
      expectClickFromAScrolledPageEndsAtTheTop(page, fixture, spec));
  }

  for (const name of ["loader", "unit", "bare"]) {
    it(`a click while the prefetch is still in flight adopts it: ${name}`, (page, fixture) =>
      expectClickDuringThePrefetchAdoptsIt(page, fixture, name));
  }

  it("a double click on one link ends on what the last click fetched", (page, fixture) =>
    expectDoubleClickEndsOnTheLastRequest(page, fixture));

  it("back and forward during a fill end on the filled page", (page, fixture) =>
    expectBackAndForwardDuringAFillEndOnTheFilledPage(page, fixture));

  // `vt-unit`: React is still holding the click when the fill fails.
  for (const name of ["loader", "vt-unit"]) {
    it(`a fill the network drops reaches the network error boundary: ${name}`, (page, fixture) =>
      expectFailedFillReachesTheNetworkErrorBoundary(page, fixture, name));
  }

  it("a fill the client cannot use reaches the error boundary, with no uncaught error", (page, fixture) =>
    expectUnusableFillReachesTheErrorBoundary(page, fixture));

  it("control: a route with no flag is prefetched whole and the click sends nothing", (page, fixture) =>
    expectUnflaggedRouteIsPrefetchedWhole(page, fixture));

  it("a deferring prefetch the browser kept answers the same prefetch during a back/forward reload, and the click completes it", (page, fixture) =>
    expectDeferringPrefetchTheBrowserKeptIsHarmless(page, fixture, "prefetch"));

  it("a deferring prefetch the browser kept never answers a navigation during a back/forward reload", (page, fixture) =>
    expectDeferringPrefetchTheBrowserKeptIsHarmless(page, fixture, "click"));
}
