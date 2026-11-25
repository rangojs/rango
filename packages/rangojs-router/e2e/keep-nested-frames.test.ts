import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * SPIKE (kept pages, part E): nested keeping outlets. An outer layout's
 * `<Outlet keep={{ max: 2 }} />` over section layouts A, B, C and D, each
 * with its own `<Outlet keep={{ max: 2 }} />` over its pages
 * (test-app/src/urls/keep-nested*.tsx, a 400 ms loader per page), as one
 * clientUrls() group ("client"), as server routes ("server"), and as a
 * server outer layout over one clientUrls() group per section ("mixed").
 *
 * The recorder is part C's (keep-pages-frames.test.ts): `F` lines are what
 * a requestAnimationFrame callback saw (`= painted` marks the frame that
 * paints the M line above it), `M` lines a committed DOM state. Flags:
 * FALLBACK, BLANK/TWO (pages shown), SBLANK/STWO (sections shown),
 * REMOUNT(p:x#n) / REMOUNT(s:x#n) (a page or section seen before shows a new
 * instance), PATH (the shown page's usePathname is not its own), SPATH (the
 * shown section's usePathname is not the shown page's), DATA, NAV (the shown
 * page's useNavigation state is not the chrome's), SEARCH (the shown page's
 * useSearchParams is not the URL's), HIDDENMOUNT (a page mounted hidden,
 * never committed visible), TITLE, DOC, CRUMB (the crumbs are not the shown
 * section's and page's). `tree=` lists every section (`~` hidden by the
 * outer outlet) with its pages (`*` its own shown entry). Probes, not
 * assertions: each test asserts the switch settles and prints its log.
 */

type Variant = "client" | "server" | "mixed";
const VARIANTS: readonly Variant[] = ["client", "server", "mixed"];
type PageName = "a1" | "a2" | "a3" | "b1" | "b2" | "b3" | "c1" | "d1";

interface Recorder {
  start(label: string): void;
  stop(): string[];
}

/** Runs in the page before the app (addInitScript): no closures. */
function installRecorder(): void {
  const w = window as unknown as { __kn?: Recorder };
  if (w.__kn) return;
  let log: string[] = [];
  let recording = false;
  let t0 = 0;
  let frame = 0;
  let last = "";
  let lastPainted = "";
  const instances = new Map<string, Set<string>>();

  function visible(el: Element): boolean {
    return (el as HTMLElement).checkVisibility();
  }

  /** Hidden by an Activity between `el` and `stop` (exclusive). */
  function hiddenWithin(el: HTMLElement, stop: Element | null): boolean {
    for (
      let node: HTMLElement | null = el;
      node && node !== stop;
      node = node.parentElement
    ) {
      if (node.style.display === "none") return true;
    }
    return false;
  }

  function snapshot(): { text: string; flags: string[] } {
    const pages = [...document.querySelectorAll<HTMLElement>("[data-kn-page]")];
    const sections = [
      ...document.querySelectorAll<HTMLElement>("[data-kn-section]"),
    ];
    const shown = pages.filter(visible);
    const shownSections = sections.filter(visible);
    const fallbacks = [
      ...document.querySelectorAll<HTMLElement>("[data-kn-fallback]"),
    ].filter(visible);
    const chrome = document.querySelector<HTMLElement>("[data-kn-chrome]");
    const flags: string[] = [];
    const describe = (el: HTMLElement): string => {
      const data = el.querySelector<HTMLElement>("[data-kn-data]");
      const fallback = el.querySelector<HTMLElement>("[data-kn-fallback]");
      const shownData = data && visible(data) ? data.dataset.knData : null;
      const search = el.dataset.knSearch ? `?${el.dataset.knSearch}` : "";
      return (
        `${el.dataset.knPage}#${el.dataset.knInst} ` +
        `path=${el.dataset.knPath?.split("/").slice(-2).join("/")}${search} ` +
        `params=${el.dataset.knParams} nav=${el.dataset.knNav} ` +
        `data=${shownData ?? (fallback && visible(fallback) ? "<fallback>" : "-")}`
      );
    };
    if (fallbacks.length) flags.push("FALLBACK");
    if (shown.length === 0) flags.push("BLANK");
    if (shown.length > 1) flags.push("TWO");
    if (shownSections.length === 0) flags.push("SBLANK");
    if (shownSections.length > 1) flags.push("STWO");
    // An instance number is new once; #0 is an instance that never
    // committed visible (mounted hidden: its layout effect has not run).
    const track = (id: string, inst: string) => {
      if (inst === "0") {
        flags.push(`HIDDENMOUNT(${id})`);
        return;
      }
      const seen = instances.get(id) ?? new Set<string>();
      if (!seen.has(inst)) {
        flags.push(
          seen.size > 0 || Number(inst) > 1
            ? `REMOUNT(${id}#${inst})`
            : `mount(${id}#${inst})`,
        );
        seen.add(inst);
      }
      instances.set(id, seen);
    };
    for (const el of sections)
      track(`s:${el.dataset.knSection}`, `${el.dataset.knSinst}`);
    for (const el of pages)
      track(`p:${el.dataset.knPage}`, `${el.dataset.knInst}`);
    const page = shown[0]?.dataset.knPage;
    if (page) {
      const el = shown[0]!;
      const own = `/${page[0]}/${page[1]}`;
      if (!el.dataset.knPath?.endsWith(own)) flags.push("PATH");
      if ((el.dataset.knSearch ?? "") !== location.search.replace(/^\?/, ""))
        flags.push("SEARCH");
      const section = shownSections[0];
      if (section && !section.dataset.knSpath?.endsWith(own))
        flags.push("SPATH");
      const data = el.querySelector<HTMLElement>("[data-kn-data]");
      if (data && visible(data) && !data.dataset.knData?.startsWith(`${page} `))
        flags.push("DATA");
      if (chrome && el.dataset.knNav !== chrome.dataset.knNav)
        flags.push("NAV");
      if (chrome && chrome.dataset.knTitle !== `KN ${page}`)
        flags.push("TITLE");
      if (!document.title.includes(`KN ${page}`)) flags.push("DOC");
      // The section's and the page's crumbs, in either order: in a group
      // both push into the group route's one segment, child first.
      const crumbs = (chrome?.dataset.knCrumbs ?? "")
        .split(",")
        .sort()
        .join(",");
      if (chrome && crumbs !== [page[0]!.toUpperCase(), page].sort().join(","))
        flags.push("CRUMB");
    }
    // Every section with its pages: `*` marks a section's own shown entry
    // (hidden only by the outer outlet, if at all).
    const tree = sections
      .map((section) => {
        const own = pages
          .filter((el) => el.closest("[data-kn-section]") === section)
          .map(
            (el) =>
              `${el.dataset.knPage}#${el.dataset.knInst}${hiddenWithin(el, section) ? "" : "*"}`,
          )
          .join(",");
        return `${visible(section) ? "" : "~"}${section.dataset.knSection!.toUpperCase()}#${section.dataset.knSinst}{${own}}`;
      })
      .join(" ");
    const shownSection = shownSections[0];
    const text =
      `url=${location.pathname.split("/").slice(-2).join("/")}${location.search} | ` +
      `shown=${shownSection ? `${shownSection.dataset.knSection!.toUpperCase()}#${shownSection.dataset.knSinst}(spath=${shownSection.dataset.knSpath?.split("/").slice(-2).join("/")}) > ` : ""}${shown.map(describe).join(" + ") || "-"} | ` +
      `tree=${tree} | ` +
      `chrome path=${chrome?.dataset.knPath?.split("/").slice(-2).join("/")} nav=${chrome?.dataset.knNav} ` +
      `title="${chrome?.dataset.knTitle}" crumbs=${chrome?.dataset.knCrumbs} | ` +
      `doc="${document.title}"`;
    return { text, flags };
  }

  function record(kind: "F" | "M"): void {
    if (!recording) return;
    const { text, flags } = snapshot();
    const ms = (performance.now() - t0).toFixed(0).padStart(5);
    const at = `f${String(frame).padStart(3)} +${ms}ms`;
    if (kind === "F" && text === last && text !== lastPainted) {
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

  new MutationObserver(() => record("M")).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  w.__kn = {
    start(label: string) {
      log = [`-- ${label}`];
      recording = true;
      t0 = performance.now();
      frame = 0;
      last = "";
      lastPainted = "";
      instances.clear();
      const seed = (id: string, inst: string) =>
        instances.set(id, (instances.get(id) ?? new Set()).add(inst));
      for (const el of document.querySelectorAll<HTMLElement>("[data-kn-page]"))
        seed(`p:${el.dataset.knPage}`, `${el.dataset.knInst}`);
      for (const el of document.querySelectorAll<HTMLElement>(
        "[data-kn-section]",
      ))
        seed(`s:${el.dataset.knSection}`, `${el.dataset.knSinst}`);
      record("F");
    },
    stop() {
      recording = false;
      return log;
    },
  };
}

/**
 * "two-step": part D's reveal (H3). "no-return-location": the control for
 * N3, an inner outlet shown again by the outer one reads its store hooks.
 * "no-keep": the N5 baseline, every keeping outlet drawn plain.
 */
type SpikeMode = "today" | "two-step" | "no-return-location" | "no-keep";

async function withSpike(page: Page, mode: SpikeMode): Promise<void> {
  await page.addInitScript((m) => {
    (window as any).__ksSpike = {
      mode: m === "two-step" ? m : undefined,
      noReturnLocation: m === "no-return-location",
      noKeep: m === "no-keep",
      log: [],
    };
  }, mode);
}

async function settled(page: Page, name: PageName): Promise<void> {
  const shown = page.locator(`[data-kn-page="${name}"]:visible`);
  await expect(shown).toHaveCount(1, { timeout: 10_000 });
  await expect(shown.locator("[data-kn-data]")).toHaveAttribute(
    "data-kn-data",
    new RegExp(`^${name} run=`),
  );
  const chrome = page.locator("[data-kn-chrome]");
  await expect(chrome).toHaveAttribute("data-kn-nav", "idle");
  await expect(chrome).toHaveAttribute(
    "data-kn-path",
    new RegExp(`/${name[0]}/${name[1]}$`),
  );
  await expect(chrome).toHaveAttribute("data-kn-title", `KN ${name}`);
}

/** Records one switch: the frame log, then the commit probe's lines. */
async function recordSwitch(
  page: Page,
  label: string,
  act: () => Promise<unknown>,
  until: () => Promise<void>,
): Promise<string[]> {
  const t0 = await page.evaluate((l) => {
    (window as any).__ksSpike.log.length = 0;
    (window as any).__kn.start(l);
    return performance.now();
  }, label);
  await act();
  await until();
  // Late frames: a passive-effect catch-up or a late handle lands here.
  await page.waitForTimeout(500);
  const frames = (await page.evaluate(() =>
    (window as any).__kn.stop(),
  )) as string[];
  const probe = (await page.evaluate(
    () => (window as any).__ksSpike.log,
  )) as Array<Record<string, unknown> & { t: number }>;
  const lines = [
    ...frames,
    ...probe
      .filter((entry) => entry.branch !== undefined || entry.outlet)
      .map(
        ({ t, branch, keptKeys, rscSegments, rerendered, outlet, key }) =>
          `  probe +${String(Math.round(t - t0)).padStart(4)}ms ${JSON.stringify(
            outlet
              ? { outlet, key }
              : { branch, keptKeys, held: rscSegments, rerendered },
          )}`,
      ),
  ];
  console.log(lines.join("\n"));
  return lines;
}

/** What is mounted: sections and pages, shown or kept, and the counters. */
async function census(page: Page, label: string): Promise<string> {
  await page.evaluate(() => {
    (window as any).__ksSpike.log.length = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
  };
  await cdp.detach();
  const dom = await page.evaluate(() => {
    const w = window as any;
    // The probe's own log grows with every navigation.
    w.__ksSpike.log.length = 0;
    const sections = [
      ...document.querySelectorAll<HTMLElement>("[data-kn-section]"),
    ];
    return {
      sections: sections.length,
      pages: document.querySelectorAll("[data-kn-page]").length,
      elements: document.querySelectorAll("*").length,
      mounts: w.__knMounts ?? 0,
      subscriptions: w.__ksSpike.subscriptions?.() ?? null,
      kept: sections
        .map(
          (section) =>
            `${section.dataset.knSection}#${section.dataset.knSinst}[${[
              ...section.querySelectorAll<HTMLElement>("[data-kn-page]"),
            ]
              .map((el) => `${el.dataset.knPage}#${el.dataset.knInst}`)
              .join(",")}]`,
        )
        .join(" "),
    };
  });
  const line = `[census] ${label}: ${JSON.stringify({ ...dom, heapKB: Math.round(heap.usedSize / 1024) })}`;
  console.log(line);
  return line;
}

async function open(page: Page, base: string, to: PageName): Promise<void> {
  await page.goto(`${base}/${to[0]}/${to[1]}`);
  await waitForHydration(page);
  await settled(page, to);
}

async function go(page: Page, to: PageName): Promise<void> {
  await testId(page, `kn-to-${to}`).click();
  await settled(page, to);
}

function link(
  page: Page,
  tag: string,
  from: PageName,
  to: PageName,
  search: "" | "?q=back" = "",
) {
  return recordSwitch(
    page,
    `${tag} ${from} -> ${to}${search} (link)`,
    () => testId(page, `kn-to-${to}${search ? "-q" : ""}`).click(),
    () => settled(page, to),
  );
}

function keepNestedFrames(f: ReturnType<typeof useFixture>, mode: string) {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installRecorder);
  });

  for (const variant of VARIANTS) {
    const base = () => f.url(`/keep-nested/${variant}`);

    test(`${variant}: switches inside a section, then leaving it`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const tag = `[${mode} ${variant}]`;
      await withSpike(page, "today");
      await open(page, base(), "a1");
      await link(page, tag, "a1", "a2");
      await go(page, "a3");
      await link(page, tag, "a3", "a1");
      await link(page, tag, "a1", "b1");
      await census(page, `${tag} after a1 a2 a3 a1 b1`);
    });

    for (const spike of ["today", "two-step", "no-return-location"] as const) {
      if (variant === "client" && spike === "two-step") continue;
      test(`${variant} ${spike}: back to a left section`, async ({ page }) => {
        using _ = expectNoPageError(page);
        const tag = `[${mode} ${variant} ${spike}]`;
        await withSpike(page, spike);
        await open(page, base(), "a1");
        await go(page, "a2");
        await go(page, "b1");
        await go(page, "b2");
        await census(page, `${tag} after a1 a2 b1 b2`);
        await link(page, tag, "b2", "a2");
        await link(page, tag, "a2", "b1");
        await census(page, `${tag} after a2 b1`);
        // With a search: the section shown again at its own page (b1 -> a2),
        // then at a page kept inside it (a2 -> b2; B's own page is b1).
        await link(page, tag, "b1", "a2", "?q=back");
        await link(page, tag, "a2", "b2", "?q=back");
      });
    }

    test(`${variant}: Back and Forward across both levels`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const tag = `[${mode} ${variant}]`;
      await withSpike(page, "today");
      await open(page, base(), "a1");
      await go(page, "a2");
      await go(page, "b1");
      await go(page, "b2");
      const steps: Array<["Back" | "Forward", PageName, PageName]> = [
        ["Back", "b2", "b1"],
        ["Back", "b1", "a2"],
        ["Back", "a2", "a1"],
        ["Forward", "a1", "a2"],
        ["Forward", "a2", "b1"],
        ["Forward", "b1", "b2"],
      ];
      for (const [direction, from, to] of steps) {
        await recordSwitch(
          page,
          `${tag} ${direction} ${from} -> ${to}`,
          () => (direction === "Back" ? page.goBack() : page.goForward()),
          () => settled(page, to),
        );
      }
    });

    for (const spike of ["today", "no-keep"] as const) {
      test(`${variant} ${spike}: the cap, eviction and no growth`, async ({
        page,
      }) => {
        using _ = expectNoPageError(page);
        const tag = `[${mode} ${variant} ${spike}]`;
        await withSpike(page, spike);
        await open(page, base(), "a1");
        await census(page, `${tag} at a1`);
        const tour: PageName[] = ["a2", "a3", "b1", "b2", "b3", "a1"];
        for (const to of tour) await go(page, to);
        await census(page, `${tag} after tour 1`);
        for (const to of tour) await go(page, to);
        await census(page, `${tag} after tour 2`);
        for (const to of tour) await go(page, to);
        await census(page, `${tag} after tour 3`);
        await go(page, "c1");
        await census(page, `${tag} after c1`);
        await go(page, "d1");
        await census(page, `${tag} after d1`);
        await link(page, tag, "d1", "b2");
        await census(page, `${tag} after b2`);
      });
    }
  }
}

test.describe("keep nested frames", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  keepNestedFrames(f, "dev");
});

test.describe("keep nested frames (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  keepNestedFrames(f, "production");
});
