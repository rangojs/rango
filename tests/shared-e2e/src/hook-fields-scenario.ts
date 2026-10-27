import { expect, test, type Page } from "@playwright/test";

/**
 * useNavigation()'s fields read the same in every reader shape while React
 * holds a page (rango-t219).
 *
 * Fixture in each app: /hook-fields/:id, a transition() route behind a
 * 400 ms server delay. Each render of the page brings a new stamp that holds
 * its commit on the client for 900 ms (HookFieldsHold, which counts pending
 * holds on <html data-hook-fields-holding>), and a server tail that keeps the
 * response open: 300 ms on pages 1 to 3, so the stream ends while React
 * holds the page, and 1800 ms on page 4, in a boundary of its own, so it
 * outlives the page's commit (isStreaming true over the new page). The layout's HookFieldsChrome reads
 * the hook in every shape: one selector per field (isStreaming in
 * hook-fields-bar, pendingUrl in hook-fields-pending, state, isNavigating,
 * location), the full state (hook-fields-status), and a link's
 * useLinkStatus() beside a selector for isStreaming
 * (hook-fields-link-chrome). Its invalidate button marks the history cache
 * stale, so Back restores the cached page and revalidates it.
 *
 * A recorder samples every reader on each animation frame and after each
 * DOM mutation.
 */

export interface HookFieldsScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
}

/** One recorded screen: an animation frame, or the DOM after a mutation. */
type Sample = {
  kind: "frame" | "mutation";
  id: string;
  stamp: string;
  holding: string;
  bar: string;
  pending: string;
  selState: string;
  selNavigating: string;
  selLocation: string;
  state: string;
  navigating: string;
  streaming: string;
  statusPending: string;
  location: string;
  linkPending: string;
  linkStreaming: string;
};
type ProbeWindow = { __hookFieldsSamples?: Sample[] };

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const VARIANTS = [
  { name: "with a view transition", vt: true },
  { name: "where view transitions are unsupported", vt: false },
] as const;

async function open(
  page: Page,
  options: HookFieldsScenarioOptions,
  vt: boolean,
): Promise<void> {
  if (!vt) {
    await page.addInitScript(() => {
      delete (Document.prototype as { startViewTransition?: unknown })
        .startViewTransition;
    });
  }
  await page.goto(options.url("/hook-fields/1"));
  await options.waitForHydration(page);
  await expect(testId(page, "hook-fields-tail")).toHaveText("tail 1");
  expect(await page.evaluate(() => "startViewTransition" in document)).toBe(vt);
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.__hookFieldsSamples = [];
    const data = (id: string): DOMStringMap =>
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.dataset ??
      {};
    const sample = (kind: Sample["kind"]): void => {
      const status = data("hook-fields-status");
      const link = data("hook-fields-link-chrome");
      w.__hookFieldsSamples!.push({
        kind,
        id:
          document.querySelector('[data-testid="hook-fields-id"]')
            ?.textContent ?? "",
        stamp: data("hook-fields-stamp").stamp ?? "",
        holding: document.documentElement.dataset.hookFieldsHolding ?? "0",
        bar: data("hook-fields-bar").streaming ?? "",
        pending: data("hook-fields-pending").pending ?? "",
        selState: data("hook-fields-state").state ?? "",
        selNavigating: data("hook-fields-navigating").navigating ?? "",
        selLocation: data("hook-fields-location").location ?? "",
        state: status.state ?? "",
        navigating: status.navigating ?? "",
        streaming: status.streaming ?? "",
        statusPending: status.pending ?? "",
        location: status.location ?? "",
        linkPending: link.linkPending ?? "",
        linkStreaming: link.streaming ?? "",
      });
    };
    new MutationObserver(() => sample("mutation")).observe(
      document.documentElement,
      { childList: true, subtree: true, characterData: true, attributes: true },
    );
    const frame = (): void => {
      sample("frame");
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** A few frames past the current screen, then every sample since `from`. */
async function samplesFrom(page: Page, from: number): Promise<Sample[]> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return page.evaluate(
    (start) =>
      ((window as unknown as ProbeWindow).__hookFieldsSamples ?? []).slice(
        start,
      ),
    from,
  );
}

async function sampleCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as ProbeWindow).__hookFieldsSamples!.length,
  );
}

/** The page settled: its id, its tail, idle and the stream's end on screen. */
async function waitForPage(page: Page, id: string): Promise<void> {
  await expect(testId(page, "hook-fields-id")).toHaveText(id, {
    timeout: 15000,
  });
  await expect(testId(page, "hook-fields-tail")).toHaveText(`tail ${id}`);
  const status = testId(page, "hook-fields-status");
  await expect(status).toHaveAttribute("data-state", "idle");
  await expect(status).toHaveAttribute("data-streaming", "false");
}

/** One screen, compact: page | holds | each selector | status | link. */
const screenOf = (s: Sample): string =>
  [
    `page=${s.id} stamp=${s.stamp} holds=${s.holding}`,
    `selectors=${s.selState} navigating=${s.selNavigating} streaming=${s.bar} pending=${s.pending} location=${s.selLocation}`,
    `status=${s.state} navigating=${s.navigating} streaming=${s.streaming} pending=${s.statusPending} location=${s.location}`,
    `link=${s.linkPending} streaming=${s.linkStreaming}`,
  ].join(" | ");

/** The distinct screens, in order. */
const screensOf = (samples: Sample[]): string[] =>
  samples
    .map(screenOf)
    .filter((screen, i, all) => i === 0 || all[i - 1] !== screen);

/** Each field's selector readers, against the full state's value. */
const FIELDS: [string, (s: Sample) => string[], (s: Sample) => string][] = [
  ["state", (s) => [s.selState], (s) => s.state],
  ["isNavigating", (s) => [s.selNavigating], (s) => s.navigating],
  ["isStreaming", (s) => [s.bar, s.linkStreaming], (s) => s.streaming],
  ["pendingUrl", (s) => [s.pending], (s) => s.statusPending],
  ["location", (s) => [s.selLocation], (s) => s.location],
];

/**
 * Every reader shape reads each field alike on every recorded screen: the
 * fields whose selectors disagree with the full state, one entry per
 * distinct torn screen.
 */
function expectReadersAgree(samples: Sample[]): void {
  const torn = screensOf(samples).flatMap((screen) => {
    const s = samples.find((x) => screenOf(x) === screen)!;
    const fields = FIELDS.filter(([, selected, full]) =>
      selected(s).some((value) => value !== full(s)),
    ).map(([name]) => name);
    return fields.length ? [`${fields.join(", ")}: ${screen}`] : [];
  });
  expect(
    torn,
    `screens whose readers disagree, of:\n${screensOf(samples).join("\n")}`,
  ).toEqual([]);
}

/**
 * Animation frames that show page `id` beside the work that brought it: the
 * page commits with what it held, and its release brings idle in the same
 * task (docs/internal/execution-model.md), so no frame paints between. A
 * stream that outlives the commit (`tail: "open"`) is no such work: its
 * isStreaming stays true over the page until it ends.
 */
function workOverPage(
  samples: Sample[],
  id: string,
  tail: "ended" | "open",
): number {
  return samples.filter(
    (s) =>
      s.kind === "frame" &&
      s.id === id &&
      (s.state === "loading" ||
        s.navigating === "true" ||
        s.selState === "loading" ||
        (tail === "ended" &&
          (s.streaming === "true" ||
            s.bar === "true" ||
            s.linkStreaming === "true"))),
  ).length;
}

export function runHookFieldsTests(options: HookFieldsScenarioOptions): void {
  for (const variant of VARIANTS) {
    test(`${variant.name}: a link click's held page: every reader shape reads each field alike`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, variant.vt);
      const from = await sampleCount(page);

      await testId(page, "hook-fields-link-2").click();
      await waitForPage(page, "2");
      const samples = await samplesFrom(page, from);

      expect(
        samples.some(
          (s) =>
            s.id === "1" &&
            s.holding !== "0" &&
            s.location === "/hook-fields/1" &&
            s.state === "loading",
        ),
        "React held page 2 under page 1",
      ).toBe(true);
      expectReadersAgree(samples);
      expect(
        workOverPage(samples, "2", "ended"),
        "animation frames with page 2 and its navigation's work",
      ).toBe(0);
    });

    test(`${variant.name}: a newer click while the page is held: every reader shape reads each field alike`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, variant.vt);
      const from = await sampleCount(page);

      await testId(page, "hook-fields-link-2").click();
      await page.waitForURL(/\/hook-fields\/2$/);
      await expect(testId(page, "hook-fields-id")).toHaveText("1");
      await testId(page, "hook-fields-link-3").click();
      await waitForPage(page, "3");
      const samples = await samplesFrom(page, from);

      expect(
        samples.some(
          (s) =>
            s.id === "1" &&
            s.holding !== "0" &&
            s.pending === "/hook-fields/3" &&
            s.statusPending === "/hook-fields/3",
        ),
        "page 3's pendingUrl showed over the held page 1",
      ).toBe(true);
      expectReadersAgree(samples);
      expect(
        workOverPage(samples, "3", "ended"),
        "animation frames with page 3 and its navigation's work",
      ).toBe(0);
    });

    test(`${variant.name}: a held page whose stream outlives its commit: every reader shape reads each field alike`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, variant.vt);
      const from = await sampleCount(page);

      await testId(page, "hook-fields-link-4").click();
      await waitForPage(page, "4");
      const samples = await samplesFrom(page, from);

      expect(
        samples.some(
          (s) =>
            s.id === "1" &&
            s.holding !== "0" &&
            s.location === "/hook-fields/1" &&
            s.state === "loading",
        ),
        "React held page 4 under page 1",
      ).toBe(true);
      expect(
        samples.some(
          (s) =>
            s.kind === "frame" &&
            s.id === "4" &&
            s.state === "idle" &&
            s.streaming === "true",
        ),
        "page 4's stream outlived its commit",
      ).toBe(true);
      expectReadersAgree(samples);
      expect(
        workOverPage(samples, "4", "open"),
        "animation frames with page 4 and its navigation's work",
      ).toBe(0);
    });

    test(`${variant.name}: a stale Back whose revalidation holds: every reader shape reads each field alike`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, variant.vt);
      const cached = await testId(page, "hook-fields-stamp").getAttribute(
        "data-stamp",
      );
      await testId(page, "hook-fields-link-2").click();
      await waitForPage(page, "2");
      await testId(page, "hook-fields-invalidate").click();
      const from = await sampleCount(page);

      await page.goBack();
      await waitForPage(page, "1");
      await expect(testId(page, "hook-fields-stamp")).not.toHaveAttribute(
        "data-stamp",
        cached!,
        { timeout: 15000 },
      );
      const samples = await samplesFrom(page, from);

      expect(
        samples.some(
          (s) => s.id === "1" && s.stamp === cached && s.holding !== "0",
        ),
        "React held page 1's revalidation under the restored page 1",
      ).toBe(true);
      expectReadersAgree(samples);
    });
  }
}
