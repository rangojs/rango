import { type ConsoleMessage, type Page } from "@playwright/test";
import { utimesSync, writeFileSync } from "node:fs";

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
