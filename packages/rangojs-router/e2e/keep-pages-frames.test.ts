import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * SPIKE (kept pages, part C): what each frame shows across a page switch,
 * with an Outlet that keeps left pages (`<Outlet keep={{ max: 1 }} />`) and
 * without it, in a clientUrls() group and as server routes
 * (test-app/src/urls/keep-spike*.tsx, a 400 ms loader per page).
 *
 * A recorder installed before the app loads snapshots the screen in every
 * requestAnimationFrame callback (`F`, what that frame paints) and after
 * every DOM mutation batch (`M`, a committed state, painted or not). A line
 * is logged when the snapshot changes; `F ... = painted` marks the frame that
 * paints the M line above it, so an M line followed by another M line before
 * any F was never painted. Flags name what is wrong on a line:
 * FALLBACK (a page's Suspense fallback is visible), BLANK (no page visible),
 * TWO (two pages visible), REMOUNT (a page seen before shows a new
 * instance), PATH (the shown page's own usePathname is not its page),
 * DATA (its loader data names another page), TITLE (the useHandle(Meta)
 * title is not the shown page's), DOC (document.title is not), CRUMB (the
 * crumbs end on another page). Probes, not assertions: each test asserts the
 * switch settles and prints its log for the plan's results.
 */

type Variant = "client-keep" | "client-plain" | "server-keep" | "server-plain";
const VARIANTS: readonly Variant[] = [
  "client-keep",
  "client-plain",
  "server-keep",
  "server-plain",
];

interface Recorder {
  start(label: string): void;
  stop(): string[];
}

/** Runs in the page before the app (addInitScript): no closures. */
function installRecorder(): void {
  const w = window as unknown as { __ks?: Recorder };
  if (w.__ks) return;
  let log: string[] = [];
  let recording = false;
  let t0 = 0;
  let frame = 0;
  let last = "";
  let lastPainted = "";
  const instances = new Map<string, string>();

  function visible(el: Element): boolean {
    return (el as HTMLElement).checkVisibility();
  }

  function snapshot(): { text: string; flags: string[] } {
    const pages = [...document.querySelectorAll<HTMLElement>("[data-ks-page]")];
    const shown = pages.filter(visible);
    const hidden = pages.filter((el) => !visible(el));
    const fallbacks = [
      ...document.querySelectorAll<HTMLElement>("[data-ks-fallback]"),
    ].filter(visible);
    const chrome = document.querySelector<HTMLElement>("[data-ks-chrome]");
    const flags: string[] = [];
    const describe = (el: HTMLElement): string => {
      const data = el.querySelector<HTMLElement>("[data-ks-data]");
      const fallback = el.querySelector<HTMLElement>("[data-ks-fallback]");
      const shownData = data && visible(data) ? data.dataset.ksData : null;
      const search = el.dataset.ksSearch ? `?${el.dataset.ksSearch}` : "";
      return (
        `${el.dataset.ksPage}#${el.dataset.ksInst} ` +
        `path=${el.dataset.ksPath}${search} nav=${el.dataset.ksNav} ` +
        `data=${shownData ?? (fallback && visible(fallback) ? "<fallback>" : "-")}`
      );
    };
    if (fallbacks.length) flags.push("FALLBACK");
    if (shown.length === 0) flags.push("BLANK");
    if (shown.length > 1) flags.push("TWO");
    for (const el of pages) {
      const id = `${el.dataset.ksPage}`;
      const inst = `${el.dataset.ksInst}`;
      const seen = instances.get(id);
      // Instances count per document (keep-spike.client.tsx): a new one
      // above #1 is a page this document mounted before.
      if (seen !== inst) {
        flags.push(
          seen !== undefined || Number(inst) > 1
            ? `REMOUNT(${id}#${inst})`
            : `mount(${id}#${inst})`,
        );
      }
      instances.set(id, inst);
    }
    const page = shown[0]?.dataset.ksPage;
    if (page) {
      const el = shown[0]!;
      if (!el.dataset.ksPath?.endsWith(`/${page}`)) flags.push("PATH");
      const data = el.querySelector<HTMLElement>("[data-ks-data]");
      if (data && visible(data) && !data.dataset.ksData?.startsWith(`${page} `))
        flags.push("DATA");
      if (chrome && chrome.dataset.ksTitle !== `KS ${page}`)
        flags.push("TITLE");
      if (!document.title.includes(`KS ${page}`)) flags.push("DOC");
      if (chrome && !chrome.dataset.ksCrumbs?.endsWith(page))
        flags.push("CRUMB");
    }
    const text =
      `url=${location.pathname.split("/").pop()}${location.search} | ` +
      `shown=${shown.map(describe).join(" + ") || "-"} | ` +
      `hidden=${hidden.map((el) => `${el.dataset.ksPage}#${el.dataset.ksInst}(${el.dataset.ksPath?.split("/").pop()})`).join(",") || "-"} | ` +
      `chrome path=${chrome?.dataset.ksPath?.split("/").pop()} nav=${chrome?.dataset.ksNav} ` +
      `title="${chrome?.dataset.ksTitle}" crumbs=${chrome?.dataset.ksCrumbs} | ` +
      `doc="${document.title}"`;
    return { text, flags };
  }

  function record(kind: "F" | "M"): void {
    if (!recording) return;
    const { text, flags } = snapshot();
    const ms = (performance.now() - t0).toFixed(0).padStart(5);
    const at = `f${String(frame).padStart(3)} +${ms}ms`;
    if (kind === "F" && text === last && text !== lastPainted) {
      // The state the last M line logged reaches the screen in this frame.
      log.push(`F ${at} = painted`);
    } else if (text !== last) {
      const flagText = flags.length ? ` !! ${flags.join(" ")}` : "";
      log.push(`${kind} ${at} ${text}${flagText}`);
    }
    last = text;
    if (kind === "F") lastPainted = text;
  }

  function tick(): void {
    frame++;
    record("F");
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  const observer = new MutationObserver(() => record("M"));
  const observe = () =>
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  observe();

  w.__ks = {
    start(label: string) {
      log = [`-- ${label}`];
      recording = true;
      t0 = performance.now();
      frame = 0;
      last = "";
      lastPainted = "";
      instances.clear();
      // Seed the instances seen before the switch.
      for (const el of document.querySelectorAll<HTMLElement>(
        "[data-ks-page]",
      )) {
        instances.set(`${el.dataset.ksPage}`, `${el.dataset.ksInst}`);
      }
      record("F");
    },
    stop() {
      recording = false;
      return log;
    },
  };
}

async function settled(
  page: Page,
  name: "a" | "b" | "c",
  dataPattern: RegExp = new RegExp(`^${name} run=`),
): Promise<void> {
  const shown = page.locator(`[data-ks-page="${name}"]:visible`);
  await expect(shown).toHaveCount(1, { timeout: 10_000 });
  await expect(shown.locator("[data-ks-data]")).toHaveAttribute(
    "data-ks-data",
    dataPattern,
  );
  const chrome = page.locator("[data-ks-chrome]");
  await expect(chrome).toHaveAttribute("data-ks-nav", "idle");
  await expect(chrome).toHaveAttribute("data-ks-path", new RegExp(`/${name}$`));
  await expect(chrome).toHaveAttribute("data-ks-title", `KS ${name}`);
}

/** Records one switch: `act` starts it, the log runs until it settles. */
async function recordSwitch(
  page: Page,
  label: string,
  act: () => Promise<unknown>,
  until: () => Promise<void>,
): Promise<string[]> {
  await page.evaluate((l) => (window as any).__ks.start(l), label);
  await act();
  await until();
  // Late frames: a passive-effect catch-up or a late handle lands here.
  await page.waitForTimeout(500);
  const log = (await page.evaluate(() =>
    (window as any).__ks.stop(),
  )) as string[];
  console.log(log.join("\n"));
  return log;
}

async function open(page: Page, base: string, to: "a" | "b"): Promise<void> {
  await page.goto(`${base}/${to === "b" ? "b?from=a" : "a"}`);
  await waitForHydration(page);
  await settled(page, to);
}

async function go(page: Page, to: "a" | "b" | "c"): Promise<void> {
  await testId(page, `ks-to-${to}`).click();
  await settled(page, to);
}

function keepPagesFrames(f: ReturnType<typeof useFixture>, mode: string) {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installRecorder);
  });

  for (const variant of VARIANTS) {
    const base = () => f.url(`/keep-spike/${variant}`);
    const tag = `[${mode} ${variant}]`;

    test(`${variant}: first visit`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page, base(), "a");
      await recordSwitch(
        page,
        `${tag} first visit a -> b`,
        () => testId(page, "ks-to-b").click(),
        () => settled(page, "b"),
      );
    });

    test(`${variant}: back to a left page`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page, base(), "a");
      await go(page, "b");
      await recordSwitch(
        page,
        `${tag} back to left page b -> a (link)`,
        () => testId(page, "ks-to-a").click(),
        () => settled(page, "a"),
      );
    });

    test(`${variant}: past the cap`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page, base(), "a");
      await go(page, "b");
      await go(page, "c");
      await recordSwitch(
        page,
        `${tag} past the cap (max 1) a -> b -> c -> a (link)`,
        () => testId(page, "ks-to-a").click(),
        () => settled(page, "a"),
      );
    });

    test(`${variant}: Back and Forward`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page, base(), "a");
      await go(page, "b");
      await recordSwitch(
        page,
        `${tag} Back b -> a`,
        () => page.goBack(),
        () => settled(page, "a"),
      );
      await recordSwitch(
        page,
        `${tag} Forward a -> b`,
        () => page.goForward(),
        () => settled(page, "b"),
      );
    });

    test(`${variant}: action while a page is hidden`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page, base(), "a");
      const before = await page
        .locator('[data-ks-page="a"] [data-ks-data]')
        .getAttribute("data-ks-data");
      const acts = Number(/acts=(\d+)/.exec(before ?? "")?.[1] ?? NaN);
      await go(page, "b");
      await testId(page, "ks-act").click();
      await expect(testId(page, "ks-act")).toHaveAttribute(
        "data-acting",
        "false",
      );
      await settled(page, "b", new RegExp(`^b run=\\d+ acts=${acts + 1}$`));
      await recordSwitch(
        page,
        `${tag} action on b while a is hidden, then b -> a (link); a's data had acts=${acts}, now acts=${acts + 1}`,
        () => testId(page, "ks-to-a").click(),
        () => settled(page, "a", new RegExp(`^a run=\\d+ acts=${acts + 1}$`)),
      );
    });
  }
}

/**
 * SPIKE (part D): why a kept server-route page shows its fallback on a link
 * back. `window.__ksSpike` (src/spike-kept-registry.ts) turns on the commit
 * probe in partial-update.ts (which branch commits, what `_rsc_segments`
 * listed, what the server re-rendered), the handle probe in
 * event-controller.ts, and the spike commit modes: "transition" (H2) and
 * "two-step" (H3).
 */
type SpikeMode = "today" | "transition" | "two-step" | "transition-all";

async function withSpike(page: Page, mode: SpikeMode): Promise<void> {
  await page.addInitScript((m) => {
    (window as any).__ksSpike = {
      mode: m === "today" ? undefined : m,
      log: [],
    };
  }, mode);
}

async function recordSpiked(
  page: Page,
  label: string,
  act: () => Promise<unknown>,
  until: () => Promise<void>,
): Promise<string[]> {
  const t0 = await page.evaluate(() => {
    (window as any).__ksSpike.log.length = 0;
    return performance.now();
  });
  const frames = await recordSwitch(page, label, act, until);
  const log = (await page.evaluate(
    () => (window as any).__ksSpike.log,
  )) as Array<Record<string, unknown> & { t: number }>;
  const lines = log.map(
    ({ t, ...rest }) =>
      `  probe +${String(Math.round(t - t0)).padStart(4)}ms ${JSON.stringify(rest)}`,
  );
  console.log(lines.join("\n"));
  return [...frames, ...lines];
}

function partD(f: ReturnType<typeof useFixture>, mode: string) {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installRecorder);
  });

  for (const variant of ["server-keep", "server-plain"] as const) {
    for (const spike of ["today", "transition", "two-step"] as const) {
      if (variant === "server-plain" && spike !== "today") continue;
      const tag = `[${mode} ${variant} ${spike}]`;
      const base = () => f.url(`/keep-spike/${variant}`);

      test(`part D ${variant} ${spike}: back to a left page`, async ({
        page,
      }) => {
        using _ = expectNoPageError(page);
        await withSpike(page, spike);
        await open(page, base(), "a");
        await go(page, "b");
        await recordSpiked(
          page,
          `${tag} back to left page b?from=a -> a (link)`,
          () => testId(page, "ks-to-a").click(),
          () => settled(page, "a"),
        );
      });

      test(`part D ${variant} ${spike}: back from a bare b`, async ({
        page,
      }) => {
        using _ = expectNoPageError(page);
        await withSpike(page, spike);
        await open(page, base(), "a");
        await testId(page, "ks-to-b-bare").click();
        await settled(page, "b");
        await recordSpiked(
          page,
          `${tag} back to left page b -> a (link, no search on either)`,
          () => testId(page, "ks-to-a").click(),
          () => settled(page, "a"),
        );
      });
    }

    for (const spike of ["today", "transition-all"] as const) {
      test(`part D ${variant} ${spike}: first visit`, async ({ page }) => {
        using _ = expectNoPageError(page);
        await withSpike(page, spike);
        await open(page, base0(f, variant), "a");
        await recordSpiked(
          page,
          `[${mode} ${variant} ${spike}] first visit a -> b?from=a`,
          () => testId(page, "ks-to-b").click(),
          () => settled(page, "b"),
        );
      });
    }
  }
}

function base0(f: ReturnType<typeof useFixture>, variant: string): string {
  return f.url(`/keep-spike/${variant}`);
}

test.describe("keep pages frames", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  keepPagesFrames(f, "dev");
});

test.describe("keep pages frames (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  keepPagesFrames(f, "production");
});

test.describe("keep pages part D", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  partD(f, "dev");
});

test.describe("keep pages part D (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  partD(f, "production");
});
