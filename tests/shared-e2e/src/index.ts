import { expect, type ConsoleMessage, type Page } from "@playwright/test";
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
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });
  await page.getByTestId(linkTestId).first().click();
  await page.waitForURL((url) => url.pathname === pathname);
  expect(
    await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload,
    ),
    "client navigation kept the document (no reload)",
  ).toBe(true);
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
  const content = contentTestIds.map((id) =>
    page.locator(`[data-testid="${id}"]`),
  );

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
  const byTestId = (id: string) => page.locator(`[data-testid="${id}"]`);
  const gateUrl = `${url}/${randomUUID()}`;
  const loadHeld = async (load: () => Promise<unknown>): Promise<void> => {
    await load();
    await waitForShellHydration(page);
    await expect(byTestId("late-ls-fallback")).toBeVisible();
    expect((await page.request.get(`${gateUrl}/release`)).ok()).toBe(true);
  };

  await loadHeld(() => page.goto(gateUrl, { waitUntil: "commit" }));
  await expect(byTestId("late-ls-value")).toHaveText("empty");
  await byTestId("late-ls-write").click();

  await loadHeld(() => page.reload({ waitUntil: "commit" }));
  await expect(byTestId("late-ls-value")).toHaveText("stored-value");
}

/** The typed location-state slots (`__rsc_ls_*`) of the current entry. */
async function locationStateSlots(page: Page): Promise<unknown[]> {
  return page.evaluate(() =>
    Object.entries((window.history.state ?? {}) as Record<string, unknown>)
      .filter(([key]) => key.startsWith("__rsc_ls_"))
      .map(([, slot]) => slot),
  );
}

const loadMoreItems = (pageNumber: number): string[] =>
  [1, 2, 3].map((item) => `p${pageNumber}-${item}`);

/**
 * #994 `createLocationState({ clearOnReload: true })` on a "load more" page.
 *
 * The fixture (both apps: `<url>?page=N`) renders page N's three items on the
 * server. Its `lm-more` Link goes to page N+1 carrying every item on screen
 * as a `clearOnReload` slot, plus a slot without options (`lm-sort`). The
 * route's handler also sets a `clearOnReload` slot of its own on every
 * request (`lm-server-page`), document loads included.
 *
 * The server HTML never contains carried items, so "not shown after a
 * reload" would pass before the client applied anything. Each document load
 * therefore waits for `lm-sort`, which comes from `history.state` too: once
 * it shows, the client snapshots are in.
 */
export async function expectClearOnReloadDropsCarriedState(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const byTestId = (id: string) => page.locator(`[data-testid="${id}"]`);
  const items = byTestId("lm-items").locator("li");
  const carried = byTestId("lm-carried-count");
  const serverPage = byTestId("lm-server-page");

  // A document response carries no location state: what the handler set for
  // this load does not reach history.state, so start-up has nothing of the
  // server's to drop.
  await page.goto(`${url}?page=1`);
  await waitForShellHydration(page);
  await expect(items).toHaveText(loadMoreItems(1));
  await expect(carried).toHaveText("0");
  await expect(serverPage).toHaveText("none");
  expect(await locationStateSlots(page)).toEqual([]);

  // A client navigation shows the carried items above the new page's, and
  // delivers the state the handler set for it.
  await byTestId("lm-more").click();
  await expect(page).toHaveURL(`${url}?page=2`);
  await expect(items).toHaveText([...loadMoreItems(1), ...loadMoreItems(2)]);
  await expect(carried).toHaveText("3");
  await expect(serverPage).toHaveText("2");
  const stored = await locationStateSlots(page);
  expect(stored).toHaveLength(3);
  expect(stored).toContainEqual({
    __rsc_ls_env: 1,
    clearOnReload: true,
    value: loadMoreItems(1),
  });
  expect(stored).toContainEqual({
    __rsc_ls_env: 1,
    clearOnReload: true,
    value: { page: 2 },
  });
  expect(stored).toContainEqual({ order: "asc" });

  // A document load of the entry: only what the server rendered, and both
  // marked slots are gone from history.state. The slot without options
  // survives.
  await page.reload();
  await waitForShellHydration(page);
  await expect(byTestId("lm-sort")).toHaveText("asc");
  await expect(carried).toHaveText("0");
  await expect(serverPage).toHaveText("none");
  await expect(items).toHaveText(loadMoreItems(2));
  expect(await locationStateSlots(page)).toEqual([{ order: "asc" }]);

  // The next client navigation carries state again, the server's included.
  await byTestId("lm-more").click();
  await expect(page).toHaveURL(`${url}?page=3`);
  await expect(items).toHaveText([...loadMoreItems(2), ...loadMoreItems(3)]);
  await expect(carried).toHaveText("3");
  await expect(serverPage).toHaveText("3");

  // Back inside the running app: the cleared entry is not resurrected.
  await page.goBack();
  await expect(page).toHaveURL(`${url}?page=2`);
  await expect(byTestId("lm-page")).toHaveText("2");
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
 * instead of a reload (same fixture as expectClearOnReloadDropsCarriedState).
 * The window marker proves the return was a new document, not a back/forward
 * cache restore, which keeps its state and is not this case.
 */
export async function expectClearOnReloadDropsStateOnTraversalLoad(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const byTestId = (id: string) => page.locator(`[data-testid="${id}"]`);
  const carried = byTestId("lm-carried-count");

  await page.goto(`${url}?page=1`);
  await waitForShellHydration(page);
  await byTestId("lm-more").click();
  await expect(page).toHaveURL(`${url}?page=2`);
  await expect(carried).toHaveText("3");
  await page.evaluate(() => {
    (window as { __lsLeftDocument?: boolean }).__lsLeftDocument = true;
  });

  await page.goto(`${url}?page=9`);
  await waitForShellHydration(page);
  await page.goBack();
  await expect(page).toHaveURL(`${url}?page=2`);
  await waitForShellHydration(page);
  expect(await page.evaluate(() => "__lsLeftDocument" in window)).toBe(false);

  await expect(byTestId("lm-sort")).toHaveText("asc");
  await expect(carried).toHaveText("0");
  await expect(byTestId("lm-server-page")).toHaveText("none");
  await expect(byTestId("lm-items").locator("li")).toHaveText(loadMoreItems(2));
  expect(await locationStateSlots(page)).toEqual([{ order: "asc" }]);
}

/**
 * #994 `version` and `validate`: a slot another deploy stored is read as no
 * state after a reload.
 *
 * The fixture (both apps) has a `version: 2` reader (`vg-value`), a
 * `validate` reader (`val-value`), each definition's slot key (`vg-key`,
 * `val-key`), and a `grid-write` Link that writes both plus a slot without
 * options (`grid-control`). "Another deploy wrote this" is modelled by
 * rewriting the slot under the same key in `history.state`: the key is the
 * file path and export name, so it is what a previous build of the same
 * definition wrote to. `grid-control` gates each reload for the reason given
 * on expectClearOnReloadDropsCarriedState.
 */
export async function expectStaleLocationStateReadsAsNone(
  page: Page,
  url: string,
): Promise<void> {
  using _ = guardHydrationErrors(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const byTestId = (id: string) => page.locator(`[data-testid="${id}"]`);
  const versioned = byTestId("vg-value");
  const validated = byTestId("val-value");
  const reload = async (): Promise<void> => {
    await page.reload();
    await waitForShellHydration(page);
    await expect(byTestId("grid-control")).toHaveText("control");
  };
  const storeSlot = (key: string, slot: unknown): Promise<void> =>
    page.evaluate(
      ([slotKey, value]) =>
        window.history.replaceState(
          { ...window.history.state, [slotKey as string]: value },
          "",
        ),
      [key, slot] as const,
    );

  await page.goto(url);
  await waitForShellHydration(page);
  await expect(versioned).toHaveText("none");
  await expect(validated).toHaveText("none");

  await byTestId("grid-write").click();
  await expect(page).toHaveURL(`${url}?written=1`);
  await expect(versioned).toHaveText("desc:3");
  await expect(validated).toHaveText("desc:3");

  const versionedKey = (await byTestId("vg-key").textContent())!;
  const validatedKey = (await byTestId("val-key").textContent())!;
  const grid = { order: "desc", page: 3 };
  const state = (await page.evaluate(() => window.history.state)) as Record<
    string,
    unknown
  >;
  expect(state[versionedKey]).toEqual({ __rsc_ls_env: 1, v: 2, value: grid });
  // validate alone does not change what is stored.
  expect(state[validatedKey]).toEqual(grid);

  // The deploy that wrote them reads them again after a reload.
  await reload();
  await expect(versioned).toHaveText("desc:3");
  await expect(validated).toHaveText("desc:3");

  const staleVersioned: Array<[label: string, slot: unknown]> = [
    [
      "version 1 of the definition",
      { __rsc_ls_env: 1, v: 1, value: { sort: "desc", page: 3 } },
    ],
    ["a value stored before the definition had a version", grid],
    ["a raw value that is shaped { v, value }", { v: 2, value: grid }],
  ];
  for (const [label, slot] of staleVersioned) {
    await storeSlot(versionedKey, slot);
    await reload();
    await expect(versioned, label).toHaveText("none");
    await expect(validated).toHaveText("desc:3");
  }

  const staleValidated: Array<[label: string, slot: unknown]> = [
    ["a value validate rejects", { sort: "desc", page: 3 }],
    ["a value validate throws on", null],
    [
      "a slot a versioned definition wrote",
      { __rsc_ls_env: 1, v: 2, value: grid },
    ],
  ];
  for (const [label, slot] of staleValidated) {
    await storeSlot(validatedKey, slot);
    await reload();
    await expect(validated, label).toHaveText("none");
  }

  // The next write replaces both stale slots.
  await byTestId("grid-write").click();
  await expect(versioned).toHaveText("desc:3");
  await expect(validated).toHaveText("desc:3");
  expect(pageErrors).toEqual([]);
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
  const byTestId = (id: string) => page.locator(`[data-testid="${id}"]`);
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
  await byTestId(options.linkTestId).evaluate((a: HTMLElement) => a.click());
  await expect(byTestId(options.destinationTestId)).toBeVisible();
  await expect(page).toHaveURL(options.destinationUrl);

  await page.goBack();
  await expect(byTestId(options.originTestId)).toBeVisible();
  await expect.poll(scrollY).toBe(originY);
  expect(
    await page.evaluate(() => (window as any).__scrollCallsAfterPopstate),
  ).toEqual([]);
}
