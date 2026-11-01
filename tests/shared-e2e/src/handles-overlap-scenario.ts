import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * A second click over a held transition() page (hook lock rows HD4 and
 * HD13, with HD2 one-click references). Fixture in each app:
 * /handles-overlap/:reader/:vt/:id (test-app urls/handles-overlap.tsx,
 * cloudflare-basic pages/handles-overlap.tsx), behind a 400 ms server delay.
 *
 * HD4: a crumb whose content is pending, read with use() in a <Suspense> that
 * is already revealed, never holds the page; only the crumb's boundary waits.
 * Whichever click's crumb is pending.
 *
 * Frames, judged on painted samples. Handle values are late by design (a
 * streamed push lands after its page), so the page being left's title or
 * crumb on the destination is allowed. Asserted: no frame shows the
 * destination's or the first click's title or crumb before the destination
 * shows (early), and the destination never shows another pathname (multi
 * reader) or a value of no page in the test. Counted, not asserted: frames of
 * the destination with the first click's title or crumb, a page that never
 * shows, as a `frames` annotation with the late count.
 *
 * useSegments: the multi reader also reads it. Segment ids and location
 * cannot suspend, so it commits with its page, unlike a handle value.
 * Asserted: its segments match its pathname in every sampled frame and in
 * every effect (the fixture logs each committed pair to window.__hoEffects).
 *
 * How the probe sees frames (init script, window.__ho):
 * - A requestAnimationFrame loop samples the DOM at the start of every
 *   rendering step that runs animation frame callbacks. Paint follows in the
 *   same step with nothing in between but other rAF callbacks, so a sampled
 *   state is a painted state. A state that lives and dies between two steps
 *   (two commits in one task, or two tasks with no rendering step between)
 *   is never sampled and never painted. The assertions read these samples.
 * - A MutationObserver logs every DOM state (one entry per mutation batch),
 *   painted or not. It is the failure diagnostic, not asserted.
 * - document.startViewTransition is wrapped: the DOM when the update callback
 *   returns and when `ready` resolves (React's mutation is in; the new state
 *   is captured; React's spawned work, a layout effect's sync update
 *   included, runs right after in the same microtask checkpoint). Rendering is
 *   paused from the update callback until the capture, so the rAF loop skips
 *   that step. The capture state is annotated, not asserted; Chrome traces
 *   (HANDLES_OVERLAP_TRACE_DIR) show whether a Paint ran on it.
 * - It cannot see the compositor: a frame drawn from an earlier paint, a
 *   tab-strip title (document.title is read from the DOM), or what a view
 *   transition's old snapshot shows.
 */

export interface HandlesOverlapScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

interface Shown {
  title: string;
  page: string | null;
  crumb: string | null;
  content: string | null;
  path: string | null;
  segments: string | null;
}

interface Logged extends Shown {
  t: number;
  f: number;
}

interface VtEntry {
  f: number;
  updated?: Shown;
  ready?: Shown;
  readyF?: number;
  doneF?: number;
}

interface Probe {
  dom: Logged[];
  frames: Logged[];
  vt: VtEntry[];
  clicks: { t: number; f: number }[];
  frame: number;
}

interface Pair {
  path: string | null;
  segments: string | null;
}

type ProbeWindow = { __ho?: Probe; __hoEffects?: Pair[] };

async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: Probe = { dom: [], frames: [], vt: [], clicks: [], frame: 0 };
    (window as unknown as ProbeWindow).__ho = probe;
    const visible = (el: Element | null | undefined): el is Element =>
      !!el && !el.closest('[style*="display: none"]');
    const one = (id: string): Element | null =>
      document.querySelector(`[data-testid="${id}"]`);
    const snap = (): Shown => {
      const content = [
        ...document.querySelectorAll('[data-testid="ho-crumb-content"]'),
      ].find(visible);
      return {
        title: document.title,
        page:
          one("ho-page")?.textContent ??
          (one("ho-loading") ? "skeleton" : null),
        crumb: one("ho-crumb")?.textContent ?? null,
        content: visible(one("ho-crumb-fallback"))
          ? "loading"
          : (content?.textContent ?? null),
        path: one("ho-trail")?.getAttribute("data-path") ?? null,
        segments: one("ho-trail")?.getAttribute("data-segments") ?? null,
      };
    };
    const key = (s: Shown): string =>
      [s.title, s.page, s.crumb, s.content, s.path, s.segments].join("|");
    const push = (log: Logged[], kind: string, t: number): void => {
      const s = snap();
      const last = log[log.length - 1];
      if (last && key(last) === key(s)) return;
      log.push({ ...s, t, f: probe.frame });
      // Markers for a Chrome trace (HANDLES_OVERLAP_TRACE_DIR).
      console.timeStamp(`ho-${kind} ${key(s)}`);
    };
    new MutationObserver(() =>
      push(probe.dom, "dom", performance.now()),
    ).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "data-path", "data-segments"],
    });
    const tick = (ts: number): void => {
      probe.frame++;
      push(probe.frames, "raf", ts);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener(
      "click",
      () => probe.clicks.push({ t: performance.now(), f: probe.frame }),
      true,
    );
    const start = document.startViewTransition?.bind(document);
    if (!start) return;
    document.startViewTransition = ((arg: unknown) => {
      const entry: VtEntry = { f: probe.frame };
      probe.vt.push(entry);
      const options = (typeof arg === "function" ? { update: arg } : arg) as
        | { update?: () => unknown }
        | undefined;
      const update = options?.update;
      const transition = start(
        (update
          ? {
              ...options,
              update: () => {
                const result = update();
                entry.updated = snap();
                return result;
              },
            }
          : options) as never,
      );
      transition.updateCallbackDone.then(
        () => (entry.doneF = probe.frame),
        () => {},
      );
      // Registered before React's own `ready` reaction, so it reads the DOM
      // the new state was captured from.
      transition.ready.then(
        () => {
          entry.ready = snap();
          entry.readyF = probe.frame;
          console.timeStamp(`ho-ready ${key(entry.ready)}`);
        },
        () => {},
      );
      return transition;
    }) as typeof document.startViewTransition;
  });
}

async function readProbe(page: Page): Promise<Probe & { effects: Pair[] }> {
  return page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    return { ...w.__ho!, effects: w.__hoEffects ?? [] };
  });
}

// The URL path useSegments reports for a pathname.
const segmentsOf = (path: string | null): string | null =>
  path === null ? null : path.split("/").filter(Boolean).join("/");

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const NAV_TIMEOUT = 10000;
// The first click's crumb content resolves 6 s after its request; the second
// page's response arrives 0.4 s after its click.
const UNHELD_TIMEOUT = 2500;

interface Case {
  title: string;
  first: "held" | "held-pending" | null;
  second: "fast" | "fast-pending" | "held";
}

const CASES: Case[] = [
  {
    title: "a second click whose crumb content is pending shows its page",
    first: "held",
    second: "fast-pending",
  },
  {
    title: "the first click's pending crumb content holds neither page",
    first: "held-pending",
    second: "fast",
  },
  {
    title: "a second click over a held page",
    first: "held",
    second: "fast",
  },
  { title: "one click to a held page", first: null, second: "held" },
  {
    title: "one click to a page that renders at once",
    first: null,
    second: "fast",
  },
];

export function runHandlesOverlapTests(
  options: HandlesOverlapScenarioOptions,
): void {
  const pathname = (path: string): string =>
    new URL(options.url(path)).pathname;

  for (const reader of ["multi", "full", "select"] as const) {
    for (const vt of ["vt", "novt"] as const) {
      const base = `/handles-overlap/${reader}/${vt}`;
      const label = vt === "vt" ? "view transition" : "no view transition";

      for (const { title, first, second } of CASES) {
        test(`${reader} reader, ${label}: ${title}`, async ({
          page,
          browser,
        }) => {
          await installProbe(page);
          await page.goto(options.url(`${base}/1`));
          await options.waitForHydration(page);
          await expect(testId(page, "ho-crumb-content")).toHaveText("c 1", {
            timeout: NAV_TIMEOUT,
          });

          const traceDir = process.env.HANDLES_OVERLAP_TRACE_DIR;
          if (traceDir) {
            await browser.startTracing(page, {
              screenshots: true,
              categories: [
                "devtools.timeline",
                "disabled-by-default-devtools.timeline",
                "disabled-by-default-devtools.screenshot",
              ],
            });
          }

          if (first) {
            // The held page's response starts at once (loading()): its
            // handles stream ahead of the page and wait for it.
            const target = pathname(`${base}/${first}`);
            const started = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === target && url.searchParams.has("_rsc_partial")
              );
            });
            await testId(page, `ho-link-${first}`).click();
            await started;
            await page.waitForTimeout(250);
            await expect(testId(page, "ho-page")).toHaveText("1");
          }

          await testId(page, `ho-link-${second}`).click();
          // HD4 assertions are soft: a failing run still judges and counts
          // its frames.
          if (first === "held-pending") {
            await expect
              .soft(testId(page, "ho-page"))
              .toHaveText(second, { timeout: UNHELD_TIMEOUT });
          }
          await expect(testId(page, "ho-page")).toHaveText(second, {
            timeout: NAV_TIMEOUT,
          });
          if (second === "fast-pending") {
            await expect(testId(page, "ho-crumb-content")).toHaveText(
              `c ${second}`,
              { timeout: NAV_TIMEOUT },
            );
          }
          await expect(page).toHaveTitle(`HO ${second}`);
          await expect(testId(page, "ho-crumb")).toHaveText(second);
          // The view transition and the streams end.
          await page.waitForTimeout(600);

          if (traceDir) {
            writeFileSync(
              `${traceDir}/${reader}-${vt}-${first ?? "none"}-${second}.json`,
              await browser.stopTracing(),
            );
          }

          const probe = await readProbe(page);
          const from = probe.clicks[0]!;
          const dom = probe.dom.filter((s) => s.t >= from.t);
          const trace = JSON.stringify(
            {
              frames: probe.frames.filter((s) => s.f >= from.f),
              dom,
              vt: probe.vt.filter((v) => v.f >= from.f),
            },
            null,
            1,
          );

          if (second === "fast-pending") {
            // HD4: the page commits before its crumb's content resolves.
            const shown = dom.find((s) => s.page === second);
            expect.soft(shown?.content, trace).not.toBe(`c ${second}`);
          }

          const destPath = pathname(`${base}/${second}`);
          // A destination value: its own, the page being left's (late), or
          // the first click's (a page that never shows).
          const kind = (
            value: string | null,
            own: string,
            left: string,
            neverShown: string | null,
          ) =>
            value === own
              ? "own"
              : value === left
                ? "late"
                : neverShown !== null && value === neverShown
                  ? "never-shown"
                  : "wrong";
          const judge = (s: Shown): "ok" | "late" | "never-shown" | "wrong" => {
            if (s.page !== second) {
              const early =
                s.crumb === second ||
                s.title === `HO ${second}` ||
                (first !== null &&
                  (s.crumb === first || s.title === `HO ${first}`));
              return early ? "wrong" : "ok";
            }
            if (reader === "multi" && s.path !== destPath) return "wrong";
            const kinds = [
              kind(s.crumb, second, "1", first),
              kind(s.title, `HO ${second}`, "HO 1", first && `HO ${first}`),
            ];
            if (kinds.includes("wrong")) return "wrong";
            if (kinds.includes("never-shown")) return "never-shown";
            return kinds.includes("late") ? "late" : "ok";
          };
          const after = probe.frames.filter((s) => s.f >= from.f);
          const count = (verdict: string) =>
            after.filter((s) => judge(s) === verdict).length;
          test.info().annotations.push({
            type: "frames",
            description: JSON.stringify({
              late: count("late"),
              neverShown: count("never-shown"),
            }),
          });
          expect(
            after.filter((s) => judge(s) === "wrong"),
            trace,
          ).toEqual([]);

          for (const v of probe.vt.filter((v) => v.f >= from.f)) {
            if (v.ready && judge(v.ready) !== "ok") {
              test.info().annotations.push({
                type: "view-transition capture",
                description: `${judge(v.ready)} ${JSON.stringify(v.ready)}; frames ${v.doneF}->${v.readyF}`,
              });
            }
          }

          if (reader === "multi") {
            expect(
              probe.frames.filter((s) => s.segments !== segmentsOf(s.path)),
              trace,
            ).toEqual([]);
            expect(
              probe.effects.filter((e) => e.segments !== segmentsOf(e.path)),
              JSON.stringify(probe.effects),
            ).toEqual([]);
            expect(probe.effects[probe.effects.length - 1]).toEqual({
              path: destPath,
              segments: segmentsOf(destPath),
            });
          }
        });
      }
    }
  }
}
