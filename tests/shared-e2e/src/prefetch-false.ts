import {
  expect,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type test as base,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  expectConsole,
  readSuspenseAudit,
  resetSuspenseAudit,
} from "./console-guard.js";

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
 * take 600 ms. `&boundary=1` puts a `<ViewTransition>` of the app's own in
 * the hub layout, and `&vtms=<ms>` makes every view transition take that
 * long. `&server=<ms>` makes every request of the fixture wait that long on
 * the server before it renders (a middleware): the time a real server spends
 * before its first byte, which a local one does not.
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

function isFill(url: string | URL): boolean {
  return new URL(url).searchParams.has("_rsc_fill");
}

/** A `<Link>` prefetch, by the header it is sent with. */
function isPrefetch(request: Request): boolean {
  return request.headers()["x-rango-prefetch"] === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise a body opens by hand: what a request it holds waits for. */
function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function awaitHydrated(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
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
  /** Every view transition takes this many ms (the default is about 250). */
  vtms?: number;
  /**
   * Every request the fixture serves (the document, a prefetch, a
   * navigation, a fill) waits this many ms on the server before it renders.
   */
  server?: number;
}

function hubQuery(run: string, flags: PrefetchFalseFlags): string {
  return `run=${run}${flags.slow ? "&slow=1" : ""}${flags.delay ? `&delay=${flags.delay}` : ""}${flags.hslow ? "&hslow=1" : ""}${flags.boundary ? "&boundary=1" : ""}${flags.vtms ? `&vtms=${flags.vtms}` : ""}${flags.server ? `&server=${flags.server}` : ""}`;
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
  await awaitHydrated(page);
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
      isPrefetch(response.request()),
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
  const { opened, open } = latch();
  // Its own function: `release` removes this route and no other.
  const matcher = (url: URL): boolean => isFill(url);
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
      : isPrefetch(request)
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
  expect(isPrefetch(fill), "a fill is not a prefetch").toBe(false);
  return hub;
}

/**
 * A deferred loader whose read has no boundary: nothing can show a fallback,
 * so React holds the page being left until the fill returns. The URL has
 * already changed.
 *
 * - `bare`: a flagged loader, no `loading()` on its entry and no Suspense
 *   around the read.
 * - `above`: a unit whose loader the layout above it reads as well. That
 *   read is above the unit's fallback, so the unit's own loader holds the
 *   page. Scar tissue: the loader's gate waited for the fill's tree, which
 *   waits for React to commit the adoption, which was waiting for the gate.
 *   The page being left stayed for good, `useNavigation()` read `loading`,
 *   and nothing was thrown.
 */
export async function expectNoBoundaryHoldsThePageLeftUntilTheFillReturns(
  page: Page,
  fixture: PrefetchFalseFixture,
  name: "bare" | "above" = "bare",
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname(name));
  await prefetchCase(page, hub, name);
  expect((await hub.counts())[`${name}.data`] ?? 0).toBe(0);

  const fills = await holdFills(page);
  await byId(page, `pf-link-${name}`).click();
  await expect(page).toHaveURL(hub.pageUrl(name));
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  await expect(byId(page, "pf-hub")).toBeVisible();
  await expect(byId(page, `pf-${name}-page`)).toHaveCount(0);

  await fills.release();
  await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
  await expect(byId(page, "pf-hub")).toHaveCount(0);
  await complete(page);
  expect((await hub.counts())[`${name}.data`]).toBe(1);
  expect(requests.filter((r) => isFill(r.url()))).toHaveLength(1);
}

/**
 * A deferred unit on a route with `transition()`. A plain click there keeps
 * the page it is on until its response starts, then commits the page with
 * its fallback in one transition: URL, hooks and page together. The adopted
 * click does the same with its fill. Nothing commits with the click: the URL
 * stays, the page being left stays, `useNavigation()` reads `loading`. With
 * the fill's first chunk the page commits once, from the prefetched segments
 * and the fill's. Committed with the click, the URL moved a round trip
 * before the page, and the unit's content could only arrive in a commit of
 * its own, which starts a view transition the plain click does not start
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
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  await expect(byId(page, "pf-nav")).toHaveAttribute("data-state", "loading");
  await expect(page, "the URL moves with the page").toHaveURL(hub.home);
  await expect(byId(page, "pf-nav")).toHaveAttribute(
    "data-path",
    new URL(hub.home).pathname,
  );
  await expect(byId(page, "pf-hub")).toBeVisible();
  await expect(byId(page, "pf-vt-unit-fallback")).toHaveCount(0);

  await fills.release();
  await expect(byId(page, "pf-vt-unit-value")).toHaveText("vt-unit.data:1");
  await expect(page).toHaveURL(hub.pageUrl("vt-unit"));
  await expect(byId(page, "pf-hub")).toHaveCount(0);
  await complete(page);
  expect(pick(await hub.counts(), work)).toEqual({
    "vt-unit.handler": 1,
    "vt-unit.data": 1,
  });
  expect(kindsOf(requests)).toEqual(["prefetch", "fill"]);
}

/**
 * Leaving while such a click (`vt-unit`) still waits for its fill aborts the
 * fill and shows the next page. The click never committed: it left no
 * history entry, so going back lands on the page it was made on, and the
 * deferred work never ran.
 */
export async function expectLeavingAHeldAdoptionAbortsItsFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const work = ["vt-unit.handler", "vt-unit.data"];
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("vt-unit"));
  await prefetchCase(page, hub, "vt-unit");

  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    if (isFill(request.url())) aborted.push(request.failure()?.errorText ?? "");
  });
  const fills = await holdFills(page);
  await byId(page, "pf-link-vt-unit").click();
  await expect
    .poll(() => requests.filter((r) => isFill(r.url())).length)
    .toBe(1);
  await expect(page).toHaveURL(hub.home);
  await expect(byId(page, "pf-hub")).toBeVisible();

  await byId(page, "pf-link-control").click();
  await expect(byId(page, "pf-control-value")).toHaveText("control.data:1");
  await expect(page).toHaveURL(hub.pageUrl("control"));
  await expect.poll(() => aborted.length, "the fill was aborted").toBe(1);
  await fills.release();
  await complete(page);
  await expect(byId(page, "pf-vt-unit-page")).toHaveCount(0);

  await page.goBack();
  await expect(page, "the click left no entry").toHaveURL(hub.home);
  await expect(byId(page, "pf-hub")).toBeVisible();
  await complete(page);
  expect(
    pick(await hub.counts(), work),
    "the aborted fill ran nothing",
  ).toEqual({ "vt-unit.handler": 0, "vt-unit.data": 0 });
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
 * A filled entry that history marked stale (an action ran, or
 * invalidateClientCache()) is shown at once on back/forward and then
 * revalidated, as any stale entry is: one ordinary request (`_rsc_stale`),
 * not a prefetch and not a fill; the fill rewrote the entry in place, so the
 * entry kept its stale flag. The revalidated tree commits after it with no
 * fallback at any point and nothing mounted again, and the page shows what
 * the revalidation left (the server re-runs what its revalidation rules say;
 * on this page, by default, nothing). The commit's lane, a transition
 * (partial-update.ts, mode "stale-revalidation"), is pinned in
 * src/__tests__/partial-update.test.ts.
 */
export async function expectStaleFilledEntryShowsAtOnceThenRevalidates(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "loader");
  await clickWithoutHover(page, "loader");
  await expect(byId(page, "pf-loader-value")).toHaveText("loader.data:1");
  await complete(page);

  await page.goBack();
  await expect(byId(page, "pf-hub")).toBeVisible();
  await settled(page);
  await byId(page, "pf-invalidate").evaluate((button) =>
    (button as HTMLElement).click(),
  );

  const requests = recordPartials(page, hub.pathname("loader"));
  const revalidation = latch();
  await page.route(
    (url) => isPartialFor(url.href, hub.pathname("loader")),
    async (route) => {
      await revalidation.opened;
      await route.continue().catch(() => {});
    },
  );
  const watch = await watchPage(page, ["pf-layout"]);
  await page.goForward();
  await expect(page).toHaveURL(hub.pageUrl("loader"));
  await expect(
    byId(page, "pf-loader-value"),
    "the stale entry is on screen while it revalidates",
  ).toHaveText("loader.data:1");
  await expect.poll(() => requests.length, "it revalidates").toBe(1);

  revalidation.open();
  await (await requests[0]!.response())?.finished();
  await complete(page);
  const seen = await watch.stop();
  const counts = await hub.counts();
  await expect(
    byId(page, "pf-loader-value"),
    "the page shows what the revalidation left: a loader it ran, its new value",
  ).toHaveText(`loader.data:${counts["loader.data"]}`);

  expect(kindsOf(requests), "one ordinary request").toEqual(["navigation"]);
  expect(
    new URL(requests[0]!.url()).searchParams.get("_rsc_stale"),
    "the stale entry's revalidation",
  ).toBe("true");
  expect(seen.fallbacks, "no fallback showed").toEqual([]);
  expect(seen.remounted, "nothing was mounted again").toEqual([]);
  expect(seen.hidden).toEqual([]);
  expect(seen.blank, "the page was never blank").toBe(false);
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
 * The server is this far away for every request of an in-flight click and of
 * the plain click it is compared with, the prefetch included, and the click
 * comes this long after its prefetch left. So the prefetch has 200 ms of the
 * way left, plus the server's time, when the click adopts it.
 */
const IN_FLIGHT_LATENCY_MS = 300;
const IN_FLIGHT_CLICK_AFTER_MS = 100;

/**
 * The spare on both in-flight bounds: `PARITY_MARGIN_MS`, the noise allowed
 * between two clicks. Measured over 60 pairs (5 per case, mode and app), the
 * adopted page was 99 to 337 ms ahead of the plain one (`loader`, `unit`),
 * and the completed page at most 36 ms past the plain click's plus what was
 * left of the prefetch (`bare` in development; 10 ms in production).
 */
const IN_FLIGHT_MARGIN_MS = 100;

export interface PrefetchFalseInFlightCase {
  /** The link, clicked while its prefetch has not answered. */
  name: string;
  /** The case to stand on before the click. Default: the hub. */
  from?: string;
  /**
   * The deferred read has no boundary, so the page shows with its value:
   * the whole page is the deferred part, and only its bound applies.
   */
  pageIsDeferred?: boolean;
}

/** A plain click and the same click on a prefetch that has not answered. */
export interface PrefetchFalseInFlightPair {
  plain: PrefetchFalseClick;
  adopted: PrefetchFalseClick;
  /**
   * From the adopted click to the prefetch's response headers, on the page's
   * clock: what was left of the prefetch, which the click waits for.
   */
  remainingMs: number;
}

/**
 * A click while its prefetch is still in flight adopts that prefetch: one
 * prefetch and one fill, no navigation request of its own. That is the
 * maintainer's call, kept as it was before the flag: the in-flight prefetch
 * is reused, and when its answer has holes the click sends the fill after it,
 * so the deferred part shows its fallback until the fill lands. Such a click
 * can complete later than a plain one, by up to what was left of the
 * prefetch: the price an app pays for keeping expensive work out of every
 * prefetch. The bounds keep that price from growing:
 *
 * - the page appears no later than the plain click's, `IN_FLIGHT_MARGIN_MS`
 *   to spare (a prefetch that left before the click answers before a request
 *   sent with it);
 * - the page completes no later than the plain click's plus what was left of
 *   the prefetch (`remainingMs`), with the same margin.
 *
 * Both clicks run with the server `IN_FLIGHT_LATENCY_MS` away for every
 * request: a prefetch held on its own would be later than a plain request
 * only because the test made it so. A pair outside a bound is recorded
 * again, up to `PARITY_PAIRS` pairs, as the parity cases are.
 */
export async function expectClickDuringThePrefetchStaysWithinItsBound(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseInFlightCase,
  hooks: { onRepeat?: (late: string) => void } = {},
): Promise<PrefetchFalseInFlightPair> {
  const outside = ({
    plain,
    adopted,
    remainingMs,
  }: PrefetchFalseInFlightPair): string[] => {
    const late: string[] = [];
    if (
      !spec.pageIsDeferred &&
      adopted.firstChangeAt > plain.firstChangeAt + IN_FLIGHT_MARGIN_MS
    ) {
      late.push(
        `the page appeared at ${adopted.firstChangeAt} ms, the plain click's at ${plain.firstChangeAt}`,
      );
    }
    if (
      adopted.completeAt >
      plain.completeAt + remainingMs + IN_FLIGHT_MARGIN_MS
    ) {
      late.push(
        `the page completed at ${adopted.completeAt} ms, the plain click's at ${plain.completeAt} with ${remainingMs} ms of the prefetch left`,
      );
    }
    return late;
  };

  const first = await recordInFlightPair(page, fixture, spec);
  const { plain, adopted, remainingMs } = first;
  expect(plain.requests, "the plain click is one navigation").toEqual([
    "navigation",
  ]);
  expect(
    adopted.requests,
    "the click adopted the prefetch it found in flight",
  ).toEqual(["prefetch", "fill"]);
  expect(
    remainingMs,
    "the prefetch had not answered when the click came",
  ).toBeGreaterThan(0);
  expect(adopted.ran[`${spec.name}.data`], "the fill ran the loader").toBe(1);
  for (const [work, runs] of Object.entries(adopted.ran)) {
    expect(
      runs,
      `${work}: no more runs than the plain click`,
    ).toBeLessThanOrEqual(plain.ran[work] ?? 0);
  }
  expect(adopted.blank, "the page was never blank").toBe(false);

  const pairs = [first];
  let late = outside(first);
  while (late.length > 0 && pairs.length < PARITY_PAIRS) {
    hooks.onRepeat?.(`pair ${pairs.length}: ${late.join("; ")}`);
    const next = await recordInFlightPair(page, fixture, spec);
    pairs.push(next);
    late = outside(next);
  }
  expect(
    late,
    pairs
      .map(
        (pair, index) =>
          `pair ${index + 1}: ${outside(pair).join("; ") || "within the bounds"}\n${describeInFlightPair(pair)}`,
      )
      .join("\n"),
  ).toEqual([]);
  return pairs[pairs.length - 1]!;
}

export function describeInFlightPair(pair: PrefetchFalseInFlightPair): string {
  return `  remaining ${pair.remainingMs} ms\n${describePair(pair)}`;
}

/** The two clicks of `expectClickDuringThePrefetchStaysWithinItsBound`. */
async function recordInFlightPair(
  page: Page,
  fixture: PrefetchFalseFixture,
  { name, from }: PrefetchFalseInFlightCase,
): Promise<PrefetchFalseInFlightPair> {
  const click = async (
    inFlight: boolean,
  ): Promise<{ click: PrefetchFalseClick; remainingMs: number }> => {
    const hub = await openHub(page, fixture);
    if (from) {
      await clickWithoutHover(page, from);
      await expect(byId(page, `pf-${from}-value`)).toBeVisible();
      await complete(page);
    }
    const before = await hub.counts();
    const requests = recordPartials(page, hub.pathname(name));
    const near = await farAway(page, IN_FLIGHT_LATENCY_MS);
    const watch = await watchPage(page, ["pf-layout"]);
    await page.evaluate(() =>
      document.addEventListener(
        "click",
        () => {
          (window as unknown as { __pfClickAt: number }).__pfClickAt =
            performance.now();
        },
        { capture: true, once: true },
      ),
    );
    if (inFlight) {
      await page.mouse.move(0, 0);
      await byId(page, `pf-link-${name}`).hover();
      await expect.poll(() => requests.length, "the prefetch left").toBe(1);
      await page.waitForTimeout(IN_FLIGHT_CLICK_AFTER_MS);
    }
    await clickWithoutHover(page, name);
    await expect(page).toHaveURL(hub.pageUrl(name));
    await expect(byId(page, `pf-${name}-value`)).toBeVisible({
      timeout: 15_000,
    });
    await complete(page);
    const seen = await watch.stop();
    await near();
    // Resource Timing has the entry once the response has streamed.
    const remainingMs = inFlight
      ? await page.evaluate((url) => {
          const entry = performance.getEntriesByName(url)[0] as
            | PerformanceResourceTiming
            | undefined;
          const at = (window as unknown as { __pfClickAt?: number })
            .__pfClickAt;
          return entry && at !== undefined
            ? Math.round(entry.responseStart - at)
            : Number.NaN;
        }, requests[0]!.url())
      : 0;
    const after = await hub.counts();
    const ran: Record<string, number> = {};
    for (const [work, runs] of Object.entries(after)) {
      if (runs !== (before[work] ?? 0)) ran[work] = runs - (before[work] ?? 0);
    }
    return {
      click: { ...seen, requests: kindsOf(requests), ran },
      remainingMs,
    };
  };

  const plain = await click(false);
  const adopted = await click(true);
  return {
    plain: plain.click,
    adopted: adopted.click,
    remainingMs: adopted.remainingMs,
  };
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
      if (isPrefetch(route.request())) {
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
  // Provoked on purpose (console guard, console-guard.ts). A fill React
  // holds the click for (vt-unit) fails as the navigation it completes.
  expectConsole(page, {
    allow: [
      /\[rango\] fill failed: NetworkError|\[Browser\] Network error during navigation: NetworkError/,
      /\[RootErrorBoundary\] Unhandled error caught: NetworkError/,
    ],
  });
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, name);
  await page.route(isFill, (route) => route.abort("failed"));

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
  // Provoked on purpose (console guard, console-guard.ts).
  expectConsole(page, {
    allow: [
      /\[rango\] fill failed: Error: Connection closed/,
      /\[RootErrorBoundary\] Unhandled error caught: Error: Connection closed/,
    ],
  });
  const hub = await openHub(page, fixture);
  await prefetchCase(page, hub, "loader");
  await page.route(isFill, (route) =>
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
  const fromCache = await watchHttpCache(page, hub.pathname("unit"));

  await page.goto(hub.pageUrl("loader"), { waitUntil: "commit" });
  await awaitHydrated(page);
  await prefetchCase(page, hub, "unit");
  expect(fromCache, "the first prefetch is the server's").toEqual([false]);
  expect((await hub.counts())["unit.data"] ?? 0).toBe(0);

  await page.goto(fixture.url("/"));
  const requests = recordPartials(page, hub.pathname("unit"));
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(hub.pageUrl("loader"));
  await awaitHydrated(page);

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
  /**
   * When a fallback showed or hid: the set of visible fallback nodes
   * changed. React commits no Suspense retry sooner than 300 ms after the
   * last such commit, page-wide (`reactHold`).
   */
  fallbackEventsAt: number[];
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
  /** The `order` entries that first showed inside `container`. */
  inside: string[];
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
  /** When the address bar left the page's pathname. null: it never did. */
  urlAt: number | null;
  /**
   * When a URL hook on the page being left moved: `pf-nav` prints
   * `useNavigation().location.pathname`. null: it never did.
   */
  hookAt: number | null;
  /**
   * When the last element with `data-pending="true"` went (a clientUrls()
   * group layout prints `useOutlet().pending` there). null: none showed.
   */
  pendingEndAt: number | null;
}

/**
 * Record what a reader could see from now until `stop()`. Installed in the
 * page before the click, on a MutationObserver and a frame poll, so a state
 * that shows for one frame is recorded: an assertion made after the fact
 * would miss it. Time runs from the next click.
 *
 * `held`: test ids of elements on screen now that the next page keeps. Each
 * is watched by node identity: detached, replaced or hidden counts.
 * `container`: a test id whose descendants are listed in `inside`.
 */
async function watchPage(
  page: Page,
  held: string[],
  container?: string,
): Promise<{ stop: () => Promise<PrefetchFalseObservation> }> {
  await page.evaluate(
    ([heldIds, within]) => {
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
      const inside: string[] = [];
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
      const fallbackEventsAt: number[] = [];
      let fallbackNodes = new Set<Element>();
      const viewTransitionsAt: number[] = [];
      const hookOf = (): string | null | undefined =>
        find("pf-nav")?.getAttribute("data-path");
      const startPath = location.pathname;
      const startHook = hookOf();
      let urlAt: number | null = null;
      let hookAt: number | null = null;
      let pendingWas = false;
      let pendingEndAt: number | null = null;
      const readUrl = (): void => {
        if (urlAt === null && location.pathname !== startPath) urlAt = now();
      };
      // A history write changes no DOM: read it where it is made.
      const writes = (["pushState", "replaceState"] as const).map(
        (name) => [name, history[name]] as const,
      );
      for (const [name, write] of writes) {
        history[name] = function (...args: Parameters<typeof write>) {
          write.apply(history, args);
          readUrl();
        };
      }

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
        readUrl();
        if (hookAt === null && hookOf() !== startHook) hookAt = now();
        const pendingNow = [
          ...document.querySelectorAll('[data-pending="true"]'),
        ].some(visible);
        if (clicked && pendingWas && !pendingNow) pendingEndAt = now();
        pendingWas = pendingNow;
        let fallbackShowing = false;
        const showing = new Set<string>();
        const showingNodes = new Set<Element>();
        for (const el of document.querySelectorAll('[data-testid^="pf-"]')) {
          if (!visible(el)) continue;
          const id = el.getAttribute("data-testid")!;
          if (id.startsWith("pf-link-")) continue;
          if (!nodes.has(id)) nodes.set(id, new Set());
          nodes.get(id)!.add(el);
          if (!order.includes(id)) {
            order.push(id);
            seenAt.push(now());
            if (
              within &&
              el.parentElement?.closest(`[data-testid="${within}"]`)
            ) {
              inside.push(id);
            }
          }
          if (id.endsWith("-fallback") || id.endsWith("-loading")) {
            fallbacks.add(id);
            fallbackShowing = true;
            showing.add(id);
            showingNodes.add(el);
            if (!shownSince.has(id)) shownSince.set(id, now());
          }
        }
        // By node: a fallback that hides as another of the same id shows
        // (a skeleton mounted a second time inside its layout) is a change.
        if (
          showingNodes.size !== fallbackNodes.size ||
          [...showingNodes].some((node) => !fallbackNodes.has(node))
        ) {
          if (clicked) fallbackEventsAt.push(now());
          fallbackNodes = showingNodes;
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
        for (const [name, write] of writes) history[name] = write;
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
          fallbackEventsAt,
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
          inside,
          nav,
          navAt,
          quietMs,
          viewTransitions: viewTransitionsAt.length,
          viewTransitionsAt,
          urlAt,
          hookAt,
          pendingEndAt,
        };
      };
    },
    [held, container] as const,
  );
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
    await sleep(ms);
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
  const isHubPrefetch = (request: Request): boolean =>
    isPartialFor(request.url(), hub.pathname(name)) && isPrefetch(request);

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

  const held = latch();
  if (spec.inFlight) {
    await page.goBack();
    await expect(byId(page, "pf-hub")).toBeVisible();
    await settled(page);
    await page.route(
      (url) => isPartialFor(url.href, hub.pathname(name)),
      async (route) => {
        if (isHubPrefetch(route.request())) await held.opened;
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
    held.open();
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
 * The click that adopts builds the page's tree once: the fill resolves what
 * that tree is waiting for and hands React no tree of its own. So nothing on
 * the page exists twice from the click to the completed page: not the
 * fallback, not a layout the prefetch rendered, not the content the fill
 * brings, and the hub layout the page keeps stays the node it was.
 *
 * Scar tissue: the fill used to render a second tree and commit it. Where
 * that tree's wrappers or promises differed from the first one's, a fallback
 * was mounted a second time.
 */
export async function expectAdoptedClickBuildsThePageOnce(
  page: Page,
  fixture: PrefetchFalseFixture,
  name: string,
  production: boolean,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname(name));
  await prefetchCase(page, hub, name);

  const watch = await watchPage(page, ["pf-layout"]);
  await resetSuspenseAudit(page);
  await clickWithoutHover(page, name);
  await expect(byId(page, `pf-${name}-value`)).toBeVisible();
  await expect(page).toHaveURL(hub.pageUrl(name));
  await complete(page);
  const seen = await watch.stop();

  expect(kindsOf(requests)).toEqual(["prefetch", "fill"]);
  expect(seen.remounted, "an element was mounted a second time").toEqual([]);
  expect(seen.hidden, "the layout the page keeps stayed").toEqual([]);
  expect(seen.blank, "the page was never blank").toBe(false);

  // Dev only (a build carries no audit): the suspense audit
  // (src/suspense-audit.ts) counts the trees React is handed. The click's is
  // the one; the fill resolves gates. The audit reports two microtasks after
  // a mount.
  if (production) return;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const audit = await readSuspenseAudit(page);
  expect(audit, "a dev build exposes the suspense audit").not.toBeNull();
  expect(
    audit!.treeUpdates,
    "one tree update, the click's: the fill hands React none",
  ).toEqual({ navigation: 1 });
  const { swaps, untracked, idleFallbacks, resuspended } = audit!;
  const { remounts, drifts, uncaused, mutations } = audit!;
  expect(
    {
      swaps,
      untracked,
      idleFallbacks,
      resuspended,
      remounts,
      drifts,
      uncaused,
      mutations,
    },
    JSON.stringify(audit!.events),
  ).toEqual({
    swaps: 0,
    untracked: 0,
    idleFallbacks: 0,
    resuspended: 0,
    remounts: 0,
    drifts: 0,
    uncaused: 0,
    mutations: 0,
  });
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
 * A flagged loader with its own `cache()` that its route's handler reads
 * (`read-cached`). The handler needs the value, so the prefetch runs the
 * loader, and it starts it through its `cache()`, as a plain navigation
 * does: what the handler read (pf-read-cached-read) and the loader's own
 * segment (pf-read-cached-value) are one value from one run, nothing is
 * deferred and the click sends nothing. A later visit's prefetch reads the
 * entry the first one stored: the loader does not run again.
 *
 * Scar tissue: the handler's read ran the loader without its cache(), and
 * the segment delivered afterwards read the entry. On the second visit the
 * page showed the loader's second run beside the entry's first, and the
 * loader ran once more than on a plain navigation.
 */
export async function expectHandlerReadFlaggedLoaderUsesItsCache(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const name = "read-cached";
  const counters = [`${name}.data`, `${name}.handler`];
  let hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname(name));
  for (const visit of [1, 2]) {
    // Another query for the second visit: the browser keeps a prefetch that
    // defers nothing (`max-age`) and would answer the same URL from its copy.
    // The entry is keyed by the run alone, so the query does not split it.
    if (visit === 2) hub = await openHub(page, fixture, hub.run, { delay: 1 });
    await prefetchCase(page, hub, name);
    expect(
      pick(await hub.counts(), counters),
      visit === 1
        ? "the prefetch ran the loader once, for the handler"
        : "the second prefetch read the stored entry",
    ).toEqual({ [`${name}.data`]: 1, [`${name}.handler`]: visit });

    await byId(page, `pf-link-${name}`).click();
    await expect(page).toHaveURL(hub.pageUrl(name));
    await expect(byId(page, `pf-${name}-read`)).toHaveText(`${name}.data:1`);
    await expect(byId(page, `pf-${name}-value`)).toHaveText(`${name}.data:1`);
    expect(
      kindsOf(requests),
      "nothing was deferred: the click sent nothing",
    ).toEqual(visit === 1 ? ["prefetch"] : ["prefetch", "prefetch"]);
  }
  expect(pick(await hub.counts(), counters)).toEqual({
    [`${name}.data`]: 1,
    [`${name}.handler`]: 2,
  });
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
  /**
   * Fallbacks inside the deferred part that the adopted click may show and
   * the plain click not. The adopted click reveals the deferred part as soon
   * as its fill has answered, a response earlier than the plain click, so a
   * read inside it that lands later shows its own fallback first. That is the
   * design (the maintainer's bar, 2026-10-11): what shows after the click is
   * React's to decide.
   */
  deferredFallbacks?: string[];
  /** How many view transitions the plain click starts, where a case pins it. */
  viewTransitions?: number;
  /**
   * A clientUrls() click inside its group. Both clicks present the
   * destination at the click (client-urls/navigation.ts), so the plain click
   * changes the page before its response can, and both commit the
   * canonical tree in a transition: `useNavigation()` and its location move
   * with the router's commit there, as the address bar does, not with a page
   * React holds, so the URL hook is not compared (the group's own
   * `useOutlet().pending` is). The adopted click renders the swap and the
   * canonical tree together, so it may animate a first change that the plain
   * click splits in two (the swap, then a canonical commit that changes
   * nothing the page box shows): it starts no more view transitions than the
   * plain click and animates no fewer changes.
   */
  optimistic?: boolean;
  /**
   * The page shows when the fill answers, not with the click. A deferred
   * unit on a page that commits in a transition: the click waits for its
   * fill and commits with the fill's first chunk, as the plain click commits
   * with its response (`expectUnitUnderTransitionCommitsWithItsFill`). Or a
   * read with no boundary, where React holds the committed tree. Default:
   * the adopted click shows the page, or its skeleton, with the click.
   */
  commitsWithFill?: boolean;
  /**
   * Every RSC request of the click waits this many ms in the browser before
   * it is sent, on top of `server`, so a response's first chunk and
   * everything streamed behind it arrive that much later. The prefetch is
   * made before, with no such wait: it is not part of the click.
   */
  latency?: number;
  /**
   * A flagged layout entered from a page that does not hold it. The
   * maintainer's expectation replaces the plain click's time for the layout:
   * its skeleton (`fallback`) is the click's first change and shows with the
   * click; the layout (`layout`) shows once what the layout's loading()
   * covers has arrived, with `content` (the covered route's) in the same
   * frame, at least React's 300 ms after the skeleton, and no later than the
   * plain click shows the covered part, or React's 300 ms, with the margin.
   * Everything else is compared with the plain click as in any case. The
   * skeleton is the one fallback the plain click need not show.
   */
  skeleton?: { fallback: string; layout: string; content?: string };
  /**
   * A fallback below the layout that a loading() of its own or an app's
   * <Suspense> places: it shows inside the layout, in the frame the layout
   * shows, as on the plain click.
   */
  innerFallback?: string;
  /**
   * A gap that is known and not fixed. The case runs all the same: every
   * comparison the gap does not break has to hold, the gap's bound has to
   * hold, and one comparison it breaks has to fail. So the report shows an
   * expected failure, and an unexpected pass the day the gap is closed.
   */
  open?: PrefetchFalseOpenGap;
  /**
   * The gap does not show in every app: where every comparison holds the
   * case passes, and where the gap breaks one it is an expected failure.
   * Another case of the same gap shows its closing.
   */
  openWhereItShows?: boolean;
}

/** One comparison of `expectAdoptedClickIsNeverWorseThanAPlainClick`. */
export type PrefetchFalseParityRule =
  /** A fallback the plain click does not show. */
  | "fallback"
  /** Content hidden or detached, a blank page, a remount. */
  | "kept"
  /** View transitions the plain click does not start. */
  | "transitions"
  /** Server work, or a request, the plain click does not make. */
  | "work"
  /** The case itself: a latency that reached no click, a pinned count. */
  | "setup"
  /** Later than the plain click in every pair. */
  | "late"
  /** The page, or its skeleton, did not show at the click in every pair. */
  | "click"
  /** A URL hook further ahead of the page than in the plain click. */
  | "hook"
  /** An open gap grew past the bound it is held to. */
  | "bound"
  /** A flagged layout's skeleton and layout, against the expectation. */
  | "skeleton"
  /** An error React logged in development during either click. */
  | "react";

export interface PrefetchFalseOpenGap {
  /** Why the case is open, as the report prints it. */
  reason: string;
  /** The comparisons the gap breaks. Every other one still has to hold. */
  breaks: PrefetchFalseParityRule[];
  /**
   * What keeps the gap from growing, checked on the first pair before the
   * case is marked as an expected failure: what is outside the bound.
   */
  bound: (pair: PrefetchFalsePair, spec: PrefetchFalseParityCase) => string[];
}

/**
 * A view transition takes about this long when the page sets no duration
 * (`&vtms=`): Chrome's default animation is 250 ms, and its capture frames
 * come on top.
 */
const DEFAULT_TRANSITION_MS = 300;

/**
 * OPEN, accepted as React's behaviour (#1078, the maintainer's call of
 * 2026-10-11): a `<ViewTransition>` of the app's own is mounted across the
 * click, and the server is far enough that the fill answers after React's
 * throttle has run out (the fallback has been up since the click). The hole
 * resolves with the fill's first chunk, with a node or a stream that is still
 * pending; React retries the boundary, the retry suspends again, and React
 * commits it with the fallback in place (R-throttle, second half). That
 * commit starts a view transition that changes nothing (R-start), and the
 * reveal waits for it (R-wait). With the server near the first retry has
 * everything, and none of it shows.
 *
 * Measured in production, router app, the server 300 ms away, plain against
 * adopted: `unit` starts view transitions at 616 against 304 and 602 ms and
 * completes at 636 against 621; with 600 ms transitions, at 616 against 305
 * and 949 ms, complete at 631 against 966. `loader` the same, after the
 * handle push's own transition both clicks start.
 *
 * Its bound: one view transition more than the plain click at most, as many
 * that change the page, and the page complete no later than the plain
 * click's plus one view transition (`vtms`, or `DEFAULT_TRANSITION_MS`) plus
 * `PARITY_MARGIN_MS`. Measured over both apps and modes: 261 to 335 ms past
 * the plain click at 600 ms (the bound is 700), from 72 ms sooner to 18 ms
 * later at the default duration (400).
 */
const OPEN_RETRY_TRANSITION: PrefetchFalseOpenGap = {
  reason:
    "#1078: with an app <ViewTransition> mounted, React commits the hole's retry with its fallback in place once its throttle is up, that commit starts a view transition that changes nothing, and the reveal waits for it",
  breaks: ["transitions", "late"],
  bound: ({ plain, adopted }, spec) => {
    const outside: string[] = [];
    if (adopted.viewTransitions > plain.viewTransitions + 1) {
      outside.push(
        `view transitions: the plain navigation starts ${plain.viewTransitions}, the adopted click ${adopted.viewTransitions}, more than one more`,
      );
    }
    if (animatedChanges(adopted) !== animatedChanges(plain)) {
      outside.push(
        `view transitions that change the page: the plain navigation ${animatedChanges(plain)}, the adopted click ${animatedChanges(adopted)}`,
      );
    }
    const duration = spec.vtms ?? DEFAULT_TRANSITION_MS;
    if (adopted.completeAt > plain.completeAt + duration + PARITY_MARGIN_MS) {
      outside.push(
        `the completed page at ${adopted.completeAt} ms, past the plain click's ${plain.completeAt} plus one view transition (${duration} ms) and the margin`,
      );
    }
    return outside;
  },
};

/**
 * A click into the section, whose layout's `loading()` is flagged, from a
 * page that does not hold the layout: the layout's handler is deferred with
 * everything below it, and the maintainer chose its skeleton with the click
 * over holding the page being left. A plain click in a production build
 * shows the layout with its first chunk (#1080) and the fallback inside it,
 * so the two clicks differ there by design. Measured in production (router
 * app), plain against adopted, when the layout shows: `hub to section` 12
 * and 304 ms, `vt to section` 3 and 303, with a 600 ms layout handler 608
 * and 706 (the content at 909 and 706).
 */
function layoutSkeleton(
  spec: PrefetchFalseParityCase,
): PrefetchFalseParityCase["skeleton"] {
  if (spec.name === "outer") {
    return {
      fallback: "pf-outer-fallback",
      layout: "pf-outer-inner-layout",
      content: "pf-outer-page",
    };
  }
  if (!SECTION_PAGES.includes(spec.name) || spec.from === "section") {
    return undefined;
  }
  return {
    fallback: "pf-section-fallback",
    layout: "pf-section-layout",
    // `section-own` has a loading() of its own: the layout covers nothing
    // of it. `section-read` reads its loader in an app <Suspense>: the
    // layout covers the page, not the value.
    ...(spec.name === "section-read"
      ? { content: "pf-section-read-page" }
      : spec.name !== "section-own" && { content: `pf-${spec.name}-value` }),
  };
}

/** A child route's loader this much slower takes 1.5 s. */
const SLOW_CHILD_DELAY_MS = 1400;

/** The app's own fallback around `section-suspense`'s slow read. */
const SUSPENSE_FALLBACK = "pf-section-suspense-slow-fallback";

/** The app's own fallback around `section-read`'s loader read. */
const READ_FALLBACK = "pf-section-read-fallback";

const IN_SECTION = { from: "section", held: ["pf-section-layout"] };
const BESIDE_SLOT = { held: ["pf-slot-layout", "pf-slot-side"] };

/**
 * A page React holds for a read with no boundary (R11): nothing on it
 * changes at the click, and the page shows with the fill's value, when the
 * plain click's does.
 */
const HELD: Pick<PrefetchFalseParityCase, "commitsWithFill"> = {
  commitsWithFill: true,
};

const PARITY_CLICKS: PrefetchFalseParityCase[] = [
  { name: "loader", ownFallback: "pf-loader-fallback" },
  { name: "unit" },
  { name: "section" },
  { name: "section-plain" },
  { name: "section-own" },
  { name: "section-cached" },
  // An app <Suspense> around a 1.5 s read in the page below the layout.
  { name: "section-suspense", innerFallback: SUSPENSE_FALLBACK },
  // The route's loader read in an app <Suspense>, no loading() of its own.
  { name: "section-read" },
  // A flagged loader above a flagged layout: a gate outside the layout's
  // unit, read in the app's own <Suspense>.
  { name: "outer", ownFallback: "pf-outer-early-fallback" },
  { name: "slot" },
  { name: "slot-b" },
  { name: "bare", ...HELD },
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
  { name: "inner", deferredFallbacks: ["pf-inner-late-fallback"] },
  {
    name: "vt-inner",
    commitsWithFill: true,
    deferredFallbacks: ["pf-vt-inner-late-fallback"],
  },
  {
    name: "nested",
    ownFallback: "pf-nested-outer-fallback",
    deferredFallbacks: ["pf-nested-late-fallback"],
  },
  // The unit's loader is read above its fallback, with no boundary.
  { name: "above", ...HELD },
  // A read with no boundary in a response that stays open behind it.
  {
    name: "bare-inner",
    ...HELD,
    deferredFallbacks: ["pf-bare-inner-late-fallback"],
  },
  // A flagged layout whose route has transition().
  { name: "vt-below", commitsWithFill: true },
  // A read behind its own boundary, on a route with no loading().
  { name: "own" },
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
 * How long the server takes before its first byte, for every request of
 * every parity case: the fixture's `&server=` middleware. A local server
 * answers in a few ms, and at that distance React's 300 ms fallback throttle
 * is the slowest thing on the page: it holds the reveal of both clicks, and
 * the round trip a prefetch saves cannot show. At 300 ms it shows, and that
 * is what the cases measure.
 */
const SERVER_MS = 300;

/**
 * The server for `LATENCY_CLICKS`, once more: the same clicks at a second
 * distance, with the `WINDOW_DELAY_MS` column added.
 */
const FAR_SERVER_MS = 500;

/**
 * A loader this much slower lands 400 ms into its response: 700 ms after
 * the click with the server `SERVER_MS` away, 900 at `FAR_SERVER_MS`. The
 * plain click's fallback goes up with its response, so React's first reveal
 * of it comes 300 ms into the response: this loader misses it by 100 ms,
 * and the 100 ms loader of the base column makes it by 200, so neither
 * column is a coin flip. Not 200 ms: a loader that lands 300 ms into its
 * response lands on that reveal, and a nested boundary reveals in either
 * order, in the plain click too.
 */
const MID_DELAY_MS = 300;

/**
 * A loader this much slower lands 250 ms into its response, 50 ms before
 * the plain click's first reveal (its fallback went up with the response,
 * and React keeps it 300 ms). The adopted click's fallback went up with the
 * click, so its throttle has long run out: it shows the value when it
 * lands, the plain click 50 ms later.
 */
const WINDOW_DELAY_MS = 150;

/** The pages below the section layout, whose `loading()` is flagged. */
const SECTION_PAGES = [
  "section",
  "section-plain",
  "section-own",
  "section-cached",
  "section-suspense",
  "section-read",
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

/** The clicks from the hub that are also made with the server `FAR_SERVER_MS` away. */
const LATENCY_CLICKS = [
  "loader",
  "unit",
  "section",
  "section-own",
  "vt-unit",
  "inner",
  "vt-inner",
  "nested",
  "vt-below",
];

/**
 * A view transition this long outlasts the 300 ms React keeps a fallback up
 * (the default is about 250 ms, which does not).
 */
const LONG_TRANSITION_MS = 600;

/**
 * Clicks made while a `<ViewTransition>` is mounted on the page being left:
 * the router's own on `vt` (a route with `transition()`), or one of the
 * app's in the hub layout. Each with the default duration and with
 * `LONG_TRANSITION_MS`.
 */
const BOUNDARY_CLICKS: PrefetchFalseParityCase[] = [
  { name: "unit", from: "vt" },
  { name: "section", from: "vt" },
  { name: "loader", from: "vt", ownFallback: "pf-loader-fallback" },
  { name: "unit", boundary: true, open: OPEN_RETRY_TRANSITION },
  {
    name: "loader",
    boundary: true,
    ownFallback: "pf-loader-fallback",
    open: OPEN_RETRY_TRANSITION,
  },
];

/** The fill's head held about a second: far above every margin. */
const HEAD_HELD_MS = 1000;

/** Clicks React holds until the fill answers, with the fill a second away. */
const HEAD_HELD_CLICKS: PrefetchFalseParityCase[] = [
  { name: "vt-unit", commitsWithFill: true, latency: HEAD_HELD_MS },
  { name: "bare", ...HELD, latency: HEAD_HELD_MS },
];

/**
 * The fixture's cases, as `expectAdoptedClickIsNeverWorseThanAPlainClick`
 * runs them, every one with the server `SERVER_MS` away: every click with
 * fast loaders (100 ms), with loaders 300 ms slower (`MID_DELAY_MS`) and
 * with slow ones (`&slow=1`); the clicks inside the section and every click
 * into it (`OUTSIDE_SECTION`) with a slow layout handler (`&hslow=1`), where
 * the plain click holds the page it is on until the handler returns;
 * `LATENCY_CLICKS` again with the server `FAR_SERVER_MS` away and loaders
 * that land well before the plain click's first reveal, just before it
 * (`WINDOW_DELAY_MS`), after it and long after it; `BOUNDARY_CLICKS` with
 * both durations; and `HEAD_HELD_CLICKS`.
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
    SECTION_PAGES.map((name) => ({
      name,
      ...source,
      hslow: true,
      ...(name === "section-suspense" && { innerFallback: SUSPENSE_FALLBACK }),
    })),
  ),
  ...[{}, { from: "control" }].flatMap((source) => [
    {
      name: "section-own",
      ...source,
      delay: SLOW_CHILD_DELAY_MS,
      innerFallback: "pf-section-own-fallback",
    },
    {
      name: "section-read",
      ...source,
      delay: SLOW_CHILD_DELAY_MS,
      innerFallback: READ_FALLBACK,
    },
    // The read with no boundary of the app's own: React suspends it to the
    // nearest one.
    { name: "section", ...source, delay: SLOW_CHILD_DELAY_MS },
  ]),
  // The outer read lands long before the inner layout's own loader.
  { name: "outer", ownFallback: "pf-outer-early-fallback", hslow: true },
  ...PARITY_CLICKS.filter(
    (spec) => !spec.from && LATENCY_CLICKS.includes(spec.name),
  ).flatMap((spec) => [
    ...[0, WINDOW_DELAY_MS, MID_DELAY_MS].map((delay) => ({
      ...spec,
      server: FAR_SERVER_MS,
      ...(delay > 0 && { delay }),
    })),
    { ...spec, server: FAR_SERVER_MS, slow: true },
  ]),
  ...BOUNDARY_CLICKS.flatMap((spec) => [
    spec,
    {
      ...spec,
      vtms: LONG_TRANSITION_MS,
      // In the router app the handle push of `loader`'s handler starts a view
      // transition of its own right after the click's commit; at 600 ms it is
      // still running when the fill answers, so the retry waits for it and
      // finds the value (production: transitions at 5 and 662 ms, one
      // reveal). The Cloudflare app shows the gap.
      ...(spec.open && spec.name === "loader" && { openWhereItShows: true }),
    },
  ]),
  ...HEAD_HELD_CLICKS,
].map((spec: PrefetchFalseParityCase) => {
  const skeleton = layoutSkeleton(spec);
  return { server: SERVER_MS, ...spec, ...(skeleton && { skeleton }) };
});

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
    spec.boundary && "an app boundary on screen",
    spec.vtms && `view transitions of ${spec.vtms} ms`,
    spec.server && `the server ${spec.server} ms away`,
    spec.latency && `requests held ${spec.latency} ms more`,
    spec.skeleton && "its layout with the fill",
    spec.open && "open",
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
 * How much further ahead of the page than in the plain click a URL hook may
 * move. Half of `PARITY_MARGIN_MS`: the hook reads React state, so it moves
 * with the commit that shows the page in both clicks (0 to 2 ms ahead,
 * measured on the pages React holds).
 */
const HOOK_LEAD_MARGIN_MS = PARITY_MARGIN_MS / 2;

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
 * The bar (the maintainer's, 2026-10-11): a click that adopts a prefetch
 * shows the next page, or its skeleton, at the click; shows it no later than
 * the same click with no prefetch at all; and adds no wait of its own. What
 * shows after that is React's to decide. The body does the click twice on
 * fresh pages, once as a plain navigation (the link is clicked without being
 * hovered) and once after its prefetch has been received, and records each
 * from the click until the router is idle again.
 *
 * - The first change of the page is within `PARITY_MARGIN_MS` of the click,
 *   except where the page commits with its fill (`commitsWithFill`) or the
 *   click is a plain click (`prefetchedOn`). It is never later than the
 *   plain click's first change.
 * - The page's first content, what the first frame with content in it
 *   shows, is never later than the plain click shows the same elements.
 * - Everything that shows after it is never later than the plain click
 *   shows it, or than React's 300 ms after the last time a fallback showed
 *   or hid on the adopted click, whichever is later (`reactHold`). React
 *   commits no Suspense retry sooner than that, page-wide
 *   (FALLBACK_THROTTLE_MS), so a value held to it is React's choice; a value
 *   held past both is a wait the router added. The completed page, the last
 *   fallback gone and the time `useNavigation()` reads idle on an incomplete
 *   page are bounded the same way.
 * - A fallback shows with the prefetch only where the plain navigation shows
 *   the same fallback, or where it waits for deferred work: the read's own
 *   (`ownFallback`), one inside the deferred part (`deferredFallbacks`), a
 *   flagged layout's skeleton. The adopted click reveals the deferred part a
 *   response sooner, so a read inside it that lands later shows its own
 *   fallback first: intended, not a parity failure.
 * - Content that was on screen and belongs to the new page is never
 *   detached or hidden, the page is never blank, and nothing is unmounted
 *   and mounted again (a fallback included) that a plain click keeps.
 * - The click runs no server work a plain click does not run, starts no
 *   view transition a plain click does not start, and as many that change
 *   the page (`animatedChanges`).
 * - The URL hooks do not move further ahead of the page than in the plain
 *   click (`HOOK_LEAD_MARGIN_MS`). The address bar is not compared: it moves
 *   when the router commits the navigation (`commit` in
 *   navigation-transaction.ts updates the store and the URL together),
 *   before React shows a page it holds, on every navigation; `prefetch:
 *   false` moves that commit to the click. Under the bar that is feedback
 *   at the click (the maintainer's call, 2026-10-11).
 * - A case with `skeleton` (a flagged layout entered from outside) shows the
 *   layout's skeleton first, within `PARITY_MARGIN_MS` of the click, and the
 *   layout in the same frame as the content its loading() covers
 *   (`SAME_FRAME_MS`), no sooner than `SKELETON_MIN_MS` after the skeleton.
 *   The layout's own time is compared with the plain click's covered content,
 *   or React's 300 ms after the skeleton when that is later.
 *
 * Every case runs with the server some way off (`server`): with a local
 * server answering in a few ms, React's throttle, not the round trip, decides
 * when anything shows, and the comparison says nothing about what a prefetch
 * saves.
 *
 * Times are compared with `PARITY_MARGIN_MS` to spare. A pair that is later
 * than that is recorded again, up to `PARITY_PAIRS` pairs: the case fails
 * when every pair is late. So a lateness that shows in one pair of three
 * passes, by design: the retry is there for a click the machine delayed, and
 * it cannot tell that from a regression that is intermittent. Everything
 * else is judged on the first pair. `onRepeat` is told each time a pair was
 * not enough. A failure lists every broken comparison and every pair.
 *
 * A case with `open` reports its gap: what the gap does not break is
 * asserted first, as for any case, and so is the gap's bound. Then `onOpen`
 * is called (the suite marks the test as an expected failure there) and what
 * the gap breaks is asserted.
 *
 * Returns the first pair, for a case that pins more.
 */
export async function expectAdoptedClickIsNeverWorseThanAPlainClick(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseParityCase,
  hooks: {
    onRepeat?: (late: string) => void;
    onOpen?: (gap: PrefetchFalseOpenGap) => void;
  } = {},
): Promise<PrefetchFalsePair> {
  // A reader whose use() went away at the same place: React logs it once
  // per page, in development ("This library called use() to suspend in a
  // previous render but did not call use() when it finished").
  const conditionalUse: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    if (
      message.type() === "error" &&
      message.text().includes("conditional-use-of-use")
    ) {
      conditionalUse.push(message.text());
    }
  };
  page.on("console", onConsole);
  const first = await recordPlainAndAdoptedClick(page, fixture, spec).finally(
    () => page.off("console", onConsole),
  );
  const { plain, adopted } = first;
  // One failure lists everything that is wrong: a click that is late is
  // usually late because of something else in the list.
  const wrong: Broken[] = [];
  const check = (
    rule: PrefetchFalseParityRule,
    ok: boolean,
    what: string,
  ): void => {
    if (!ok) wrong.push({ rule, what });
  };
  check(
    "react",
    conditionalUse.length === 0,
    `React reported a conditional use(): ${conditionalUse[0]}`,
  );

  // Below a flagged layout entered from outside, a loading() of the route's
  // own (or an app's <Suspense>) shows inside the layout, by design, where a
  // development server's plain click can still be on the layout's fallback.
  const inside = spec.skeleton && [
    spec.innerFallback,
    `pf-${spec.name}-fallback`,
  ];
  const added = adopted.fallbacks.filter(
    (id) =>
      !plain.fallbacks.includes(id) &&
      id !== spec.ownFallback &&
      !spec.deferredFallbacks?.includes(id) &&
      id !== spec.skeleton?.fallback &&
      !inside?.includes(id),
  );
  check(
    "fallback",
    added.length === 0,
    `a fallback the plain navigation does not show, for work that was not deferred: ${added.join(", ")}`,
  );
  check(
    "kept",
    adopted.hidden.length === 0,
    `content on screen was detached or hidden: ${adopted.hidden.join(", ")}`,
  );
  check("kept", !adopted.blank, "the page was blank");
  const again = spec.skeleton && skeletonInsideLayout(adopted, spec.skeleton);
  const remounted = adopted.remounted.filter(
    (id) =>
      !plain.remounted.includes(id) &&
      !(again && id === spec.skeleton?.fallback),
  );
  check(
    "kept",
    remounted.length === 0,
    `an element on screen was unmounted and mounted again: ${remounted.join(", ")}`,
  );
  check(
    "transitions",
    adopted.viewTransitions <= plain.viewTransitions,
    `view transitions: the plain navigation starts ${plain.viewTransitions}, the adopted click ${adopted.viewTransitions}`,
  );
  check(
    "transitions",
    spec.optimistic
      ? animatedChanges(adopted) >= animatedChanges(plain)
      : animatedChanges(adopted) === animatedChanges(plain),
    `view transitions that change the page: the plain navigation ${animatedChanges(plain)}, the adopted click ${animatedChanges(adopted)}`,
  );
  check(
    "setup",
    spec.viewTransitions === undefined ||
      plain.viewTransitions === spec.viewTransitions,
    `view transitions of the plain navigation: ${plain.viewTransitions}, expected ${spec.viewTransitions}`,
  );
  for (const [work, runs] of Object.entries(adopted.ran)) {
    check(
      "work",
      runs <= (plain.ran[work] ?? 0),
      `the click ran ${work} more often than the plain click`,
    );
  }
  check(
    "work",
    !spec.prefetchedOn || adopted.requests.join() === plain.requests.join(),
    "a prefetch made on another page was adopted",
  );
  const away = (spec.server ?? 0) + (spec.latency ?? 0);
  // A server delay that reached neither click would pass every comparison.
  // A click on a page's own link can change nothing at all.
  if (away > 0 && plain.times.length > 1) {
    check(
      "setup",
      spec.optimistic === true || plain.firstChangeAt >= away,
      `the plain click showed something at ${plain.firstChangeAt} ms, before its response could (${away} ms)`,
    );
    if (spec.commitsWithFill) {
      check(
        "setup",
        adopted.firstChangeAt >= away,
        `the adopted click showed something at ${adopted.firstChangeAt} ms, before its fill could (${away} ms)`,
      );
    }
  }

  if (spec.skeleton) {
    const { fallback, layout } = spec.skeleton;
    const at = (id: string): number | undefined => {
      const index = adopted.order.indexOf(id);
      return index < 0 ? undefined : adopted.seenAt[index];
    };
    const skeletonAt = at(fallback);
    const layoutAt = at(layout);
    const { content } = spec.skeleton;
    const contentAt = content === undefined ? layoutAt : at(content);
    check(
      "skeleton",
      skeletonAt !== undefined &&
        Math.abs(skeletonAt - adopted.firstChangeAt) <= SAME_FRAME_MS &&
        skeletonAt <= PARITY_MARGIN_MS,
      `the skeleton is not the click's first change, within ${PARITY_MARGIN_MS} ms: the skeleton at ${skeletonAt}, the first change at ${adopted.firstChangeAt}`,
    );
    check(
      "skeleton",
      layoutAt !== undefined &&
        contentAt !== undefined &&
        (Math.abs(layoutAt - contentAt) <= SAME_FRAME_MS || again === true),
      `the layout showed neither with the content nor with its fallback inside: the layout at ${layoutAt}, the content at ${contentAt}`,
    );
    check(
      "skeleton",
      layoutAt !== undefined &&
        skeletonAt !== undefined &&
        layoutAt - skeletonAt >= SKELETON_MIN_MS,
      `the layout showed ${layoutAt! - skeletonAt!} ms after the skeleton, sooner than React's 300`,
    );
  }
  if (spec.innerFallback) {
    const index = adopted.order.indexOf(spec.innerFallback);
    const layoutIndex = spec.skeleton
      ? adopted.order.indexOf(spec.skeleton.layout)
      : -1;
    const innerAt = adopted.seenAt[index]!;
    const layoutShownAt = adopted.seenAt[layoutIndex]!;
    check(
      "skeleton",
      plain.fallbacks.includes(spec.innerFallback) &&
        index >= 0 &&
        layoutIndex >= 0 &&
        (Math.abs(innerAt - layoutShownAt) <= SAME_FRAME_MS ||
          (again === true && innerAt > layoutShownAt)),
      `${spec.innerFallback} did not show inside the layout as on the plain click`,
    );
  }

  const known = (broken: Broken): boolean =>
    spec.open?.breaks.includes(broken.rule) === true;
  const list = (broken: Broken[]): string[] => broken.map(({ what }) => what);
  const pairs = [first];
  let late = laterThanPlain(first, spec);
  // What the case's open gap explains is in every pair: no pair is recorded
  // again for it.
  while (late.some((broken) => !known(broken)) && pairs.length < PARITY_PAIRS) {
    hooks.onRepeat?.(`pair ${pairs.length}: ${list(late).join("; ")}`);
    const next = await recordPlainAndAdoptedClick(page, fixture, spec);
    pairs.push(next);
    late = laterThanPlain(next, spec);
  }
  for (const rule of new Set(late.map((broken) => broken.rule))) {
    wrong.push({
      rule,
      what:
        rule === "hook"
          ? "a URL hook further ahead of the page than in the plain click, in every pair"
          : rule === "click"
            ? "the page did not show at the click, in every pair"
            : "later than the plain click, and than React's throttle explains, in every pair",
    });
  }
  for (const what of spec.open?.bound(first, spec) ?? []) {
    wrong.push({ rule: "bound", what: `open gap past its bound: ${what}` });
  }

  const report = `${prefetchFalseParityTitle(spec)}\n${pairs
    .map(
      (pair, index) =>
        `pair ${index + 1}: ${list(laterThanPlain(pair, spec)).join("; ") || "on time"}\n${describePair(pair)}`,
    )
    .join("\n")}`;
  expect(list(wrong.filter((broken) => !known(broken))), report).toEqual([]);
  if (spec.open && !(spec.openWhereItShows && !wrong.some(known))) {
    hooks.onOpen?.(spec.open);
    expect(list(wrong), `open: ${spec.open.reason}\n${report}`).toEqual([]);
  }
  return first;
}

/** A comparison that did not hold. */
interface Broken {
  rule: PrefetchFalseParityRule;
  what: string;
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
  // Strictly after: a change sampled in the millisecond of the call came
  // before it. startViewTransition captures the old state at the next
  // rendering opportunity and only then runs the update, a frame later at
  // the earliest. Counted with `>=`, an urgent commit followed in the same
  // millisecond by a transition of a handle push counted as animated in some
  // runs and not in others (production, router app, `loader` with an app
  // boundary: change and call in the same millisecond, 3 failures in 12
  // runs of the two cells).
  return click.viewTransitionsAt.filter((at) =>
    click.times.some(
      (changed) => changed > at && changed <= at + IDLE_WINDOW_MS,
    ),
  ).length;
}

const IDLE_WINDOW_MS = 100;

/**
 * How soon after a flagged layout's skeleton its layout may show: React keeps
 * a fallback up for 300 ms (FALLBACK_THROTTLE_MS in react-reconciler), less
 * what sampling the page can take off the measured gap.
 */
const SKELETON_MIN_MS = 280;

/** FALLBACK_THROTTLE_MS in react-reconciler. */
const REACT_THROTTLE_MS = 300;

/**
 * Two elements of one commit, as the page's sampler times them: one sample
 * reads the clock per element, so they can differ by a millisecond or two.
 */
const SAME_FRAME_MS = 16;

/**
 * The flagged layout showed with its own fallback inside it. A read with no
 * boundary of its own below the layout whose data has not landed when the
 * layout shows: React suspends it to the nearest boundary, the layout's
 * outlet, whose fallback is the layout's own loading(). So the skeleton shows
 * a second time, inside the layout, as a plain click shows it there with its
 * first chunk, and the read's content follows at least React's 300 ms later.
 */
function skeletonInsideLayout(
  click: PrefetchFalseClick,
  { layout, fallback }: NonNullable<PrefetchFalseParityCase["skeleton"]>,
): boolean {
  const has = (snapshot: string, id: string): boolean =>
    snapshot.split(" ").some((shown) => shown.split("=")[0] === id);
  const shown = click.timeline.find((snapshot) => has(snapshot, layout));
  return shown !== undefined && has(shown, fallback);
}

/**
 * The earliest React commits a Suspense retry at `at` on this click:
 * `REACT_THROTTLE_MS` after the last time before `at` that a fallback showed
 * or hid, anywhere on the page (FALLBACK_THROTTLE_MS; `react-dom-client`
 * marks the time whenever a boundary switches between fallback and content).
 * `-Infinity` when no fallback changed before `at`.
 */
function reactHold(click: PrefetchFalseClick, at: number): number {
  const before = click.fallbackEventsAt.filter((event) => event < at);
  return before.length > 0
    ? Math.max(...before) + REACT_THROTTLE_MS
    : Number.NEGATIVE_INFINITY;
}

function isFallbackId(id: string): boolean {
  return id.endsWith("-fallback") || id.endsWith("-loading");
}

/**
 * When the adopted click's page box first showed content it did not show
 * before the click: the page's first content. Infinity when it never did.
 */
function firstContentAt(click: PrefetchFalseClick): number {
  const ids = (snapshot: string | undefined): string[] =>
    (snapshot ?? "")
      .split(" ")
      .filter(Boolean)
      .map((shown) => shown.split("=")[0]!)
      .filter((id) => !isFallbackId(id));
  const before = new Set(ids(click.timeline[0]));
  const index = click.timeline.findIndex(
    (snapshot, at) => at > 0 && ids(snapshot).some((id) => !before.has(id)),
  );
  return index < 0 ? Number.POSITIVE_INFINITY : click.times[index]!;
}

/**
 * Where the adopted click of a pair breaks the bar past the margin: it does
 * not show the page at the click, shows something later than the plain
 * click does and later than React's throttle explains, or has a URL hook
 * further ahead of the page.
 */
function laterThanPlain(
  { plain, adopted }: PrefetchFalsePair,
  spec: PrefetchFalseParityCase,
): Broken[] {
  const late: Broken[] = [];
  const at = (click: PrefetchFalseClick, id: string): number =>
    click.seenAt[click.order.indexOf(id)] ?? Number.NaN;
  const shownAt = spec.skeleton ? at(adopted, spec.skeleton.layout) : NaN;
  const never = (
    what: string,
    was: number,
    is: number,
    rule: "late" | "hook" | "click" = "late",
  ): void => {
    const margin = rule === "hook" ? HOOK_LEAD_MARGIN_MS : PARITY_MARGIN_MS;
    if (is > was + margin) late.push({ rule, what: `${what} ${was} -> ${is}` });
  };
  // What shows at `is` on the adopted click is on time no later than the
  // plain click shows it, or than React holds a retry at `is`.
  const held = (was: number, is: number): number =>
    Math.max(was, reactHold(adopted, is));
  // How long a URL hook had moved before the page did. The address bar is
  // not compared: the router's commit moves it, before React shows a page
  // it holds, and an adopted click commits at the click.
  if (!spec.optimistic && plain.hookAt !== null && adopted.hookAt !== null) {
    never(
      "the URL hook ahead of the page (ms)",
      plain.firstChangeAt - plain.hookAt,
      adopted.firstChangeAt - adopted.hookAt,
      "hook",
    );
  }
  // The page, or its skeleton, at the click: what the prefetch is for. A
  // page that commits with its fill shows when the fill answers, and a
  // prefetch made on another page is not adopted.
  if (!spec.commitsWithFill && spec.prefetchedOn !== "hub") {
    never("the first visible change (ms)", 0, adopted.firstChangeAt, "click");
  }
  never(
    "the first visible change (ms)",
    plain.firstChangeAt,
    adopted.firstChangeAt,
  );
  const completeBound = held(plain.completeAt, adopted.completeAt);
  never("the completed page (ms)", completeBound, adopted.completeAt);
  // A clientUrls() click reports itself busy until the commit that shows the
  // page: a fill after it does not count.
  if (plain.pendingEndAt !== null && adopted.pendingEndAt !== null) {
    never(
      "useOutlet().pending ended (ms)",
      held(plain.pendingEndAt, adopted.pendingEndAt),
      adopted.pendingEndAt,
    );
  }
  // A plain click that shows no fallback keeps the page it is on instead.
  never(
    "the last fallback gone (ms)",
    held(
      plain.fallbacks.length > 0 ? plain.fallbackGoneAt : plain.completeAt,
      adopted.fallbackGoneAt,
    ),
    adopted.fallbackGoneAt,
  );
  // The response has streamed when React's throttle holds the reveal back.
  never(
    "useNavigation() idle, the page incomplete (ms)",
    plain.quietMs + completeBound - plain.completeAt,
    adopted.quietMs,
  );
  if (spec.skeleton) {
    // The layout shows with the fill, by design: no later than the plain
    // click shows what the layout covers, or React's 300 ms after the
    // skeleton when that is later.
    const { fallback, layout, content } = spec.skeleton;
    never(
      "the layout (ms)",
      Math.max(
        at(plain, content ?? layout),
        at(adopted, fallback) + REACT_THROTTLE_MS,
      ),
      shownAt,
    );
  }
  // Each element on its own. The page's first content is never later than
  // the plain click's; what shows after it may wait for React's throttle,
  // which the adopted click's earlier fallbacks start earlier: a read that
  // lands after the deferred part's reveal shows its own fallback and
  // React's 300 ms from then.
  const firstAt = firstContentAt(adopted);
  adopted.order.forEach((id, index) => {
    const was = plain.order.indexOf(id);
    if (was < 0 || adopted.fallbacks.includes(id)) return;
    // A flagged layout entered from outside shows with the fill by design,
    // and so does what shows with it: the layout's bound above holds them.
    if (id === spec.skeleton?.layout) return;
    const is = adopted.seenAt[index]!;
    const withLayout =
      adopted.inside.includes(id) && Math.abs(is - shownAt) <= SAME_FRAME_MS;
    if (withLayout) return;
    const first = is <= firstAt + SAME_FRAME_MS;
    never(
      `${id} visible at (ms)`,
      first ? plain.seenAt[was]! : held(plain.seenAt[was]!, is),
      is,
    );
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
    urlAt: click.urlAt,
    hookAt: click.hookAt,
    pendingEndAt: click.pendingEndAt,
    viewTransitionsAt: click.viewTransitionsAt,
    shownMs: click.shownMs,
    fallbackEventsAt: click.fallbackEventsAt,
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
    const watch = await watchPage(page, held, spec.skeleton?.layout);
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
 * fallback at once, then the value. The adopted click never shows the
 * route's coarser `loading()`. The plain click shows it where its response's
 * first chunk does not carry the handler's output (development); a
 * production build hands a handler that has returned to its boundary as the
 * node (#1080), and shows the page with the response.
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
 * A deferred read with a `<Suspense>` of its own, on a route with no
 * `loading()` (`own`). Nothing holds this click: with its fill held back, the
 * page, the read's fallback, the address bar and the URL hook are all there,
 * and `useNavigation()` reads `idle` and streaming.
 *
 * It guards what a read with no boundary needs (`bare`). There React holds
 * the click, and the navigation state is delivered ahead of the commit so
 * that `loading` shows for the wait. That must not keep a click React does
 * not hold on the page being left.
 */
export async function expectOwnBoundaryWithNoLoadingShowsWithTheClick(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("own"));
  await prefetchCase(page, hub, "own");
  expect(
    pick(await hub.counts(), ["own.handler", "own.data"]),
    "the prefetch ran the handler and skipped the loader",
  ).toEqual({ "own.handler": 1, "own.data": 0 });

  const fills = await holdFills(page);
  await clickWithoutHover(page, "own");
  await expect(byId(page, "pf-own-page")).toBeVisible();
  await expect(byId(page, "pf-own-fallback")).toBeVisible();
  await expect(byId(page, "pf-hub")).toHaveCount(0);
  await expect(page).toHaveURL(hub.pageUrl("own"));
  const nav = byId(page, "pf-nav");
  await expect(nav).toHaveAttribute("data-path", hub.pathname("own"));
  await expect(nav).toHaveAttribute("data-state", "idle");
  await expect(nav).toHaveAttribute("data-streaming", "true");
  expect(pick(await hub.counts(), ["own.data"])).toEqual({ "own.data": 0 });

  await fills.release();
  await expect(byId(page, "pf-own-value")).toHaveText("own.data:1");
  await expect(byId(page, "pf-own-fallback")).toHaveCount(0);
  await complete(page);
  expect(kindsOf(requests)).toEqual(["prefetch", "fill"]);
  expect(pick(await hub.counts(), ["own.handler", "own.data"])).toEqual({
    "own.handler": 1,
    "own.data": 1,
  });
}

export interface PrefetchFalseHandlerFailure {
  /** A case below the section layout: the page is `/prefetch-false/<name>`. */
  name: string;
  /** Test id of the boundary the handler's failure ends in. */
  shows: string;
}

/** The `pf-*` test ids visible in the page box, in document order. */
function shownInPageBox(page: Page): Promise<string[]> {
  return byId(page, "pf-outlet").evaluate((box) =>
    [...box.querySelectorAll('[data-testid^="pf-"]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => el.getAttribute("data-testid")!),
  );
}

/**
 * A handler below a deferred layout that fails in the fill. It has no
 * `loading()` of its own, so the server awaits it and its failure is the
 * route's segment: the fill answers with an error (or a not-found) segment
 * where the prefetch's skeleton has a route and its loader. The page is then
 * not the one the click's tree was built for, and this is the one answer for
 * which a fill hands React a tree. It ends where the plain click ends: the
 * same elements on screen, no fallback left, nothing streaming. React logs no
 * error for it: the boundary that suspended on its gate is handed that gate
 * again, where a node in its place was "called use() to suspend in a
 * previous render but did not call use() when it finished" in development.
 */
export async function expectDeferredHandlerFailureReplacesItsSegment(
  page: Page,
  fixture: PrefetchFalseFixture,
  spec: PrefetchFalseHandlerFailure,
): Promise<void> {
  const { name } = spec;
  const work = [`${name}.handler`, "section.layout"];

  // The plain click: what the page ends as.
  const plainHub = await openHub(page, fixture);
  await clickWithoutHover(page, name);
  await expect(byId(page, spec.shows)).toBeVisible();
  await complete(page);
  const plain = await shownInPageBox(page);
  expect(plain, "the boundary is inside the layout").toEqual(
    expect.arrayContaining(["pf-section-layout", spec.shows]),
  );
  expect(pick(await plainHub.counts(), work)).toEqual({
    [`${name}.handler`]: 1,
    "section.layout": 1,
  });

  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname(name));
  await prefetchCase(page, hub, name);
  expect(pick(await hub.counts(), work), "the prefetch ran neither").toEqual({
    [`${name}.handler`]: 0,
    "section.layout": 0,
  });

  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const fills = await holdFills(page);
  await clickWithoutHover(page, name);
  await expect(page).toHaveURL(hub.pageUrl(name));
  await expect(byId(page, "pf-section-fallback")).toBeVisible();
  await expect(byId(page, spec.shows)).toHaveCount(0);

  await fills.release();
  await expect(byId(page, spec.shows)).toBeVisible();
  await expect(byId(page, "pf-section-fallback")).toHaveCount(0);
  await expect(page).toHaveURL(hub.pageUrl(name));
  await complete(page);
  expect(
    await shownInPageBox(page),
    "the page the plain click ends on",
  ).toEqual(plain);
  expect(kindsOf(requests)).toEqual(["prefetch", "fill"]);
  expect(pick(await hub.counts(), work), "the fill ran each once").toEqual({
    [`${name}.handler`]: 1,
    "section.layout": 1,
  });
  expect(
    errors.filter((text) => text.includes("conditional-use-of-use")),
    "React reported a conditional use()",
  ).toEqual([]);
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
// clientUrls() routes
// ---------------------------------------------------------------------------

/**
 * `prefetch: false` on a clientUrls() group's loaders
 * (docs/design/prefetch-false.md, "`clientUrls()` routes"). The fixture's
 * group is mounted at `cu`: `cu` is its origin route, `cu/<route>` the
 * others, with test ids `pf-cu/<route>-*`. A click inside the group presents
 * the destination at the click, as it always did; with the prefetch adopted
 * it then commits the prefetched tree at once, and the one request it sends
 * is the fill.
 */

/** Stand on the group's origin, `cu`, reached by a plain click from the hub. */
async function openGroup(
  page: Page,
  fixture: PrefetchFalseFixture,
  flags: PrefetchFalseFlags = {},
): Promise<Hub> {
  const hub = await openHub(page, fixture, undefined, flags);
  await clickWithoutHover(page, "cu");
  await expect(byId(page, "pf-cu-value")).toBeVisible();
  await expect(page).toHaveURL(hub.pageUrl("cu"));
  await complete(page);
  return hub;
}

const CU_LOADER_WORK = ["cu/loader.price", "cu/loader.data"];

/**
 * An in-group click with the prefetch received, its fill held: the URL and
 * the unflagged loader's value show with the click, the flagged read's own
 * fallback beside them, and the one request the click sends is the fill.
 * `useOutlet().pending` ends with that commit, not with the fill, and
 * `useNavigation()` reads idle and streaming meanwhile. Released, the fill
 * brings the flagged value; nothing the prefetch ran runs again. The server
 * is `SERVER_MS` away for every request.
 */
export async function expectGroupClickCommitsThePrefetchAndFillsItsFlaggedLoader(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openGroup(page, fixture, { server: SERVER_MS });
  const requests = recordPartials(page, hub.pathname("cu/loader"));
  await prefetchCase(page, hub, "cu/loader");
  expect(
    pick(await hub.counts(), CU_LOADER_WORK),
    "the prefetch ran the unflagged loader and not the flagged one",
  ).toEqual({ "cu/loader.price": 1, "cu/loader.data": 0 });

  const fills = await holdFills(page);
  const watch = await watchPage(page, ["pf-layout", "pf-cu-above-layout"]);
  await clickWithoutHover(page, "cu/loader");
  await expect(page).toHaveURL(hub.pageUrl("cu/loader"));
  await expect(byId(page, "pf-cu/loader-price")).toHaveText(
    "cu/loader.price:1",
  );
  await expect(byId(page, "pf-cu/loader-fallback")).toBeVisible();
  await expect(byId(page, "pf-cu/loader-value")).toHaveCount(0);
  await expect
    .poll(() => kindsOf(requests), "the click sent its fill")
    .toEqual(["prefetch", "fill"]);
  // The fill is held: the click's own commit is what ends `pending`.
  await expect(byId(page, "pf-cu-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  await expect(byId(page, "pf-nav")).toHaveAttribute("data-state", "idle");
  await expect(byId(page, "pf-nav")).toHaveAttribute("data-streaming", "true");
  // Still, a moment later.
  await page.waitForTimeout(100);
  await expect(byId(page, "pf-cu-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  await expect(byId(page, "pf-cu/loader-fallback")).toBeVisible();
  expect(
    pick(await hub.counts(), ["cu/loader.data"]),
    "the flagged loader has not run",
  ).toEqual({ "cu/loader.data": 0 });

  await fills.release();
  await expect(byId(page, "pf-cu/loader-value")).toHaveText("cu/loader.data:1");
  await complete(page);
  const seen = await watch.stop();

  const at = (id: string): number => seen.seenAt[seen.order.indexOf(id)]!;
  expect(seen.urlAt, "the URL moved with the click").not.toBeNull();
  expect(seen.urlAt!, "the URL moved with the click").toBeLessThanOrEqual(
    PARITY_MARGIN_MS,
  );
  expect(
    at("pf-cu/loader-price"),
    "the prefetched value showed with the click",
  ).toBeLessThanOrEqual(PARITY_MARGIN_MS);
  expect(seen.pendingEndAt, "pending ended").not.toBeNull();
  expect(
    seen.pendingEndAt!,
    "pending ended with the click's commit",
  ).toBeLessThanOrEqual(PARITY_MARGIN_MS);
  expect(seen.hidden, "held content stayed on screen").toEqual([]);
  expect(seen.blank, "the page was never blank").toBe(false);
  expect(
    kindsOf(requests),
    "one prefetch and one fill: the navigation was answered by the prefetch",
  ).toEqual(["prefetch", "fill"]);
  expect(
    pick(await hub.counts(), CU_LOADER_WORK),
    "the fill ran the flagged loader once, and nothing the prefetch ran",
  ).toEqual({ "cu/loader.price": 1, "cu/loader.data": 1 });
}

/**
 * The same in-group click with no prefetch: one navigation request, no
 * fill, every loader run once by it, `pending` over when it commits.
 */
export async function expectPlainGroupClickSendsNoFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openGroup(page, fixture);
  const requests = recordPartials(page, hub.pathname("cu/loader"));
  await clickWithoutHover(page, "cu/loader");
  await expect(page).toHaveURL(hub.pageUrl("cu/loader"));
  await expect(byId(page, "pf-cu/loader-value")).toHaveText("cu/loader.data:1");
  await expect(byId(page, "pf-cu/loader-price")).toHaveText(
    "cu/loader.price:1",
  );
  await complete(page);
  await expect(byId(page, "pf-cu-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  expect(kindsOf(requests), "one navigation, no fill").toEqual(["navigation"]);
  expect(pick(await hub.counts(), CU_LOADER_WORK)).toEqual({
    "cu/loader.price": 1,
    "cu/loader.data": 1,
  });
}

/**
 * Into the group from a server page, the prefetch received: a flagged loader
 * on the server layout above the group is deferred while that layout is new
 * to the client, beside the group route's own, and that layout's flagged
 * loading() defers nothing (the prefetch ran the layout). With no group on
 * the page there is no optimistic presentation: the click commits the
 * prefetched tree with its holes and one fill runs both flagged loaders.
 */
export async function expectGroupEntryDefersTheFlaggedLoaderAboveTheGroup(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const work = [
    "cu/above.layout",
    "cu/above.data",
    "cu/loader.price",
    "cu/loader.data",
  ];
  const hub = await openHub(page, fixture);
  const requests = recordPartials(page, hub.pathname("cu/loader"));
  await prefetchCase(page, hub, "cu/loader");
  expect(
    pick(await hub.counts(), work),
    "the prefetch ran the layout above the group and the unflagged loader",
  ).toEqual({
    "cu/above.layout": 1,
    "cu/above.data": 0,
    "cu/loader.price": 1,
    "cu/loader.data": 0,
  });

  const fills = await holdFills(page);
  await clickWithoutHover(page, "cu/loader");
  await expect(page).toHaveURL(hub.pageUrl("cu/loader"));
  await expect(byId(page, "pf-cu/loader-price")).toHaveText(
    "cu/loader.price:1",
  );
  await expect(byId(page, "pf-cu-above-layout")).toBeVisible();
  await expect(byId(page, "pf-cu/above-fallback")).toBeVisible();
  await expect(byId(page, "pf-cu/loader-fallback")).toBeVisible();
  await expect
    .poll(() => kindsOf(requests), "the click sent its fill")
    .toEqual(["prefetch", "fill"]);

  await fills.release();
  await expect(byId(page, "pf-cu/above-value")).toHaveText("cu/above.data:1");
  await expect(byId(page, "pf-cu/loader-value")).toHaveText("cu/loader.data:1");
  await complete(page);
  expect(kindsOf(requests)).toEqual(["prefetch", "fill"]);
  expect(
    pick(await hub.counts(), work),
    "one fill ran both flagged loaders, and nothing the prefetch ran",
  ).toEqual({
    "cu/above.layout": 1,
    "cu/above.data": 1,
    "cu/loader.price": 1,
    "cu/loader.data": 1,
  });
}

/** A filled group entry restores from history on back and forward. */
export async function expectGroupBackAndForwardKeepTheFilledPage(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openGroup(page, fixture);
  await prefetchCase(page, hub, "cu/loader");
  await clickWithoutHover(page, "cu/loader");
  await expect(byId(page, "pf-cu/loader-value")).toHaveText("cu/loader.data:1");
  await complete(page);
  const requests = recordPartials(page, hub.pathname("cu/loader"));

  for (let round = 0; round < 2; round++) {
    await page.goBack();
    await expect(page).toHaveURL(hub.pageUrl("cu"));
    await expect(byId(page, "pf-cu-value")).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(hub.pageUrl("cu/loader"));
    await expect(byId(page, "pf-cu/loader-value")).toHaveText(
      "cu/loader.data:1",
    );
    await expect(byId(page, "pf-cu/loader-price")).toHaveText(
      "cu/loader.price:1",
    );
    await expect(byId(page, "pf-cu/loader-fallback")).toHaveCount(0);
  }
  expect(requests, "the filled entry was restored from history").toEqual([]);
  expect(pick(await hub.counts(), CU_LOADER_WORK)).toEqual({
    "cu/loader.price": 1,
    "cu/loader.data": 1,
  });
}

/**
 * A newer navigation while the fill is in flight. Before the fill's response
 * it cancels the request: the flagged loader never runs, and going back
 * fetches what the entry is missing. After the response has arrived the fill
 * is never aborted: it streams to its end with no error, and nothing it
 * carries reaches the page the newer navigation committed.
 */
export async function expectNewerNavigationDuringAGroupFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    if (isFill(request.url())) failed.push(request.failure()?.errorText ?? "");
  });

  // Before the fill's response: cancelled.
  let hub = await openGroup(page, fixture);
  await prefetchCase(page, hub, "cu/loader");
  const fills = await holdFills(page);
  await clickWithoutHover(page, "cu/loader");
  await expect(byId(page, "pf-cu/loader-fallback")).toBeVisible();
  await clickWithoutHover(page, "cu");
  await expect(page).toHaveURL(hub.pageUrl("cu"));
  await expect(byId(page, "pf-cu-value")).toBeVisible();
  await expect.poll(() => failed.length, "the fill was cancelled").toBe(1);
  await fills.release();
  await complete(page);
  expect(
    pick(await hub.counts(), ["cu/loader.data"]),
    "the cancelled fill ran nothing",
  ).toEqual({ "cu/loader.data": 0 });
  await page.goBack();
  await expect(page).toHaveURL(hub.pageUrl("cu/loader"));
  await expect(
    byId(page, "pf-cu/loader-value"),
    "going back fetches what the entry is missing",
  ).toHaveText("cu/loader.data:1");
  await complete(page);

  // After the fill's response: the flagged loader takes 1.5 s more, so its
  // value is still streaming when the newer navigation starts.
  failed.length = 0;
  hub = await openGroup(page, fixture, { delay: 1500 });
  await prefetchCase(page, hub, "cu/loader");
  const fill = page.waitForResponse(
    (response) =>
      isPartialFor(response.url(), hub.pathname("cu/loader")) &&
      isFill(response.url()),
  );
  await clickWithoutHover(page, "cu/loader");
  const answer = await fill;
  await expect(byId(page, "pf-cu/loader-fallback")).toBeVisible();
  await clickWithoutHover(page, "cu");
  await expect(page).toHaveURL(hub.pageUrl("cu"));
  await expect(byId(page, "pf-cu-value")).toBeVisible();
  expect(await answer.finished(), "the fill streamed to its end").toBeNull();
  await complete(page);
  expect(failed, "the fill that had answered was not aborted").toEqual([]);
  expect(
    pick(await hub.counts(), ["cu/loader.data"]),
    "the fill ran the flagged loader",
  ).toEqual({ "cu/loader.data": 1 });
  // A moment after the fill's end: the newer page is still what shows.
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(hub.pageUrl("cu"));
  await expect(byId(page, "pf-cu-value")).toBeVisible();
  await expect(byId(page, "pf-cu/loader-page")).toHaveCount(0);
}

/**
 * A server action while the fill is in flight. The action does not cancel
 * the fill. Its refetch lists what the page holds, which leaves the
 * placeholder out, so it renders the flagged loader and its commit settles
 * the read. The fill's answer is then for a tree that is gone: it streams to
 * its end and is dropped, and the page keeps the action's value.
 */
export async function expectActionDuringAGroupFill(
  page: Page,
  fixture: PrefetchFalseFixture,
): Promise<void> {
  const hub = await openGroup(page, fixture);
  await prefetchCase(page, hub, "cu/loader");
  const fills = await holdFills(page);
  await clickWithoutHover(page, "cu/loader");
  await expect(byId(page, "pf-cu/loader-fallback")).toBeVisible();

  const action = page.waitForResponse(
    (response) => response.request().method() === "POST",
  );
  await byId(page, "pf-cu-action").click();
  expect(await (await action).finished(), "the action answered").toBeNull();
  await expect(
    byId(page, "pf-cu/loader-value"),
    "the action's refetch rendered the flagged loader",
  ).toHaveText("cu/loader.data:1");
  await expect(byId(page, "pf-cu/loader-fallback")).toHaveCount(0);
  expect(pick(await hub.counts(), ["cu/action", "cu/loader.data"])).toEqual({
    "cu/action": 1,
    "cu/loader.data": 1,
  });

  const fill = page.waitForResponse(
    (response) =>
      isPartialFor(response.url(), hub.pathname("cu/loader")) &&
      isFill(response.url()),
  );
  await fills.release();
  expect(
    await (await fill).finished(),
    "the fill streamed to its end",
  ).toBeNull();
  await complete(page);
  await expect(page).toHaveURL(hub.pageUrl("cu/loader"));
  await expect(
    byId(page, "pf-cu/loader-value"),
    "the fill's answer did not replace the action's",
  ).toHaveText("cu/loader.data:1");
  await expect(byId(page, "pf-cu-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
}

/** A clientUrls() click stands on this, inside the group. */
const IN_GROUP = {
  from: "cu",
  held: ["pf-cu-above-layout"],
  optimistic: true,
};

const CU_PARITY_CLICKS: PrefetchFalseParityCase[] = [
  { name: "cu/loader", ...IN_GROUP, ownFallback: "pf-cu/loader-fallback" },
  // A read with no boundary: React holds the page, in both clicks.
  { name: "cu/bare", ...IN_GROUP, ...HELD },
  { name: "cu/vt", ...IN_GROUP, ownFallback: "pf-cu/vt-fallback" },
  // A same-route navigation: the page holds the route and its loader.
  {
    name: "cu/item/b",
    from: "cu/item/a",
    stem: "cu/item",
    held: ["pf-cu-above-layout"],
  },
  // Into the group from the hub: no optimistic presentation, and the layout
  // above the group is new, so its flagged loader is deferred too.
  {
    name: "cu/loader",
    ownFallback: "pf-cu/loader-fallback",
    deferredFallbacks: ["pf-cu/above-fallback"],
  },
];

/**
 * The clientUrls() clicks, as `expectAdoptedClickIsNeverWorseThanAPlainClick`
 * runs them: with fast loaders, loaders `MID_DELAY_MS` slower and slow ones,
 * every one with the server `SERVER_MS` away.
 */
export const PREFETCH_FALSE_CLIENT_URLS_PARITY_CASES: PrefetchFalseParityCase[] =
  [
    ...CU_PARITY_CLICKS,
    ...CU_PARITY_CLICKS.map((spec) => ({ ...spec, delay: MID_DELAY_MS })),
    ...CU_PARITY_CLICKS.map((spec) => ({ ...spec, slow: true })),
  ].map((spec) => ({ server: SERVER_MS, ...spec }));

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export interface PrefetchFalseSuite {
  fixture: () => PrefetchFalseFixture;
  /** The app's guard: fails the test on an uncaught page error. */
  expectNoPageError: (page: Page) => { [Symbol.dispose]: () => void };
  /**
   * The describe runs against a build. A dev build must expose the suspense
   * audit, and the cases that read it fail when it is missing.
   */
  production: boolean;
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
    it(`a click that adopts a prefetch is never worse than a plain click: ${prefetchFalseParityTitle(spec)}`, async (page, fixture) => {
      const pair = await expectAdoptedClickIsNeverWorseThanAPlainClick(
        page,
        fixture,
        spec,
        {
          // In the report: how often one pair of clicks was not enough.
          onRepeat: (late) =>
            test.info().annotations.push({
              type: "parity pair repeated",
              description: late,
            }),
          // An expected failure from here on, and an unexpected pass once
          // the gap is closed.
          onOpen: ({ reason }) => test.fail(true, reason),
        },
      );
      // In the report: the numbers of a case that passed. A case that
      // failed, an open one included, has them in its error.
      test.info().annotations.push({
        type: "parity",
        description: describePair(pair),
      });
    });
  }

  for (const name of [
    "loader",
    "unit",
    "section",
    "section-own",
    "slot",
    "inner",
    "nested",
    "above",
    "bare",
    "vt",
    "vt-unit",
    "vt-inner",
    "vt-below",
    "own",
    "section-suspense",
    "section-read",
    "outer",
  ]) {
    it(`a click that adopts a prefetch builds the page once: ${name}`, (page, fixture) =>
      expectAdoptedClickBuildsThePageOnce(
        page,
        fixture,
        name,
        suite.production,
      ));
  }

  it("a deferred loader shows its own fallback at once, beside what the prefetch ran", (page, fixture) =>
    expectDeferredLoaderShowsItsOwnFallbackAtOnce(page, fixture));

  it("a deferred read with its own boundary on a route with no loading() shows with the click", (page, fixture) =>
    expectOwnBoundaryWithNoLoadingShowsWithTheClick(page, fixture));

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

  it("a unit whose loader the layout above it reads holds the page being left until the fill returns, then shows", (page, fixture) =>
    expectNoBoundaryHoldsThePageLeftUntilTheFillReturns(
      page,
      fixture,
      "above",
    ));

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

  it("a deferred handler that throws replaces its segment when the fill returns, as on a plain click", (page, fixture) =>
    expectDeferredHandlerFailureReplacesItsSegment(page, fixture, {
      name: "section-throws",
      shows: "pf-section-throws-error",
    }));

  it("a deferred handler that calls notFound() replaces its segment when the fill returns, as on a plain click", (page, fixture) =>
    expectDeferredHandlerFailureReplacesItsSegment(page, fixture, {
      name: "section-missing",
      shows: "pf-section-missing-not-found",
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

  it("a flagged loader with its own cache() that the handler reads runs through its cache() in the prefetch", (page, fixture) =>
    expectHandlerReadFlaggedLoaderUsesItsCache(page, fixture));

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

  it("a filled entry marked stale shows at once on back/forward, then revalidates with no fallback", (page, fixture) =>
    expectStaleFilledEntryShowsAtOnceThenRevalidates(page, fixture));

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

  // The maintainer's exception to parity, bounded so it cannot grow.
  const inFlight: PrefetchFalseInFlightCase[] = [
    { name: "loader" },
    { name: "unit" },
    { name: "bare", pageIsDeferred: true },
  ];
  for (const spec of inFlight) {
    it(`a click while the prefetch is still in flight adopts it, late by no more than what was left of it: ${spec.name}`, async (page, fixture) => {
      const pair = await expectClickDuringThePrefetchStaysWithinItsBound(
        page,
        fixture,
        spec,
        {
          onRepeat: (late) =>
            test.info().annotations.push({
              type: "in-flight pair repeated",
              description: late,
            }),
        },
      );
      test.info().annotations.push({
        type: "in flight",
        description: describeInFlightPair(pair),
      });
    });
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

  // clientUrls() routes: loader(Def, { prefetch: false }) in a group.
  it("clientUrls(): an in-group click commits the prefetch with the click and one fill brings the flagged loader; pending ends with the commit", (page, fixture) =>
    expectGroupClickCommitsThePrefetchAndFillsItsFlaggedLoader(page, fixture));

  it("clientUrls(): an in-group click with no prefetch sends one navigation and no fill", (page, fixture) =>
    expectPlainGroupClickSendsNoFill(page, fixture));

  it("clientUrls(): a flagged loader on the server layout above the group is deferred while that layout is new; its flagged loading() defers nothing", (page, fixture) =>
    expectGroupEntryDefersTheFlaggedLoaderAboveTheGroup(page, fixture));

  it("clientUrls(): back and forward after a fill restore the filled group page", (page, fixture) =>
    expectGroupBackAndForwardKeepTheFilledPage(page, fixture));

  it("clientUrls(): a newer navigation cancels a fill before its response and leaves one that has answered to stream to its end", (page, fixture) =>
    expectNewerNavigationDuringAGroupFill(page, fixture));

  it("clientUrls(): a server action during a fill ends on the complete page", (page, fixture) =>
    expectActionDuringAGroupFill(page, fixture));

  it("clientUrls(): an in-group click while the prefetch is still in flight adopts it, late by no more than what was left of it", async (page, fixture) => {
    const pair = await expectClickDuringThePrefetchStaysWithinItsBound(
      page,
      fixture,
      { name: "cu/loader", from: "cu" },
      {
        onRepeat: (late) =>
          test.info().annotations.push({
            type: "in-flight pair repeated",
            description: late,
          }),
      },
    );
    test.info().annotations.push({
      type: "in flight",
      description: describeInFlightPair(pair),
    });
  });

  for (const spec of PREFETCH_FALSE_CLIENT_URLS_PARITY_CASES) {
    it(`clientUrls(): a click that adopts a prefetch is never worse than a plain click: ${prefetchFalseParityTitle(spec)}`, async (page, fixture) => {
      const pair = await expectAdoptedClickIsNeverWorseThanAPlainClick(
        page,
        fixture,
        spec,
        {
          onRepeat: (late) =>
            test.info().annotations.push({
              type: "parity pair repeated",
              description: late,
            }),
          onOpen: ({ reason }) => test.fail(true, reason),
        },
      );
      test.info().annotations.push({
        type: "parity",
        description: describePair(pair),
      });
    });
  }
}
