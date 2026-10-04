import {
  expect,
  type ConsoleMessage,
  type Locator,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export {
  assertExistingServerIsOurs,
  classifyExistingServer,
  formatForeignServerError,
} from "./assert-existing-server.js";
export type {
  ExistingServerIdentity,
  ExistingServerKind,
} from "./assert-existing-server.js";
export { createDeployFixture, readBuiltVersions } from "./deploy-fixture.js";
export type { DeployFixture, DeployFixtureOptions } from "./deploy-fixture.js";
export { runCacheVersionScenario } from "./cache-version-scenario.js";
export type { CacheVersionScenarioOptions } from "./cache-version-scenario.js";

/**
 * Shared end-to-end test utilities for HMR-driven tests across apps.
 *
 * Both the node test-app (`packages/rangojs-router/e2e`) and the cloudflare
 * app (`tests/cloudflare-basic/e2e`) drive the same Rango Vite plugin, so the
 * mechanics for triggering a file change and waiting for it to be applied are
 * identical. Keeping one implementation here avoids the two apps drifting onto
 * different (and differently flaky) await strategies.
 */

/**
 * Per-checkout e2e port offset — automatic isolation for the shared Playwright
 * webServers (rangojs-router 5188/5189 + host 5296/5297, cloudflare-basic
 * 5198/5199).
 *
 * Why: two clones of this repo running e2e at the same time collide on those
 * fixed ports. Under `reuseExistingServer` the second run silently reuses the
 * FIRST checkout's server — tests execute against the wrong code with no
 * error — and each run's stale-server cleanup kills the other clone's servers
 * mid-flight (scar tissue: PR #705 verification).
 *
 * How: the offset is a hash of this checkout's absolute path. The function
 * lives in @shared/e2e and resolves the path from ITS OWN location (the
 * workspace symlink is resolved to the real file), so every importer in the
 * same clone — both playwright configs and test files that build absolute
 * URLs (host-routing.test.ts) — derives the identical value by construction.
 * Same clone, same ports across runs: `reuseExistingServer` still reuses your
 * own servers. Applied uniformly, so the deliberate cross-suite port spacing
 * is preserved at any offset.
 *
 * Bounds: 150 buckets x 200 stride = offsets 0..29800, keeping ports well
 * under the OS ephemeral range. Two clones can still collide (~1-2% for a few
 * clones); RANGO_E2E_PORT_OFFSET overrides explicitly (0 forces the canonical
 * ports). CI pins 0: one checkout per runner, canonical ports in logs.
 */
export function checkoutPortOffset(): number {
  const override = process.env.RANGO_E2E_PORT_OFFSET;
  if (override !== undefined && override !== "") return Number(override);
  if (process.env.CI) return 0;
  const repoRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  let h = 0;
  for (let i = 0; i < repoRoot.length; i++) {
    h = (h * 31 + repoRoot.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) % 150) * 200;
}

/**
 * Wait for hydration without waiting for DOMContentLoaded. A pending PPR hole
 * keeps the document stream open, so the normal helper cannot reach its
 * hydration check until the condition this kind of test needs to observe has
 * already disappeared.
 */
export async function waitForShellHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
}

/**
 * Server-output marker emitted once per route re-discovery pass by the Rango
 * Vite plugin (see `discover-routers.ts`: `[rango] Router "<id>" -> N routes`).
 * It is a reliable signal that the dev server finished re-discovering routes
 * after a route-definition mutation, and works in both apps because it lives
 * in the shared plugin rather than app code.
 */
export const ROUTE_REDISCOVERY_PATTERN = /\[rango\] Router ".+?" -> \d+ routes/;

export interface HmrEvent {
  type: "js-update" | "full-reload" | "console";
  detail: string;
  timestamp: number;
}

// Module-level so repeated writes within a single test file keep advancing the
// mtime monotonically even across separate writeFileAndAwaitHmr calls.
let lastHmrWriteMtimeMs = 0;

/**
 * Overwrite a file in place and force a strictly monotonic mtime.
 *
 * The write is in place (a single writeFileSync, not a temp-file + rename):
 * the route-file watcher that drives re-discovery reacts to in-place "change"
 * events, and an atomic rename-replace is not reliably observed as a change to
 * the watched path. Route/config files are small enough that a single
 * writeFileSync is effectively atomic.
 *
 * The monotonic mtime defeats filesystems (and coarse mtime granularity) that
 * would otherwise coalesce rapid successive writes into a single — or missed —
 * change event, so each call is seen as a distinct change. Shared by
 * {@link writeFileAndAwaitHmr} and by route-mutation tests that poll their own
 * readiness signal (e.g. the generated routes file) rather than driving a page.
 */
export function writeFileBumpMtime(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  const nextMtimeMs = Math.max(Date.now(), lastHmrWriteMtimeMs + 1100);
  lastHmrWriteMtimeMs = nextMtimeMs;
  const nextMtime = new Date(nextMtimeMs);
  utimesSync(filePath, nextMtime, nextMtime);
}

/**
 * Write a file and wait until the resulting HMR change has been applied.
 * Robust against CI filesystems that coalesce or drop watcher events: each
 * attempt overwrites the file in place ({@link writeFileBumpMtime}) and forces
 * a strictly monotonic mtime so the watcher sees a fresh change, retrying until one of the
 * configured signals fires or the total timeout elapses.
 *
 * Await strategies (at least one of `serverOutputPattern` / `waitForApplied`
 * is required):
 * - `serverOutputPattern` (+ `getServerOutput`): wait for the dev server to log
 *   a line matching the pattern (e.g. an RSC version bump, or route
 *   re-discovery via {@link ROUTE_REDISCOVERY_PATTERN}).
 * - `waitForApplied`: an assertion closure (e.g. re-navigate and check the new
 *   content). When a `serverOutputPattern` is also given, the closure only runs
 *   after the server signal is seen; otherwise it is the sole signal and is
 *   retried each attempt.
 * - With a `serverOutputPattern` and no `waitForApplied`, the browser console
 *   `[Rango] HMR: RSC stream complete` marker (emitted on the live page after a
 *   partial RSC update) completes the wait.
 */
export async function writeFileAndAwaitHmr(
  page: Page,
  filePath: string,
  content: string,
  {
    totalTimeoutMs = 15000,
    retryIntervalMs = 3000,
    getServerOutput,
    serverOutputPattern,
    waitForApplied,
  }: {
    totalTimeoutMs?: number;
    retryIntervalMs?: number;
    getServerOutput?: (() => string) | undefined;
    serverOutputPattern?: RegExp | undefined;
    waitForApplied?: (() => Promise<void>) | undefined;
  },
): Promise<void> {
  if (!serverOutputPattern && !waitForApplied) {
    throw new Error(
      "writeFileAndAwaitHmr requires serverOutputPattern and/or waitForApplied " +
        "to know when the change has been applied.",
    );
  }
  if (serverOutputPattern && !getServerOutput) {
    throw new Error(
      "writeFileAndAwaitHmr requires getServerOutput when serverOutputPattern is set.",
    );
  }

  const hasServerPattern = !!serverOutputPattern;
  const deadline = Date.now() + totalTimeoutMs;
  let recentOutput = "";
  let lastApplyError: unknown;
  let sawServerSignal = false;
  let sawBrowserStreamComplete = false;

  const consoleHandler = (msg: ConsoleMessage) => {
    if (
      sawServerSignal &&
      msg.text().includes("[Rango] HMR: RSC stream complete")
    ) {
      sawBrowserStreamComplete = true;
    }
  };

  page.on("console", consoleHandler);

  try {
    while (Date.now() < deadline) {
      const outputOffset = getServerOutput ? getServerOutput().length : 0;
      sawServerSignal = false;
      sawBrowserStreamComplete = false;
      writeFileBumpMtime(filePath, content);

      const attemptDeadline =
        Date.now() +
        Math.max(1, Math.min(retryIntervalMs, deadline - Date.now()));

      while (Date.now() < attemptDeadline) {
        if (hasServerPattern && !sawServerSignal) {
          recentOutput = getServerOutput!().slice(outputOffset);
          if (serverOutputPattern!.test(recentOutput)) {
            sawServerSignal = true;
          }
        }
        // Browser-signal-only completion path: requires a server pattern to
        // gate against a stale stream-complete from before this write.
        if (
          !waitForApplied &&
          hasServerPattern &&
          sawServerSignal &&
          sawBrowserStreamComplete
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Run the applied-assertion once the server gate is open (immediately when
      // there is no server pattern). On failure, re-touch the file and retry.
      if (waitForApplied && (!hasServerPattern || sawServerSignal)) {
        try {
          await waitForApplied();
          return;
        } catch (error) {
          lastApplyError = error;
        }
      }
    }

    throw new Error(
      `Timed out waiting for HMR after writing ${filePath}. ` +
        `sawServerSignal=${sawServerSignal} ` +
        `sawBrowserStreamComplete=${sawBrowserStreamComplete} ` +
        `Recent server output:\n${recentOutput || "(empty)"}\n` +
        `Last apply error:\n${String(lastApplyError ?? "(none)")}`,
    );
  } finally {
    page.off("console", consoleHandler);
  }
}

/**
 * Capture Vite HMR events from console messages. Returns a collector with typed
 * event arrays and a dispose method. Use to assert that a route mutation was
 * applied via HMR without an unwanted full page reload.
 *
 * @example
 * const hmr = await captureHmrEvents(page);
 * await writeFileAndAwaitHmr(page, filePath, modified, { waitForApplied });
 * hmr.dispose();
 * expect(hmr.fullReloads).toHaveLength(0);
 */
export async function captureHmrEvents(page: Page) {
  const events: HmrEvent[] = [];
  const updates: string[] = [];
  const fullReloads: string[] = [];

  const consoleHandler = (msg: ConsoleMessage) => {
    const text = msg.text();
    if (text.includes("[vite] hot updated:")) {
      updates.push(text);
      events.push({ type: "js-update", detail: text, timestamp: Date.now() });
    }
    if (text.includes("[vite] page reload") || text.includes("full reload")) {
      fullReloads.push(text);
      events.push({ type: "full-reload", detail: text, timestamp: Date.now() });
    }
  };

  page.on("console", consoleHandler);

  return {
    events,
    updates,
    fullReloads,
    dispose: () => {
      page.off("console", consoleHandler);
    },
  };
}

/**
 * Fail on any hydration / React-render console error or pageerror. Pins the
 * PPR consistency contract: a cached prelude served ahead of a freshly
 * rendered hydration payload must not drift, and a HIT must never trip the
 * app's root error boundary.
 *
 * One canonical string list, shared by every suite. It matched only
 * "Minified React error" once, so dev's unminified "An unsupported type was
 * passed to use()" (#438, the settled-marker regression) sailed through one
 * suite while the other had already drifted to a broader copy. The
 * "[RootErrorBoundary]" prefix is logged by the router's own boundary
 * (src/root-error-boundary.tsx), so it is app-independent.
 *
 * Use with `using` so the assertion runs at scope exit — and make sure
 * hydration happens INSIDE the scope (goto alone can pass assertions off the
 * SSR DOM before hydration errors fire; await the suite's waitForHydration
 * first).
 */
export function guardHydrationErrors(page: Page): {
  [Symbol.dispose]: () => void;
} {
  const errors: string[] = [];
  const isHydrationError = (text: string) =>
    text.includes("hydration") ||
    text.includes("Hydration") ||
    text.includes("Minified React error") ||
    text.includes("unsupported type was passed to use") ||
    text.includes("[RootErrorBoundary]");
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === "error" && isHydrationError(msg.text())) {
      errors.push(msg.text());
    }
  };
  const onPageError = (err: Error) => {
    if (isHydrationError(err.message)) errors.push(err.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    [Symbol.dispose]: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      if (errors.length > 0) {
        throw new Error(
          `hydration / React errors on a PPR page:\n${errors.join("\n")}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Document script-shape helpers (head-script-preinit e2e in both apps)
// ---------------------------------------------------------------------------

/** All `<script>`/`<link>` open tags in the document, in order. */
export function scriptAndLinkTags(html: string): string[] {
  return [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map((m) => m[0]);
}

/** hrefs of every `<link rel="modulepreload">` in the document. */
export function modulepreloadHrefs(html: string): string[] {
  return scriptAndLinkTags(html)
    .filter((t) => t.includes('rel="modulepreload"'))
    .map((t) => t.match(/href="([^"]+)"/)?.[1])
    .filter((href): href is string => typeof href === "string");
}

/**
 * The `<link rel="modulepreload">` tags for `href`, in document order. For the
 * client entry Fizz writes exactly one (the `bootstrapModules` hint).
 */
export function modulepreloadTagsFor(html: string, href: string): string[] {
  return scriptAndLinkTags(html).filter(
    (t) => t.includes('rel="modulepreload"') && t.includes(`href="${href}"`),
  );
}

/**
 * The client entry's `<link rel="modulepreload">` hint as the SSR handler
 * serves it (#1025): exactly one, no `fetchpriority` (Chromium's
 * modulepreload default, High, instead of Fizz's Low), inside `<head>`, and
 * after every head chunk script. Returns the tag.
 */
export function expectEntryHintAfterHeadChunks(html: string): string {
  const { src } = fizzBootstrapScript(html);
  const hints = modulepreloadTagsFor(html, src);
  expect(hints, "exactly one entry modulepreload hint").toHaveLength(1);
  const hint = hints[0]!;
  expect(hint).not.toMatch(/\bfetchpriority=/i);
  const hintAt = html.indexOf(hint);
  expect(hintAt, "the entry hint is in <head>").toBeLessThan(
    html.indexOf("</head>"),
  );
  for (const tag of headChunkScripts(html)) {
    expect(html.indexOf(tag), `${tag} precedes the entry hint`).toBeLessThan(
      hintAt,
    );
  }
  return hint;
}

/**
 * The executing `<script type="module" async src>` client-reference chunk tags
 * in `<head>` (the `headScripts: "preinit"` upgrade).
 */
export function headChunkScripts(html: string): string[] {
  const headEnd = html.indexOf("</head>");
  expect(headEnd, "the document has a </head>").toBeGreaterThan(0);
  return scriptAndLinkTags(html.slice(0, headEnd)).filter(
    (t) =>
      t.startsWith("<script") &&
      t.includes('type="module"') &&
      t.includes('src="') &&
      t.includes("async"),
  );
}

/**
 * Hydration made a client component interactive: clicking a rango `<Link>`
 * (a client component) performs a client navigation to `pathname`, and the
 * window marker set before the click survives (no document reload).
 */
export async function expectClientLinkNavigation(
  page: Page,
  linkTestId: string,
  pathname: string,
): Promise<void> {
  await markDocument(page);
  await page.getByTestId(linkTestId).first().click();
  await page.waitForURL((url) => url.pathname === pathname);
  expect(
    await isMarkedDocument(page),
    "client navigation kept the document (no reload)",
  ).toBe(true);
}

function byTestId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

type MarkedWindow = { __e2eMarkedDocument?: boolean };

/**
 * A window global does not survive a document load, so the pair tells a
 * client navigation (still marked) from a reload or a back/forward that
 * loaded the document (no longer marked).
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as MarkedWindow).__e2eMarkedDocument = true;
  });
}

async function isMarkedDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as MarkedWindow).__e2eMarkedDocument === true,
  );
}

/**
 * The Fizz bootstrap script — the executing entry tag React stamps with the
 * completed-shell id (`id="_R_"`). Throws (via expect) when absent.
 */
export function fizzBootstrapScript(html: string): {
  tag: string;
  src: string;
} {
  const tag = scriptAndLinkTags(html).find((t) => t.includes('id="_R_"'));
  expect(tag, "the fizz bootstrap script (id=_R_) is present").toBeTruthy();
  const src = tag!.match(/src="([^"]+)"/)?.[1];
  expect(src, "the bootstrap script has a src").toBeTruthy();
  return { tag: tag!, src: src! };
}

/**
 * Fizz Suspense boundary markers in a served document: `<!--$-->` (complete)
 * and `<!--$?-->` (pending, completed later by `$RC`).
 */
export function countHtmlBoundaryMarkers(html: string): number {
  return (html.match(/<!--\$\??-->/g) ?? []).length;
}

/**
 * Boundary markers in the live DOM once the stream settled. `$RC` rewrites a
 * pending `$?` marker to `$` in place, while a client-rendered boundary
 * deletes its dehydrated nodes, so `adopted` equals
 * countHtmlBoundaryMarkers(document) exactly when every boundary adopted the
 * server HTML. A boundary that errored after its placeholder flushed becomes
 * `$!` (never `$`); counted separately so a loader error does not read as a
 * lost adoption.
 */
export function countDomBoundaryMarkers(
  page: Page,
): Promise<{ adopted: number; errored: number }> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    const counts = { adopted: 0, errored: 0 };
    while (walker.nextNode()) {
      const data = (walker.currentNode as Comment).data;
      if (data === "$") counts.adopted++;
      else if (data === "$!") counts.errored++;
    }
    return counts;
  });
}

/**
 * Shared body of the streamed-boundary-adoption suites: a boundary that
 * resolves AFTER the shell hydrated must stay dehydrated and adopt the server
 * HTML Fizz outlines for it ($RC swap), never be client-rendered from the
 * Flight payload. Root cause and mechanism: the contextValue comment in
 * packages/rangojs-router/src/theme/ThemeProvider.tsx.
 *
 * `contentTestIds` are the streamed boundaries' contents; at least one must
 * still be pending when the shell hydrates, otherwise the run proves nothing.
 */
export async function expectStreamedBoundariesAdopted(
  page: Page,
  options: { url: string; mode: "dev" | "build"; contentTestIds: string[] },
): Promise<void> {
  const { url, mode, contentTestIds } = options;
  const content = contentTestIds.map((id) => byTestId(page, id));

  if (mode === "dev") {
    // Warm the module graph so hydration reliably beats the loaders; a build
    // has no compile race.
    await page.goto(url);
    for (const locator of content) await expect(locator).toBeVisible();
  }

  const documentResponse = page.waitForResponse(
    (r) => r.url() === url && r.request().resourceType() === "document",
  );
  // "commit", not the default "load": load fires only after the streamed
  // document closed, i.e. after every boundary already flushed.
  await page.goto(url, { waitUntil: "commit" });
  await waitForShellHydration(page);

  const pending = await page.evaluate(
    (ids) => ({
      missing: ids.filter(
        (id) => !document.querySelector(`[data-testid="${id}"]`),
      ),
      placeholder: !!document.querySelector('template[id^="B:"]'),
    }),
    contentTestIds,
  );
  expect(
    pending.missing,
    "a boundary is still pending when the shell hydrates",
  ).not.toEqual([]);
  // A client-rendered boundary deletes its dehydrated nodes at mount, so the
  // bug already shows here, before the stream settles.
  expect(
    pending.placeholder,
    "the pending boundary is still dehydrated (Fizz placeholder present)",
  ).toBe(true);

  for (const locator of content) await expect(locator).toBeVisible();
  const serverMarkers = countHtmlBoundaryMarkers(
    await (await documentResponse).text(),
  );
  expect(serverMarkers).toBeGreaterThan(0);
  expect(
    (await countDomBoundaryMarkers(page)).errored,
    "no boundary errored ($! marker)",
  ).toBe(0);
  await expect
    .poll(async () => (await countDomBoundaryMarkers(page)).adopted)
    .toBe(serverMarkers);
}

/** Fetch a URL as a document (Accept: text/html) and return the HTML text. */
export async function fetchDocument(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  expect(res.ok).toBe(true);
  return res.text();
}

/**
 * A router navigation through the link interceptor: a same-origin anchor
 * click that, unlike a locator click, does not scroll a link into view first.
 */
export async function routerNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((href) => {
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, url);
  await expect(page).toHaveURL(url);
}

/**
 * Push enough router navigations to evict the current entry from the router's
 * 20-entry history cache (navigation-store.ts HISTORY_CACHE_SIZE), then
 * traverse back to it, so the return is a cache-miss refetch. Pass a
 * `fillerUrl` on another route: the origin page reappearing then means the
 * refetch commit has landed.
 */
export async function returnToEvictedEntry(
  page: Page,
  fillerUrl: (n: number) => string,
): Promise<void> {
  await pushEvictingEntries(page, fillerUrl);
  await goBackToEvictedEntry(page);
}

/** One more than the history cache holds (HISTORY_CACHE_SIZE, 20). */
const EVICTING_ENTRIES = 21;

/** The pushes of returnToEvictedEntry: `fillerUrl(EVICTING_ENTRIES)` is left on screen. */
async function pushEvictingEntries(
  page: Page,
  fillerUrl: (n: number) => string,
): Promise<void> {
  for (let n = 1; n <= EVICTING_ENTRIES; n++) {
    await routerNavigate(page, fillerUrl(n));
  }
}

/** The traversal of returnToEvictedEntry. Resolves once it is started. */
async function goBackToEvictedEntry(page: Page): Promise<void> {
  await page.evaluate((delta) => window.history.go(-delta), EVICTING_ENTRIES);
}

/**
 * #992: after a reload, a useLocationState reader inside a `<Suspense>`
 * boundary that hydrates after the root must hydrate as the server rendered it
 * (`undefined`) and show the stored value on the next render.
 *
 * The fixture (both apps: `<url>/:gate`, released by GET `<url>/:gate/release`)
 * holds the boundary's server content until this body releases it. "After the
 * root" is therefore asserted, not left to a timer: the fallback is still on
 * screen once the root has hydrated. A held boundary keeps the document stream
 * open, so each load waits for "commit" and hydration is awaited with
 * waitForShellHydration (an app's waitForHydration waits for DOMContentLoaded,
 * which does not come before the release).
 */
export async function expectLateSuspenseReaderHydratesClean(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const gateUrl = `${url}/${randomUUID()}`;
  const loadHeld = async (load: () => Promise<unknown>): Promise<void> => {
    await load();
    await waitForShellHydration(page);
    await expect(byTestId(page, "late-ls-fallback")).toBeVisible();
    expect((await page.request.get(`${gateUrl}/release`)).ok()).toBe(true);
  };

  await loadHeld(() => page.goto(gateUrl, { waitUntil: "commit" }));
  await expect(byTestId(page, "late-ls-value")).toHaveText("empty");
  await byTestId(page, "late-ls-write").click();

  await loadHeld(() => page.reload({ waitUntil: "commit" }));
  await expect(byTestId(page, "late-ls-value")).toHaveText("stored-value");
}

/**
 * The entry's typed location-state slots, keyed by `<ExportName><suffix>`: the
 * tail of the injected key (`__rsc_ls_<path or hash>#<ExportName>`) that is
 * the same in dev and in a build, plus the suffix the definition's
 * `clearOnReload` adds. Values are stored raw.
 */
async function locationStateSlots(
  page: Page,
): Promise<Record<string, unknown>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries((window.history.state ?? {}) as Record<string, unknown>)
        .filter(([key]) => key.startsWith("__rsc_ls_"))
        .map(([key, value]) => [key.slice(key.lastIndexOf("#") + 1), value]),
    ),
  );
}

const loadMoreItems = (pageNumber: number): string[] =>
  [1, 2, 3].map((item) => `p${pageNumber}-${item}`);

/**
 * Opening steps of the #994 "load more" bodies. The fixture (both apps:
 * `<url>?page=N`) renders page N's three items on the server. Its `lm-more`
 * Link goes to page N+1 carrying every item on screen as a `clearOnReload`
 * slot, plus a slot without options (`lm-sort`). The route's handler sets a
 * `clearOnReload` slot of its own on every request (`lm-server-page`),
 * document loads included.
 *
 * Loads page 1, then navigates to page 2 on the client. Leaves the page on an
 * entry holding all three slots.
 */
async function openLoadMorePageTwo(page: Page, url: string): Promise<void> {
  const items = byTestId(page, "lm-items").locator("li");

  // A document response carries no location state: what the handler set for
  // this load does not reach history.state, so start-up has nothing of the
  // server's to drop.
  await page.goto(`${url}?page=1`);
  await waitForShellHydration(page);
  await expect(items).toHaveText(loadMoreItems(1));
  await expect(byTestId(page, "lm-server-page")).toHaveText("none");
  expect(await locationStateSlots(page)).toEqual({});

  // A client navigation shows the carried items above the new page's, and
  // delivers the state the handler set for it.
  await byTestId(page, "lm-more").click();
  await expect(page).toHaveURL(`${url}?page=2`);
  await expect(items).toHaveText([...loadMoreItems(1), ...loadMoreItems(2)]);
  await expect(byTestId(page, "lm-server-page")).toHaveText("2");
  expect(await locationStateSlots(page)).toEqual({
    "CarriedItems~r": loadMoreItems(1),
    "ServerPageStamp~r": { page: 2 },
    ListSort: { order: "asc" },
  });
}

/**
 * What a document load of that entry must leave: the page as the server
 * rendered it, both `~r` slots gone from history.state, the slot without
 * options still applied.
 *
 * The server HTML never contains carried items, so "not shown" would pass
 * before the client applied anything. `lm-sort` comes from history.state too:
 * once it shows, the client snapshots are in.
 */
async function expectLoadMorePageTwoAsServerRendered(
  page: Page,
): Promise<void> {
  await waitForShellHydration(page);
  await expect(byTestId(page, "lm-sort")).toHaveText("asc");
  await expect(byTestId(page, "lm-carried-count")).toHaveText("0");
  await expect(byTestId(page, "lm-server-page")).toHaveText("none");
  await expect(byTestId(page, "lm-items").locator("li")).toHaveText(
    loadMoreItems(2),
  );
  expect(await locationStateSlots(page)).toEqual({
    ListSort: { order: "asc" },
  });
}

/**
 * #994 `createLocationState({ clearOnReload: true })`: carried by a client
 * navigation, dropped by a reload, carried again by the next navigation.
 */
export async function expectClearOnReloadDropsCarriedState(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const items = byTestId(page, "lm-items").locator("li");
  const carried = byTestId(page, "lm-carried-count");

  await openLoadMorePageTwo(page, url);
  await page.reload();
  await expectLoadMorePageTwoAsServerRendered(page);

  await byTestId(page, "lm-more").click();
  await expect(page).toHaveURL(`${url}?page=3`);
  await expect(items).toHaveText([...loadMoreItems(2), ...loadMoreItems(3)]);
  await expect(byTestId(page, "lm-server-page")).toHaveText("3");

  // Back inside the running app: the cleared entry is not resurrected.
  await page.goBack();
  await expect(page).toHaveURL(`${url}?page=2`);
  await expect(byTestId(page, "lm-page")).toHaveText("2");
  await expect(carried).toHaveText("0");
  await expect(items).toHaveText(loadMoreItems(2));

  // Forward: popstate applies the entry's state, as it always did.
  await page.goForward();
  await expect(page).toHaveURL(`${url}?page=3`);
  await expect(carried).toHaveText("3");
  await expect(items).toHaveText([...loadMoreItems(2), ...loadMoreItems(3)]);
}

/**
 * #994 `clearOnReload` when a back/forward loads the document from the server
 * instead of a reload. A back/forward cache restore would keep the marked
 * document and its state, and is not this case.
 */
export async function expectClearOnReloadDropsStateOnTraversalLoad(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);

  await openLoadMorePageTwo(page, url);
  await markDocument(page);
  await page.goto(`${url}?page=9`);
  await waitForShellHydration(page);
  await page.goBack();
  await expect(page).toHaveURL(`${url}?page=2`);
  expect(await isMarkedDocument(page)).toBe(false);

  await expectLoadMorePageTwoAsServerRendered(page);
}

/** How long the load-more fixture's loader holds a page (`?hold=<ms>`). */
const LOAD_MORE_HOLD_MS = 2500;
/** A part of the hold long enough to see the list is still held. */
const LOAD_MORE_HELD_CHECK_MS = 600;

/** What the list shows on page N after carrying pages 1..N-1. */
const loadMoreThrough = (pageNumber: number): string[] =>
  Array.from({ length: pageNumber }, (_, index) =>
    loadMoreItems(index + 1),
  ).flat();

/**
 * The fixture's own record of every list it committed (`<page>:<items>`),
 * consecutive repeats removed: a commit that never survived to a sample is in
 * here too.
 */
async function loadMoreCommits(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __loadMoreCommits?: string[] })
        .__loadMoreCommits ?? [],
  );
}

const loadMoreCommit = (pageNumber: number, shown: string[]): string =>
  `${pageNumber}:${shown.join(",")}`;

/**
 * The load-more fixture at one instant. `content` is what the shared layout
 * holds: the list, the other fixture's panel, or neither. `sharedCarried` is
 * the layout's own reader of the carried items, `carried` the list's, and
 * `serverPage` the state the route's handler set for the entry ("none" for an
 * entry a document load started). `late` is the reader `lm-open-late` mounts:
 * `<page of the list it is in>:<carried items it reads>`, null until then.
 */
interface LoadMoreScreen {
  content: "list" | "panel" | "none";
  page: string | null;
  carried: string | null;
  sharedCarried: string | null;
  serverPage: string | null;
  late: string | null;
  items: string[];
}

type LoadMoreWindow = {
  __loadMoreScreen: () => LoadMoreScreen;
  __loadMoreSamples: LoadMoreScreen[];
};

/**
 * Installs a reader of the fixture's screen and records one sample per DOM
 * mutation from now on, so a state that was on screen between two assertions
 * is kept. Lost on a document load.
 */
async function watchLoadMore(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as LoadMoreWindow;
    const text = (id: string): string | null =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    scope.__loadMoreScreen = () => ({
      content: document.querySelector('[data-testid="lm-items"]')
        ? "list"
        : document.querySelector('[data-testid="grid-step"]')
          ? "panel"
          : "none",
      page: text("lm-page"),
      carried: text("lm-carried-count"),
      sharedCarried: text("ls-shared-carried"),
      serverPage: text("lm-server-page"),
      late: text("lm-late"),
      items: Array.from(
        document.querySelectorAll('[data-testid="lm-items"] li'),
        (li) => li.textContent ?? "",
      ),
    });
    scope.__loadMoreSamples = [scope.__loadMoreScreen()];
    new MutationObserver(() => {
      scope.__loadMoreSamples.push(scope.__loadMoreScreen());
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/** One read of every part, so the parts belong to the same DOM state. */
async function loadMoreScreen(page: Page): Promise<LoadMoreScreen> {
  return page.evaluate(() =>
    (window as unknown as LoadMoreWindow).__loadMoreScreen(),
  );
}

/**
 * The recorded samples that pair one entry's state with another entry's
 * tree. A list repeats no item, and is its carried items plus its own page;
 * the layout's reader agrees with the list's; the handler's state names the
 * page on screen; a reader mounted late agrees with the list it is in; over
 * the other fixture's panel (an entry without carried items) the layout's
 * reader reads none.
 */
async function tornLoadMoreSamples(page: Page): Promise<LoadMoreScreen[]> {
  const samples = await page.evaluate(
    () => (window as unknown as LoadMoreWindow).__loadMoreSamples,
  );
  return samples.filter(
    (sample) =>
      new Set(sample.items).size !== sample.items.length ||
      (sample.content === "list" &&
        (sample.sharedCarried !== sample.carried ||
          sample.items.length !== Number(sample.carried) + 3 ||
          (sample.serverPage !== "none" && sample.serverPage !== sample.page) ||
          (sample.late !== null &&
            sample.late !== `${sample.page}:${sample.carried}`))) ||
      (sample.content === "panel" && sample.sharedCarried !== "0"),
  );
}

/**
 * #1029: a "load more" navigation whose loader is still streaming. The fixture
 * (both apps: `<url>?page=N&hold=<ms>`) loads page N's items through a loader
 * that waits `hold` ms for every page after the first, and its `lm-more` Link
 * carries every item on screen to the next page. The navigation's payload
 * arrives at once, so the router commits the next entry (URL, history.state)
 * and React keeps the current page on screen until the loader lands.
 *
 * During that window the screen must be the current entry's: the carried items
 * of the NEXT entry are the ones on screen, so applying them early shows every
 * item twice. Checked three ways: the screen while the navigation is pending,
 * every DOM state in between, and every list the fixture committed.
 */
export async function expectHeldLoadMoreShowsNoItemTwice(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const items = byTestId(page, "lm-items").locator("li");
  const pageOnScreen = byTestId(page, "lm-page");
  const entry = (pageNumber: number): string =>
    `${url}?page=${pageNumber}&hold=${LOAD_MORE_HOLD_MS}`;

  await page.goto(entry(1));
  await waitForShellHydration(page);
  await expect(items).toHaveText(loadMoreItems(1));
  await watchLoadMore(page);

  for (const next of [2, 3]) {
    const leaving: LoadMoreScreen = {
      content: "list",
      page: String(next - 1),
      carried: String(loadMoreThrough(next - 2).length),
      sharedCarried: String(loadMoreThrough(next - 2).length),
      // Page 1 came with the document, which carries no location state.
      serverPage: next === 2 ? "none" : String(next - 1),
      late: null,
      items: loadMoreThrough(next - 1),
    };
    await byTestId(page, "lm-more").click();

    // The router is on the next entry; its tree is not: the loader holds it.
    await expect(page).toHaveURL(entry(next));
    expect(await locationStateSlots(page)).toMatchObject({
      "CarriedItems~r": leaving.items,
    });
    expect(await loadMoreScreen(page)).toEqual(leaving);
    // Still held a good part of the hold later, and still the same screen.
    await page.waitForTimeout(LOAD_MORE_HELD_CHECK_MS);
    expect(await loadMoreScreen(page)).toEqual(leaving);

    await expect(pageOnScreen).toHaveText(String(next));
    await expect(items).toHaveText(loadMoreThrough(next));
  }

  expect(await tornLoadMoreSamples(page)).toEqual([]);
  expect(await loadMoreCommits(page)).toEqual(
    [1, 2, 3].map((n) => loadMoreCommit(n, loadMoreThrough(n))),
  );
}

/**
 * #1029 for a reader that mounts while a navigation is pending. Same fixture
 * and hold as above; `lm-open-late` mounts a second reader of the carried
 * items inside the list.
 *
 * Pressed during the hold, the reader mounts in the page still on screen,
 * after history has moved to the next entry: it must read the entry on
 * screen (no carried items), not the one history holds (three). It then
 * changes with the list, in the commit that brings the next page.
 */
export async function expectReaderMountedDuringHeldNavigationReadsEntryOnScreen(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const late = byTestId(page, "lm-late");
  const entry = (pageNumber: number): string =>
    `${url}?page=${pageNumber}&hold=${LOAD_MORE_HOLD_MS}`;

  await page.goto(entry(1));
  await waitForShellHydration(page);
  await expect(byTestId(page, "lm-items").locator("li")).toHaveText(
    loadMoreItems(1),
  );
  await watchLoadMore(page);

  await byTestId(page, "lm-more").click();
  await expect(page).toHaveURL(entry(2));
  expect(await locationStateSlots(page)).toMatchObject({
    "CarriedItems~r": loadMoreItems(1),
  });

  await byTestId(page, "lm-open-late").click();
  // One read, not a poll: a poll would outlast the hold and see the next page.
  expect(await late.textContent()).toBe("1:0");
  expect(await loadMoreScreen(page)).toMatchObject({
    page: "1",
    carried: "0",
    late: "1:0",
  });

  await expect(byTestId(page, "lm-page")).toHaveText("2");
  await expect(late).toHaveText(`2:${loadMoreItems(1).length}`);
  expect(await tornLoadMoreSamples(page)).toEqual([]);
}

/**
 * #1029 for back/forward: an entry's carried items come back together with
 * that entry's page, from the client cache and from a refetch.
 *
 * Cached: back and forward across three entries; every list the fixture
 * committed is one entry's own. Refetch: 21 entries on `otherUrl` (the other
 * fixture under the same layout, without carried items) evict the list's
 * entry from the history cache, and the return fetches it with its loader
 * held. The layout's reader stays mounted through all of it: it reads carried
 * items only once the list is back under it.
 */
export async function expectLoadMoreTraversalRestoresEntryWithItsPage(
  page: Page,
  url: string,
  otherUrl: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const items = byTestId(page, "lm-items").locator("li");
  const pageOnScreen = byTestId(page, "lm-page");
  const entry = (pageNumber: number): string =>
    `${url}?page=${pageNumber}&hold=${LOAD_MORE_HOLD_MS}`;
  const expectEntry = async (pageNumber: number): Promise<void> => {
    await expect(page).toHaveURL(entry(pageNumber));
    await expect(pageOnScreen).toHaveText(String(pageNumber));
    await expect(items).toHaveText(loadMoreThrough(pageNumber));
  };

  await page.goto(entry(1));
  await waitForShellHydration(page);
  await expect(items).toHaveText(loadMoreItems(1));
  await watchLoadMore(page);
  for (const pageNumber of [2, 3]) {
    await byTestId(page, "lm-more").click();
    await expectEntry(pageNumber);
  }

  for (const [go, pageNumber] of [
    [() => page.goBack(), 2],
    [() => page.goBack(), 1],
    [() => page.goForward(), 2],
    [() => page.goForward(), 3],
  ] as const) {
    await go();
    await expectEntry(pageNumber);
  }
  expect(await loadMoreCommits(page)).toEqual(
    [1, 2, 3, 2, 1, 2, 3].map((n) => loadMoreCommit(n, loadMoreThrough(n))),
  );

  await returnToEvictedEntry(page, (n) => `${otherUrl}?step=filler-${n}`);
  await expectEntry(3);
  await expect(byTestId(page, "ls-shared-carried")).toHaveText(
    String(loadMoreThrough(2).length),
  );
  expect((await loadMoreCommits(page)).slice(-1)).toEqual([
    loadMoreCommit(3, loadMoreThrough(3)),
  ]);

  expect(await tornLoadMoreSamples(page)).toEqual([]);
}

/**
 * #1030: back/forward to an entry of the SAME route that differs only in its
 * search params, after the history cache dropped it. The load-more fixture is
 * that case once the list is long: 21 more pages of the list evict page 2's
 * entry, and the return to it is a refetch.
 *
 * The page the URL names must come back, with its entry's carried items. The
 * refetch is held by the loader (`hold`), so the page being left stays on
 * screen meanwhile with its own entry's state, for a reader that mounts then
 * too (#1029): history.state is the destination's from the popstate event on.
 *
 * Page 2 is reached through `lm-more-cold`, a URL nothing prefetches: a
 * prefetched response is kept for its TTL and would serve the return without
 * asking the server.
 */
export async function expectEvictedSameRouteTraversalRestoresItsPage(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const items = byTestId(page, "lm-items").locator("li");
  const pageOnScreen = byTestId(page, "lm-page");
  const evicted = `${url}?page=2&cold=1&hold=${LOAD_MORE_HOLD_MS}`;

  await page.goto(`${url}?page=1&hold=${LOAD_MORE_HOLD_MS}`);
  await waitForShellHydration(page);
  await byTestId(page, "lm-more-cold").click();
  await expect(page).toHaveURL(evicted);
  await expect(items).toHaveText(loadMoreThrough(2));
  await watchLoadMore(page);

  // Entries of the same route, without state or hold, each committed before
  // the next: page 23 is on screen when the return starts.
  const lastFiller = 23;
  await returnToEvictedEntry(page, (n) => `${url}?page=${2 + n}`);

  // The URL is the entry's at once; its page is not: the loader holds it.
  await expect(page).toHaveURL(evicted);
  expect(await locationStateSlots(page)).toMatchObject({
    "CarriedItems~r": loadMoreItems(1),
  });
  await byTestId(page, "lm-open-late").click();
  expect(await loadMoreScreen(page)).toMatchObject({
    page: String(lastFiller),
    carried: "0",
    sharedCarried: "0",
    late: `${lastFiller}:0`,
    items: loadMoreItems(lastFiller),
  });

  await expect(pageOnScreen).toHaveText("2");
  await expect(items).toHaveText(loadMoreThrough(2));
  await expect(byTestId(page, "lm-late")).toHaveText(
    `2:${loadMoreItems(1).length}`,
  );
  await expect(byTestId(page, "lm-server-page")).toHaveText("2");
  expect((await loadMoreCommits(page)).slice(-1)).toEqual([
    loadMoreCommit(2, loadMoreThrough(2)),
  ]);
  expect(await tornLoadMoreSamples(page)).toEqual([]);
}

/** `<pathname>?<search>`: how the load-more fixture's URL readers render a URL. */
const shownUrl = (url: string): string => {
  const { pathname, searchParams } = new URL(url);
  return `${pathname}?${searchParams}`;
};

/**
 * The URL readers of the load-more fixture at one instant (#1031). `shows` is
 * the page under the shared layout: `list:<page>`, `panel:<step>` or `none`.
 * `pageUrl`, `layoutUrl` and `lateUrl` are usePathname() and
 * useSearchParams() as that page reads them, the layout above it, and the
 * reader the page mounts on demand (null until then). `navigation` is the
 * layout's useNavigation():
 * `<state>|<streaming or settled>|<location>|<pendingUrl or none>`.
 */
interface UrlScreen {
  shows: string;
  pageUrl: string | null;
  layoutUrl: string | null;
  lateUrl: string | null;
  navigation: string | null;
}

type UrlWindow = {
  __urlScreen: () => UrlScreen;
  __urlSamples: UrlScreen[];
};

/** watchLoadMore for the URL readers: one sample per DOM mutation from now on. */
async function watchUrlReaders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as UrlWindow;
    const text = (id: string): string | null =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    scope.__urlScreen = () => {
      const listPage = text("lm-page");
      const step = text("grid-step");
      return {
        shows:
          listPage !== null
            ? `list:${listPage}`
            : step !== null
              ? `panel:${step}`
              : "none",
        pageUrl: text(listPage !== null ? "lm-url" : "grid-url"),
        layoutUrl: text("ls-shared-url"),
        lateUrl: text(listPage !== null ? "lm-late-url" : "grid-late-url"),
        navigation: text("ls-shared-nav"),
      };
    };
    scope.__urlSamples = [scope.__urlScreen()];
    new MutationObserver(() => {
      scope.__urlSamples.push(scope.__urlScreen());
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/** Drops the samples recorded so far: sampling starts again from this DOM state. */
async function restartUrlSamples(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as UrlWindow;
    scope.__urlSamples = [scope.__urlScreen()];
  });
}

/** One read of every reader, so they belong to the same DOM state. */
async function urlScreen(page: Page): Promise<UrlScreen> {
  return page.evaluate(() => (window as unknown as UrlWindow).__urlScreen());
}

/**
 * The recorded samples in which a URL reader does not name the page it is
 * shown in. The page's reader has that page's path and names the page on
 * screen (`?page` for the list, `?step` for the panel); the layout's reader
 * and the late reader agree with it.
 */
async function tornUrlSamples(
  page: Page,
  listUrl: string,
  panelUrl?: string,
): Promise<UrlScreen[]> {
  const samples = await page.evaluate(
    () => (window as unknown as UrlWindow).__urlSamples,
  );
  const paths: Record<string, string | undefined> = {
    list: new URL(listUrl).pathname,
    panel: panelUrl && new URL(panelUrl).pathname,
  };
  return samples.filter((sample) => {
    const [kind, shown] = sample.shows.split(":");
    if (kind === "none") return false;
    const [pathname, search] = (sample.pageUrl ?? "").split("?");
    const params = new URLSearchParams(search);
    const named =
      kind === "list"
        ? (params.get("page") ?? "1")
        : (params.get("step") ?? "start");
    return (
      pathname !== paths[kind!] ||
      named !== shown ||
      sample.layoutUrl !== sample.pageUrl ||
      (sample.lateUrl !== null && sample.lateUrl !== sample.pageUrl)
    );
  });
}

/**
 * Holds the router's fetch of `url` (a client navigation's partial request,
 * not a document load) until `release()`. `held` resolves once the request is
 * out: the navigation is then pending and nothing of its response has
 * arrived.
 */
async function holdNavigationRequest(
  page: Page,
  url: string,
): Promise<{ held: Promise<void>; release: () => void }> {
  const target = new URL(url);
  let markHeld!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (markHeld = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (request) =>
      request.searchParams.has("_rsc_partial") &&
      request.pathname === target.pathname &&
      [...target.searchParams].every(
        ([name, value]) => request.searchParams.get(name) === value,
      ),
    async (route) => {
      markHeld();
      await released;
      await route.continue();
    },
  );
  return { held, release };
}

/**
 * Opens the load-more list's page 2 through `lm-more-cold` (an entry nothing
 * prefetches, see expectEvictedSameRouteTraversalRestoresItsPage), pushes it
 * out of the history cache with `filler` entries and leaves the last of them
 * on screen and settled. `hold` makes the entry's loader wait each time the
 * entry is fetched.
 *
 * The URL readers are sampled from that settled state on, not through the
 * fillers: those are pushed back to back, each started as soon as the one
 * before it is in the address bar, and a page that mounts while the next
 * push has already committed its transaction reads that push's URL (#1046).
 */
async function leaveEvictedListEntry(
  page: Page,
  url: string,
  options: {
    hold: boolean;
    filler: (n: number) => string;
    /** UrlScreen.shows of the last filler. */
    leavingShows: string;
  },
): Promise<{ entry: string; leaving: string }> {
  const hold = options.hold ? `&hold=${LOAD_MORE_HOLD_MS}` : "";
  const entry = `${url}?page=2&cold=1${hold}`;
  const leaving = options.filler(EVICTING_ENTRIES);

  await page.goto(`${url}?page=1${hold}`);
  await waitForShellHydration(page);
  await watchUrlReaders(page);
  await byTestId(page, "lm-more-cold").click();
  await expect(page).toHaveURL(entry);
  await expect(byTestId(page, "lm-page")).toHaveText("2");

  await pushEvictingEntries(page, options.filler);
  await expect
    .poll(() => urlScreen(page))
    .toEqual({
      shows: options.leavingShows,
      pageUrl: shownUrl(leaving),
      layoutUrl: shownUrl(leaving),
      lateUrl: null,
      navigation: `idle|settled|${shownUrl(leaving)}|none`,
    });
  await restartUrlSamples(page);
  return { entry, leaving };
}

/**
 * #1031: back/forward to an entry that has to be fetched, while its request
 * is out. The browser has already moved (address bar, history.state) and the
 * page being left is still on screen: usePathname() and useSearchParams()
 * have to keep reporting THAT page's URL until the entry's page commits, for
 * the readers already mounted and for one that mounts during the wait. They
 * used to change at the popstate event.
 *
 * `from` is the page being left: another page of the list (the same route, a
 * search-only change), or the panel fixture next to it at `otherUrl` (another
 * route under the same layout, so the layout's reader stays mounted across
 * the return). useNavigation() is what reports the pending traversal:
 * `state` "loading" and `pendingUrl` the entry, `location` the page on screen.
 */
export async function expectRequestHeldBackKeepsUrlOfPageOnScreen(
  page: Page,
  url: string,
  otherUrl: string,
  from: "same-route" | "cross-route",
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const sameRoute = from === "same-route";
  const leavingShows = sameRoute
    ? `list:${2 + EVICTING_ENTRIES}`
    : `panel:filler-${EVICTING_ENTRIES}`;
  const { entry, leaving } = await leaveEvictedListEntry(page, url, {
    hold: false,
    filler: sameRoute
      ? (n) => `${url}?page=${2 + n}`
      : (n) => `${otherUrl}?step=filler-${n}`,
    leavingShows,
  });

  const request = await holdNavigationRequest(page, entry);
  await goBackToEvictedEntry(page);
  await request.held;

  // The address bar is the entry's at once; the page and its readers are not.
  await expect(page).toHaveURL(entry);
  await expect(byTestId(page, "ls-shared-nav")).toHaveText(/^loading\|/);
  const held: UrlScreen = {
    shows: leavingShows,
    pageUrl: shownUrl(leaving),
    layoutUrl: shownUrl(leaving),
    lateUrl: null,
    navigation: `loading|streaming|${shownUrl(leaving)}|${shownUrl(entry)}`,
  };
  expect(await urlScreen(page)).toEqual(held);

  await byTestId(page, sameRoute ? "lm-open-late" : "grid-open-late").click();
  expect(await urlScreen(page)).toEqual({
    ...held,
    lateUrl: shownUrl(leaving),
  });

  request.release();
  await expect
    .poll(() => urlScreen(page))
    .toEqual({
      shows: "list:2",
      pageUrl: shownUrl(entry),
      layoutUrl: shownUrl(entry),
      // The list keeps its late reader across a search-only change; the
      // panel's went with the panel.
      lateUrl: sameRoute ? shownUrl(entry) : null,
      navigation: `idle|settled|${shownUrl(entry)}|none`,
    });
  expect(await tornUrlSamples(page, url, otherUrl)).toEqual([]);
}

/**
 * A return to the evicted entry of the same route, past its response: the
 * transaction has committed and React holds the entry's page behind a loader
 * that is still streaming, so the page being left (the list's last filler
 * page) is on screen. useNavigation() reports this part of the wait as
 * `isStreaming`; its `state` is back to "idle".
 */
async function returnToEvictedEntryWithLoaderHeld(
  page: Page,
  url: string,
): Promise<{ entry: string; leaving: string; leavingShows: string }> {
  const leavingShows = `list:${2 + EVICTING_ENTRIES}`;
  const { entry, leaving } = await leaveEvictedListEntry(page, url, {
    hold: true,
    filler: (n) => `${url}?page=${2 + n}`,
    leavingShows,
  });
  await goBackToEvictedEntry(page);
  await expect(page).toHaveURL(entry);
  await expect(byTestId(page, "ls-shared-nav")).toHaveText(
    /^idle\|streaming\|/,
  );
  return { entry, leaving, leavingShows };
}

/**
 * #1031 for the rest of the wait: the entry's response has arrived and React
 * holds its page (see returnToEvictedEntryWithLoaderHeld). The readers
 * already mounted keep the URL of the page on screen until the entry's page
 * commits. A reader that mounts now is #1046:
 * expectReaderMountedInHeldPageReadsItsUrl.
 */
export async function expectLoaderHeldBackKeepsUrlForMountedReaders(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const { entry, leaving, leavingShows } =
    await returnToEvictedEntryWithLoaderHeld(page, url);

  expect(await urlScreen(page)).toMatchObject({
    shows: leavingShows,
    pageUrl: shownUrl(leaving),
    layoutUrl: shownUrl(leaving),
  });

  await expect
    .poll(() => urlScreen(page))
    .toMatchObject({
      shows: "list:2",
      pageUrl: shownUrl(entry),
      layoutUrl: shownUrl(entry),
    });
  expect(await tornUrlSamples(page, url)).toEqual([]);
}

/**
 * Known gap, #1046: a reader that first mounts in the page being left after
 * the navigation's response arrived, while React still holds the destination,
 * reads the destination's URL. The location moves with the transaction;
 * mounted readers take it in the batch React holds, a new one reads it at
 * mount.
 *
 * `knownGap` marks the rest of the test as expected to fail; the caller
 * passes `(reason) => test.fail(true, reason)`. Everything before it has to
 * pass, and the test turns red the day the last assertion does.
 */
export async function expectReaderMountedInHeldPageReadsItsUrl(
  page: Page,
  url: string,
  knownGap: (reason: string) => void,
): Promise<void> {
  const { leaving, leavingShows } = await returnToEvictedEntryWithLoaderHeld(
    page,
    url,
  );

  await byTestId(page, "lm-open-late").click();
  const screen = await urlScreen(page);
  // Still the page being left, and the reader is mounted in it.
  expect(screen).toMatchObject({
    shows: leavingShows,
    pageUrl: shownUrl(leaving),
    layoutUrl: shownUrl(leaving),
  });
  expect(screen.lateUrl).not.toBeNull();

  knownGap(
    "#1046: a reader mounted while React holds a navigation reads the destination's URL",
  );
  expect(screen.lateUrl).toBe(shownUrl(leaving));
}

/**
 * Control for #1031: a push whose request is out. A push commits its location
 * with its transaction, which has not happened yet, so every reader, mounted
 * or mounting now, reports the page on screen, and so does the address bar.
 */
export async function expectRequestHeldPushKeepsUrlOfPageOnScreen(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const leaving = `${url}?page=1`;
  const entry = `${url}?page=2&cold=1`;

  await page.goto(leaving);
  await waitForShellHydration(page);
  await watchUrlReaders(page);
  await expect(byTestId(page, "ls-shared-nav")).toHaveText(
    `idle|settled|${shownUrl(leaving)}|none`,
  );

  const request = await holdNavigationRequest(page, entry);
  await byTestId(page, "lm-push-cold").click();
  await request.held;

  await expect(byTestId(page, "ls-shared-nav")).toHaveText(/^loading\|/);
  const held: UrlScreen = {
    shows: "list:1",
    pageUrl: shownUrl(leaving),
    layoutUrl: shownUrl(leaving),
    lateUrl: null,
    navigation: `loading|streaming|${shownUrl(leaving)}|${shownUrl(entry)}`,
  };
  expect(await urlScreen(page)).toEqual(held);
  expect(page.url()).toBe(leaving);

  await byTestId(page, "lm-open-late").click();
  expect(await urlScreen(page)).toEqual({
    ...held,
    lateUrl: shownUrl(leaving),
  });

  request.release();
  await expect
    .poll(() => urlScreen(page))
    .toEqual({
      shows: "list:2",
      pageUrl: shownUrl(entry),
      layoutUrl: shownUrl(entry),
      lateUrl: shownUrl(entry),
      navigation: `idle|settled|${shownUrl(entry)}|none`,
    });
  await expect(page).toHaveURL(entry);
  expect(await tornUrlSamples(page, url)).toEqual([]);
}

/**
 * Control for #1031: back/forward to entries the history cache holds. There
 * is no wait: the URL the readers report and the page change in one DOM
 * state.
 */
export async function expectCachedTraversalChangesUrlWithItsPage(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const first = `${url}?page=1`;
  const second = `${url}?page=2&cold=1`;
  const entryOnScreen = (shows: string, entry: string): Partial<UrlScreen> => ({
    shows,
    pageUrl: shownUrl(entry),
    layoutUrl: shownUrl(entry),
    navigation: `idle|settled|${shownUrl(entry)}|none`,
  });

  await page.goto(first);
  await waitForShellHydration(page);
  await watchUrlReaders(page);
  await byTestId(page, "lm-more-cold").click();
  await expect
    .poll(() => urlScreen(page))
    .toMatchObject(entryOnScreen("list:2", second));

  await page.goBack();
  await expect
    .poll(() => urlScreen(page))
    .toMatchObject(entryOnScreen("list:1", first));
  await page.goForward();
  await expect
    .poll(() => urlScreen(page))
    .toMatchObject(entryOnScreen("list:2", second));
  expect(await tornUrlSamples(page, url)).toEqual([]);
}

/** The slow clientUrls group's middleware (both apps): every canonical request waits this long. */
const SLOW_GROUP_MIDDLEWARE_MS = 5000;
/** Anything under this is before the gated response could have arrived. */
const SLOW_GROUP_IMMEDIATE_MS = 1500;
const SLOW_GROUP_TIMEOUT = SLOW_GROUP_MIDDLEWARE_MS + 10_000;

/**
 * Every (identity, note) pair the slow group's readers committed, as
 * `<where>|<identity>|<note>` (the fixture's `SlowState` probe): `chrome` and
 * `layout` are identified by their pathname, `b` by its param.
 */
async function slowGroupCommits(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set(
      (window as unknown as { __cusStateCommits?: string[] })
        .__cusStateCommits ?? [],
    ),
  ]);
}

async function openSlowGroup(page: Page, url: string): Promise<void> {
  await page.goto(url, { timeout: SLOW_GROUP_TIMEOUT });
  await waitForShellHydration(page);
  await expect(byTestId(page, "cus-a")).toBeVisible();
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("none");
}

/**
 * #1029 for a cross-route `clientUrls()` navigation, which presents its
 * destination before the server responds. The fixture (both apps: the group at
 * `<url>`, behind a 5s middleware) has a location-state reader in chrome
 * outside the group, in the group's layout and in each page; `cus-a-to-b-note`
 * goes from A to B carrying a note.
 *
 * - The destination and the group layout are the optimistic branch: they show
 *   the note the navigation carries on their first optimistic render, long
 *   before history holds it.
 * - Chrome outside the branch keeps the committed entry (no note, A's
 *   pathname) until the canonical commit, then changes pathname and note in
 *   one commit.
 */
export async function expectOptimisticDestinationReadsItsLocationState(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  await openSlowGroup(page, url);

  await byTestId(page, "cus-a-to-b-note").click();

  await expect(byTestId(page, "cus-b")).toBeVisible({
    timeout: SLOW_GROUP_IMMEDIATE_MS,
  });
  await expect(byTestId(page, "cus-b-note")).toHaveText("for-first", {
    timeout: SLOW_GROUP_IMMEDIATE_MS,
  });
  await expect(byTestId(page, "cus-layout-note")).toHaveText("for-first");
  // Presentation only: the committed entry is A's, without a note.
  await expect(page).toHaveURL(url);
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("none");
  expect(await locationStateSlots(page)).toEqual({});

  await expect(byTestId(page, "cus-b-loader")).toHaveText("slow-data", {
    timeout: SLOW_GROUP_TIMEOUT,
  });
  await expect(page).toHaveURL(`${url}/b/first`);
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("for-first");
  await expect(byTestId(page, "cus-b-note")).toHaveText("for-first");
  await expect(byTestId(page, "cus-layout-note")).toHaveText("for-first");
  expect(await locationStateSlots(page)).toEqual({
    SlowNote: { value: "for-first" },
  });

  const { pathname } = new URL(url);
  const commits = await slowGroupCommits(page);
  expect(commits.filter((commit) => commit.startsWith("chrome|"))).toEqual([
    `chrome|${pathname}|none`,
    `chrome|${pathname}/b/first|for-first`,
  ]);
  // B never rendered without its note, the layout never showed B's pathname
  // with A's state.
  expect(commits.filter((commit) => commit.startsWith("b|"))).toEqual([
    "b|first|for-first",
  ]);
  expect(commits.filter((commit) => commit.startsWith("layout|"))).toEqual([
    `layout|${pathname}|none`,
    `layout|${pathname}/b/first|for-first`,
  ]);
}

/**
 * #1029 for `clientUrls()` navigations that keep the current content on
 * screen: a same-route one (`b/first` to `b/second`, never swapped) and a
 * cross-route one whose destination suspends with no boundary (B to E). Each
 * carries a note. Every reader keeps the entry it is showing, note included,
 * until the canonical commit, and no reader ever commits one entry's identity
 * with the other's note.
 */
export async function expectHeldClientUrlNavigationKeepsLocationState(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const { pathname } = new URL(url);
  const notes = ["cus-chrome-note", "cus-layout-note", "cus-b-note"];
  const expectNotes = async (note: string): Promise<void> => {
    for (const id of notes) await expect(byTestId(page, id)).toHaveText(note);
  };

  await openSlowGroup(page, url);
  await byTestId(page, "cus-a-to-b-note").click();
  await expect(byTestId(page, "cus-b-loader")).toHaveText("slow-data", {
    timeout: SLOW_GROUP_TIMEOUT,
  });
  await expectNotes("for-first");

  // Same route record, another param: the intent never swaps the content.
  await byTestId(page, "cus-b-to-b-note").click();
  await expect(byTestId(page, "cus-layout")).toHaveAttribute(
    "data-pending",
    "true",
    { timeout: SLOW_GROUP_IMMEDIATE_MS },
  );
  await expect(byTestId(page, "cus-b-param")).toHaveText("first");
  await expectNotes("for-first");
  await expect(byTestId(page, "cus-b-param")).toHaveText("second", {
    timeout: SLOW_GROUP_TIMEOUT,
  });
  await expect(page).toHaveURL(`${url}/b/second`);
  await expectNotes("for-second");

  // E suspends with no boundary: B stays until E commits.
  await byTestId(page, "cus-b-to-e-note").click();
  await expect(byTestId(page, "cus-layout")).toHaveAttribute(
    "data-pending",
    "true",
    { timeout: SLOW_GROUP_IMMEDIATE_MS },
  );
  await expect(byTestId(page, "cus-b")).toBeVisible();
  await expectNotes("for-second");
  await expect(byTestId(page, "cus-e")).toHaveText("slow-data", {
    timeout: SLOW_GROUP_TIMEOUT,
  });
  await expect(byTestId(page, "cus-b")).toHaveCount(0);
  await expect(byTestId(page, "cus-e-note")).toHaveText("for-e");
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("for-e");

  const commits = await slowGroupCommits(page);
  expect(commits.filter((commit) => commit.startsWith("b|"))).toEqual([
    "b|first|for-first",
    "b|second|for-second",
  ]);
  expect(commits.filter((commit) => commit.startsWith("e|"))).toEqual([
    "e|e|for-e",
  ]);
  expect(commits.filter((commit) => commit.startsWith("chrome|"))).toEqual([
    `chrome|${pathname}|none`,
    `chrome|${pathname}/b/first|for-first`,
    `chrome|${pathname}/b/second|for-second`,
    `chrome|${pathname}/e|for-e`,
  ]);
}

/**
 * #1029 for a `clientUrls()` navigation that never commits. Superseded: A to
 * `b/first` carrying one note, then, still inside the optimistic window, on
 * to `b/second` carrying another. Cancelled: a held same-route navigation
 * abandoned by going back.
 *
 * The note of a navigation that did not commit reaches the optimistic branch
 * only: never chrome outside it, never history, and it is gone with the
 * branch.
 */
export async function expectUncommittedClientUrlNavigationLeavesNoLocationState(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const { pathname } = new URL(url);
  await openSlowGroup(page, url);

  await byTestId(page, "cus-a-to-b-note").click();
  await expect(byTestId(page, "cus-b-note")).toHaveText("for-first", {
    timeout: SLOW_GROUP_IMMEDIATE_MS,
  });
  // Superseded before its response: the branch now presents the second one.
  await byTestId(page, "cus-b-to-b-note").click();
  await expect(byTestId(page, "cus-b-param")).toHaveText("second", {
    timeout: SLOW_GROUP_IMMEDIATE_MS,
  });
  await expect(byTestId(page, "cus-b-note")).toHaveText("for-second");
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("none");
  await expect(page).toHaveURL(url);

  await expect(byTestId(page, "cus-b-loader")).toHaveText("slow-data", {
    timeout: SLOW_GROUP_TIMEOUT,
  });
  await expect(page).toHaveURL(`${url}/b/second`);
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("for-second");
  expect(await locationStateSlots(page)).toEqual({
    SlowNote: { value: "for-second" },
  });

  // Cancelled: a held navigation to E, abandoned by going back to A.
  await byTestId(page, "cus-b-to-e-note").click();
  await expect(byTestId(page, "cus-layout")).toHaveAttribute(
    "data-pending",
    "true",
    { timeout: SLOW_GROUP_IMMEDIATE_MS },
  );
  await page.goBack();
  await expect(byTestId(page, "cus-a")).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(byTestId(page, "cus-a-note")).toHaveText("none");
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("none");
  await expect(byTestId(page, "cus-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
  // Past the abandoned response: nothing of it arrives later.
  await page.waitForTimeout(SLOW_GROUP_MIDDLEWARE_MS + 1000);
  await expect(byTestId(page, "cus-a")).toBeVisible();
  await expect(byTestId(page, "cus-chrome-note")).toHaveText("none");

  const commits = await slowGroupCommits(page);
  expect(commits.filter((commit) => commit.startsWith("chrome|"))).toEqual([
    `chrome|${pathname}|none`,
    `chrome|${pathname}/b/second|for-second`,
  ]);
  expect(commits.filter((commit) => commit.includes("for-e"))).toEqual([]);
  expect(commits.filter((commit) => commit.startsWith("a|"))).toEqual([
    "a|a|none",
  ]);
}

/**
 * Rewrites the app version the current entry records for its location state
 * (`__rsc_lsv`), the way an entry written by another build carries another
 * one. `undefined` removes the record: an entry from a release that did not
 * write one. This is how the bodies below get "a newer build is now running"
 * without building twice.
 */
async function recordEntryVersion(
  page: Page,
  version: string | undefined,
): Promise<void> {
  await page.evaluate((recorded) => {
    const { __rsc_lsv: _was, ...rest } = window.history.state;
    window.history.replaceState(
      recorded === undefined ? rest : { ...rest, __rsc_lsv: recorded },
      "",
    );
  }, version);
}

/**
 * Reloads the #994 app-version fixture (both apps) and waits until its readers hold
 * their client snapshots. The server HTML says "none" for every reader, so
 * "none" alone would pass before the client read anything; the fixture's
 * `grid-mounted` turns "yes" in an effect, after the snapshots are applied.
 */
async function reloadAppVersionFixture(page: Page): Promise<void> {
  await page.reload();
  await waitForShellHydration(page);
  await expect(byTestId(page, "grid-mounted")).toHaveText("yes");
}

/**
 * #994: location state is versioned by the app version. A document load keeps
 * the state its own version wrote and reads nothing another version wrote,
 * typed or plain, with a clean hydration.
 *
 * The fixture (both apps: `<url>?step=...`) has a typed reader (`grid-value`,
 * written by `grid-write`) and a plain-state reader (`plain-value`, written by
 * `plain-write`).
 */
export async function expectOtherVersionLocationStateDroppedOnLoad(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);

  await page.goto(url);
  await waitForShellHydration(page);

  for (const [write, readerId, value] of [
    ["grid-write", "grid-value", "desc:3"],
    ["plain-write", "plain-value", "panel"],
  ] as const) {
    const reader = byTestId(page, readerId);
    await byTestId(page, write).click();
    await expect(reader).toHaveText(value);
    // The running app recorded its version on the entry it wrote.
    const recorded = await page.evaluate(
      () => (window.history.state as { __rsc_lsv?: unknown }).__rsc_lsv,
    );
    expect(recorded).toEqual(expect.stringMatching(/./));

    await reloadAppVersionFixture(page);
    await expect(reader).toHaveText(value);

    for (const otherVersion of ["another-build", undefined]) {
      await recordEntryVersion(page, otherVersion);
      await reloadAppVersionFixture(page);
      await expect(reader).toHaveText("none");
    }
  }

  // A write under the running version is read again.
  await byTestId(page, "grid-write").click();
  await expect(byTestId(page, "grid-value")).toHaveText("desc:3");
}

/**
 * #994: the same rule without a document load. After a deploy and a reload the
 * session history still holds entries the older build wrote; back/forward
 * reaches them through popstate.
 *
 * `grid-step` is the server-rendered `?step`: once it names the entry, the
 * traversal is committed and the readers have handled its popstate.
 */
export async function expectOtherVersionLocationStateDroppedOnTraversal(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const grid = byTestId(page, "grid-value");
  const step = byTestId(page, "grid-step");
  const leaveAndComeBack = async (): Promise<void> => {
    await byTestId(page, "grid-next").click();
    await expect(step).toHaveText("next");
    await expect(grid).toHaveText("none");
    await page.goBack();
    await expect(step).toHaveText("typed");
  };

  await page.goto(url);
  await waitForShellHydration(page);
  await byTestId(page, "grid-write").click();
  await expect(grid).toHaveText("desc:3");
  await markDocument(page);

  // Its own version: back/forward applies the entry's state, as always.
  await leaveAndComeBack();
  await expect(grid).toHaveText("desc:3");

  await recordEntryVersion(page, "another-build");
  await leaveAndComeBack();
  expect(await isMarkedDocument(page)).toBe(true);
  await expect(grid).toHaveText("none");

  await byTestId(page, "grid-write").click();
  await expect(grid).toHaveText("desc:3");
}

/**
 * Back/forward scroll WITHOUT <Html.ScrollRestoration> (history.scrollRestoration
 * stays "auto"): the browser restores the entry's scroll itself, so the router
 * must not scroll on popstate. A router scrollTo(0, 0) there races the native
 * restore; desktop engines restore after it (final position still correct),
 * so the spy on the scroll APIs is what pins the contract.
 */
export async function expectBackLeavesScrollToBrowser(
  page: Page,
  options: {
    url: string;
    originTestId: string;
    linkTestId: string;
    destinationUrl: string;
    destinationTestId: string;
    waitForHydration: (page: Page) => Promise<void>;
  },
): Promise<void> {
  const originY = 1500;
  const scrollY = () => page.evaluate(() => window.scrollY);

  await page.addInitScript(() => {
    const calls: string[] = [];
    let armed = false;
    (window as any).__scrollCallsAfterPopstate = calls;
    addEventListener("popstate", () => {
      armed = true;
    });
    const spy = (target: any, name: string) => {
      const original = target[name];
      target[name] = function (this: unknown, ...args: unknown[]) {
        if (armed) calls.push(`${name}(${JSON.stringify(args)})`);
        return original.apply(this, args);
      };
    };
    spy(window, "scrollTo");
    spy(window, "scroll");
    spy(window, "scrollBy");
    spy(Element.prototype, "scrollIntoView");
  });
  await page.goto(options.url);
  await options.waitForHydration(page);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe("auto");
  // Tall origin so the saved position is not clamped by the viewport.
  await page.addStyleTag({
    content: `[data-testid="${options.originTestId}"] { padding-bottom: 4000px; }`,
  });
  await page.evaluate((y) => window.scrollTo(0, y), originY);
  await expect.poll(scrollY).toBe(originY);

  // A DOM click: a locator click would scroll the link into view first.
  await byTestId(page, options.linkTestId).evaluate((a: HTMLElement) =>
    a.click(),
  );
  await expect(byTestId(page, options.destinationTestId)).toBeVisible();
  await expect(page).toHaveURL(options.destinationUrl);

  await page.goBack();
  await expect(byTestId(page, options.originTestId)).toBeVisible();
  await expect.poll(scrollY).toBe(originY);
  expect(
    await page.evaluate(() => (window as any).__scrollCallsAfterPopstate),
  ).toEqual([]);
}

/**
 * The push-ownership fixture (both apps: issues #1001, #1003). Each route is
 * a `ppr` route with one `ssr: false` loader whose value and handle pushes
 * carry the generation of the run that produced them, per `?probe=`:
 *
 * - `pinnedUrl`: returns a nested promise (it runs on every replay of its
 *   shell), value `pinned@g<n>`, one settled push `pinned-note@g<n>`.
 * - `cappedUrl`: the same loader under `ppr.maxSnapshotBytes: 1`, so the
 *   stored entry keeps no loader pin.
 * - `deferredUrl`: promise-free, bound with its own `cache()`, value
 *   `deferred@g<n>`, a settled push `settled-note@g<n>` and a deferred one
 *   `deferred-note@g<n>`.
 * - `liveUrl`: a loader WITHOUT `ssr: false` under `loading()`, value
 *   `live@g<n>`, one push `live-note@g<n>` made after an await. The view
 *   reads the loader, so it renders inside the `loading()` boundary.
 * - `bumpUrl`: GET `<bumpUrl>?probe=` moves that probe's generation on and
 *   returns `{ generation }`.
 *
 * The view renders the loader value as `push-value` and one `push-note` row
 * per push of the fixture's handle.
 */
export interface PushOwnershipFixture {
  pinnedUrl: string;
  cappedUrl: string;
  deferredUrl: string;
  /** A route whose deferred loader push settles after ppr.captureTimeout. */
  slowUrl: string;
  liveUrl: string;
  bumpUrl: string;
  /** A page of the app outside the fixture, to navigate from. */
  homeUrl: string;
}

const PUSH_HTML_HEADERS = { Accept: "text/html" };

function pushProbe(kind: string): string {
  return `${kind}-${randomUUID().slice(0, 8)}`;
}

/** Request `url` as a document until its shell is captured and HITs. */
async function warmShellToHit(page: Page, url: string): Promise<void> {
  await expect(async () => {
    const res = await page.request.get(url, { headers: PUSH_HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20_000 });
}

async function bumpPushGeneration(
  page: Page,
  fixture: PushOwnershipFixture,
  probe: string,
): Promise<number> {
  const res = await page.request.get(`${fixture.bumpUrl}?probe=${probe}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { generation: number }).generation;
}

/** Load `url` as a document served from its shell, and wait for hydration. */
async function gotoShellHit(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  expect(response?.headers()["x-rango-shell"]).toBe("HIT");
  await waitForShellHydration(page);
}

/**
 * Navigate on the client from `homeUrl` to `url`, and wait for the partial
 * response to finish: every handle update of the navigation has arrived. The
 * navigation must have replayed the shell (`x-rango-ppr-replay: HIT`).
 */
async function replayShellByNavigation(
  page: Page,
  fixture: PushOwnershipFixture,
  url: string,
): Promise<void> {
  await page.goto(fixture.homeUrl);
  await waitForShellHydration(page);
  const target = new URL(url);
  const partial = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return (
      responseUrl.pathname === target.pathname &&
      responseUrl.searchParams.has("_rsc_partial")
    );
  });
  await routerNavigate(page, url);
  const response = await partial;
  expect(response.headers()["x-rango-ppr-replay"]).toBe("HIT; freshness=fresh");
  await response.finished();
}

/** The generation a fixture value was produced at (`<kind>@g<n>`). */
async function pushValueGeneration(page: Page, kind: string): Promise<number> {
  const value = byTestId(page, "push-value");
  await expect(value).toHaveText(new RegExp(`^${kind}@g\\d+$`));
  return Number((await value.textContent())!.split("@g")[1]);
}

/**
 * #1003: a client navigation that replays a shell keeps the captured handle
 * push of a promise-carrying `ssr: false` loader next to its pinned data, as
 * the document HIT of the same shell does. Before, the navigation showed the
 * capture's data next to the push of the run it made.
 */
export async function expectReplayKeepsCapturedPushWithPinnedData(
  page: Page,
  fixture: PushOwnershipFixture,
): Promise<void> {
  // The pin and the record agree, so the document hydrates clean.
  using _ = guardHydrationErrors(page);
  const probe = pushProbe("pinned");
  const url = `${fixture.pinnedUrl}?probe=${probe}`;
  await warmShellToHit(page, url);
  // The loader runs on every replay from here on, at a later generation.
  const current = await bumpPushGeneration(page, fixture, probe);
  const notes = byTestId(page, "push-note");

  await gotoShellHit(page, url);
  const captured = await pushValueGeneration(page, "pinned");
  expect(captured).toBeLessThan(current);
  await expect(notes).toHaveText([`pinned-note@g${captured}`]);

  await replayShellByNavigation(page, fixture, url);
  await expect(byTestId(page, "push-value")).toHaveText(`pinned@g${captured}`);
  await expect(notes).toHaveText([`pinned-note@g${captured}`]);
}

/**
 * #1001: a client navigation that replays a shell delivers the deferred
 * handle push of an `ssr: false` loader with its own `cache()`, from that
 * loader's cache entry, next to the settled push the shell recorded, each
 * once. Before, the navigation dropped the deferred push.
 *
 * The document HIT it starts from hydrates clean (#1035,
 * expectShellHitHydratesFromRecord): the shell has no row for the deferred
 * push, which arrives after hydration.
 */
export async function expectReplayDeliversDeferredPush(
  page: Page,
  fixture: PushOwnershipFixture,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const probe = pushProbe("deferred");
  const url = `${fixture.deferredUrl}?probe=${probe}`;
  await warmShellToHit(page, url);
  // The loader's cache() entry, not a run at this generation, supplies both.
  const current = await bumpPushGeneration(page, fixture, probe);
  const notes = byTestId(page, "push-note");

  await gotoShellHit(page, url);
  const captured = await pushValueGeneration(page, "deferred");
  expect(captured).toBeLessThan(current);
  const expected = [`settled-note@g${captured}`, `deferred-note@g${captured}`];
  await expect(notes).toHaveText(expected);

  await replayShellByNavigation(page, fixture, url);
  await expect(byTestId(page, "push-value")).toHaveText(
    `deferred@g${captured}`,
  );
  await expect(notes).toHaveText(expected);
}

/** The text of each `push-note` row in a document's HTML, before any script runs. */
function pushNoteRowsInHtml(html: string): string[] {
  return [
    ...html.matchAll(/<li data-testid="push-note"[^>]*>([^<]*)<\/li>/g),
  ].map((match) => match[1]!);
}

/**
 * #1035: a document served from a shell hydrates with the handle data the
 * shell's HTML was rendered from. The shell's record keeps the settled push
 * of `deferredUrl`'s loader and leaves its deferred one out, so the HIT's
 * HTML has one row, the page hydrates without a hydration error, and the
 * deferred row shows after hydration (the late channel).
 *
 * Before, the shell had a second, empty row (the capture rendered a slot for
 * the push it did not record), and the HIT's hydration data carried the
 * deferred value or not depending on a race: React error #418 in
 * production, "Hydration failed" in dev, on every HIT.
 */
export async function expectShellHitHydratesFromRecord(
  page: Page,
  fixture: PushOwnershipFixture,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const probe = pushProbe("hit-handles");
  const url = `${fixture.deferredUrl}?probe=${probe}`;
  await warmShellToHit(page, url);

  const hit = await page.request.get(url, { headers: PUSH_HTML_HEADERS });
  expect(hit.headers()["x-rango-shell"]).toBe("HIT");
  expect(pushNoteRowsInHtml(await hit.text())).toEqual(["settled-note@g1"]);

  await gotoShellHit(page, url);
  await expect(byTestId(page, "push-note")).toHaveText([
    "settled-note@g1",
    "deferred-note@g1",
  ]);
}

/**
 * A deferred push by an `ssr: false` loader that settles after
 * `ppr.captureTimeout` does not stop the capture: the shell's record leaves
 * the push out, so the shell is captured (a later document request is a HIT)
 * with the settled row only, hydrates clean, and the HIT's own loader run
 * delivers the deferred row after hydration. Before, the capture waited for
 * the push, ran out of budget and never produced a shell.
 */
export async function expectSlowDeferredPushDoesNotBlockCapture(
  page: Page,
  fixture: PushOwnershipFixture,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const probe = pushProbe("slow-push");
  const url = `${fixture.slowUrl}?probe=${probe}`;
  await warmShellToHit(page, url);

  const hit = await page.request.get(url, { headers: PUSH_HTML_HEADERS });
  expect(hit.headers()["x-rango-shell"]).toBe("HIT");
  expect(pushNoteRowsInHtml(await hit.text())).toEqual(["settled-note@g1"]);

  await gotoShellHit(page, url);
  await expect(byTestId(page, "push-note")).toHaveText([
    "settled-note@g1",
    "deferred-note@g1",
  ]);
}

/** The `push-note` rows on screen, and whether the root had hydrated. */
interface PushNoteSample {
  hydrated: boolean;
  rows: string[];
}

/**
 * Record the `push-note` rows and the root's hydrated marker every time
 * either changes, from the first parsed HTML on. Call it before the
 * navigation; the returned reader gives the current document's samples.
 */
async function recordPushNoteRows(
  page: Page,
): Promise<() => Promise<PushNoteSample[]>> {
  await page.addInitScript(() => {
    const samples: { hydrated: boolean; rows: (string | null)[] }[] = [];
    (window as any).__pushNoteSamples = samples;
    let last = "";
    const sample = () => {
      const rows = [
        ...document.querySelectorAll('[data-testid="push-note"]'),
      ].map((row) => row.textContent);
      const hydrated =
        document.documentElement?.hasAttribute("data-hydrated") ?? false;
      const key = JSON.stringify([hydrated, rows]);
      if (key === last) return;
      last = key;
      samples.push({ hydrated, rows });
    };
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-hydrated"],
    });
  });
  return () => page.evaluate(() => (window as any).__pushNoteSamples);
}

/**
 * A document HIT of a shell entry that kept no loader pin
 * (`ppr.maxSnapshotBytes`): the `ssr: false` loader runs on the HIT, so the
 * page shows that run's data and that run's push. Before, it showed the
 * run's data next to the push the shell recorded at capture.
 *
 * The prelude was rendered from the capture's value, so the browser repairs
 * the loader DATA on hydration (the documented drift of an entry without
 * pins), and this installs no hydration-error guard. The handle rows are
 * not part of that drift (#1035): the page hydrates with the capture's push,
 * as the HTML has it, and the run's push takes its place after hydration.
 * Before, the hydration data already held the run's push.
 */
export async function expectPinlessHitKeepsRunPushWithRunData(
  page: Page,
  fixture: PushOwnershipFixture,
): Promise<void> {
  const probe = pushProbe("capped");
  const url = `${fixture.cappedUrl}?probe=${probe}`;
  await warmShellToHit(page, url);
  const current = await bumpPushGeneration(page, fixture, probe);
  const samples = await recordPushNoteRows(page);

  await gotoShellHit(page, url);
  await expect(byTestId(page, "push-value")).toHaveText(`pinned@g${current}`);
  await expect(byTestId(page, "push-note")).toHaveText([
    `pinned-note@g${current}`,
  ]);
  // The rows on screen when the root hydrated: still the shell's.
  expect((await samples()).find((sample) => sample.hydrated)?.rows).toEqual([
    `pinned-note@g${current - 1}`,
  ]);
}

/**
 * #1035: a `useHandle` reader hydrates with the handle data its HTML was
 * rendered from, whenever its boundary hydrates. `liveUrl`'s view sits
 * inside the `loading()` boundary of a live loader that pushes after an
 * await. That boundary hydrates after the root, and by then the push has
 * reached the client (the late channel is released when the root hydrates),
 * while the boundary's HTML was rendered without it.
 *
 * Before, the reader initialized from the live handle state and rendered a
 * row its HTML did not have: "Hydration failed" in dev, React error #418 in
 * production, on a document rendered without a shell and on a shell HIT.
 */
export async function expectLateBoundaryHandleReaderHydratesClean(
  page: Page,
  fixture: PushOwnershipFixture,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const probe = pushProbe("live");
  const url = `${fixture.liveUrl}?probe=${probe}`;
  const expectLivePage = async (): Promise<void> => {
    await waitForShellHydration(page);
    await expect(byTestId(page, "push-value")).toHaveText("live@g1");
    // The row shows once the boundary has hydrated and moved on to the
    // live handle state.
    await expect(byTestId(page, "push-note")).toHaveText(["live-note@g1"]);
  };

  // The first request of the probe: rendered without a shell.
  const miss = await page.goto(url);
  expect(miss?.headers()["x-rango-shell"]).toBe("MISS");
  await expectLivePage();

  await warmShellToHit(page, url);
  await gotoShellHit(page, url);
  await expectLivePage();
}

// ---------------------------------------------------------------------------
// #1047: a traversal the server answers with a redirect
// ---------------------------------------------------------------------------

/**
 * A page whose route middleware redirects unless a cookie is set, and the
 * public pages around it: `beforeUrl` is the entry before the protected one,
 * `fillerUrl(n)` the pushes that evict the protected entry (the location-state
 * panel fixture, whose step names the page on screen), `targetUrl` where the
 * middleware redirects to.
 */
export interface PopstateRedirectFixture {
  protectedUrl: string;
  targetUrl: string;
  beforeUrl: string;
  fillerUrl: (n: number) => string;
  cookie: { name: string; value: string };
  protectedTestId: string;
  targetTestId: string;
}

/** Console errors that mean the router rendered a redirect as a failure. */
function collectRedirectFailures(page: Page): string[] {
  const failures: string[] = [];
  const matches = (text: string) =>
    text.includes("Unprocessable popstate response") ||
    text.includes("[RootErrorBoundary]");
  page.on("console", (msg: ConsoleMessage) => {
    if (matches(msg.text())) failures.push(msg.text());
  });
  page.on("pageerror", (err: Error) => {
    if (matches(err.message)) failures.push(err.message);
  });
  return failures;
}

/**
 * #1047: back to a history entry that has to be fetched, where the server
 * now answers with a redirect. The redirect is followed and REPLACES the
 * entry: Back from the target lands on the entry before the protected page
 * (a push would leave the redirecting entry in history and Back would hit it
 * again). Used to render the root error boundary and leave the address bar on
 * the protected URL.
 */
export async function expectRefetchedBackFollowsRedirectByReplacing(
  page: Page,
  fixture: PopstateRedirectFixture,
): Promise<void> {
  await page
    .context()
    .addCookies([{ ...fixture.cookie, url: fixture.protectedUrl }]);
  await page.goto(fixture.beforeUrl);
  await waitForShellHydration(page);
  await routerNavigate(page, fixture.protectedUrl);
  await expect(byTestId(page, fixture.protectedTestId)).toBeVisible();

  await pushEvictingEntries(page, fixture.fillerUrl);
  // The last push has committed, so the history cache is settled.
  await expect(byTestId(page, "grid-step")).toHaveText(
    `filler-${EVICTING_ENTRIES}`,
  );
  await expect(byTestId(page, "ls-shared-nav")).toHaveText(/^idle\|/);
  await page.context().clearCookies({ name: fixture.cookie.name });

  const failures = collectRedirectFailures(page);
  await goBackToEvictedEntry(page);

  await expect(page).toHaveURL(fixture.targetUrl);
  await expect(byTestId(page, fixture.targetTestId)).toBeVisible();
  await expect(byTestId(page, fixture.protectedTestId)).toHaveCount(0);

  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(fixture.beforeUrl);
  await expect(byTestId(page, fixture.targetTestId)).toBeVisible();
  expect(failures).toEqual([]);
}

/** The control of the body above: a link click to the same page follows the redirect. */
export async function expectLinkClickToRedirectingPageFollowsRedirect(
  page: Page,
  fixture: PopstateRedirectFixture,
): Promise<void> {
  const failures = collectRedirectFailures(page);
  await page.goto(fixture.beforeUrl);
  await waitForShellHydration(page);
  await page.evaluate((href) => {
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, fixture.protectedUrl);

  await expect(page).toHaveURL(fixture.targetUrl);
  await expect(byTestId(page, fixture.targetTestId)).toBeVisible();
  expect(failures).toEqual([]);
}
