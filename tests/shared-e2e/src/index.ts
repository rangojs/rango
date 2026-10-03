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
 * Write a file atomically and wait until the resulting HMR change has been
 * applied. Robust against CI filesystems that coalesce or drop watcher events:
 * each attempt replaces the file via temp-write + rename and forces a strictly
 * monotonic mtime so the watcher sees a fresh change, retrying until one of the
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
  const fillers = 21;
  for (let n = 1; n <= fillers; n++) {
    await routerNavigate(page, fillerUrl(n));
  }
  await page.evaluate((delta) => window.history.go(-delta), fillers);
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
 * entry a document load started).
 */
interface LoadMoreScreen {
  content: "list" | "panel" | "none";
  page: string | null;
  carried: string | null;
  sharedCarried: string | null;
  serverPage: string | null;
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
 * page on screen; over the other fixture's panel (an entry without carried
 * items) the layout's reader reads none.
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
          (sample.serverPage !== "none" &&
            sample.serverPage !== sample.page))) ||
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
