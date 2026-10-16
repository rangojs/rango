import { expect, test, type Page } from "@playwright/test";

/**
 * #1164's filter chips while other work overlaps the held page (hook-lock
 * rows S10 and S8): useNavigation() reaches idle only with the page that
 * brings the new search, so a removed chip never comes back.
 *
 * Fixture in each app: /nav-idle-overlap, a transition() route whose loader
 * takes 1.5 s and is read on the client (React holds the page until it
 * answers), renders NavIdleFilters (the issue's chips) and
 * NavIdleOverlapControls: a server action that answers after 300 ms, and a
 * newer navigation (?away) the server answers with an external redirect after
 * 300 ms. The external host answers 204 here, so the document stays while
 * React still holds the page.
 *
 * A recorder samples the chips, the server's tags and useNavigation's state
 * (NavIdleFilters' data-idle, data-full-idle) on every animation frame and
 * after every DOM mutation: once chip a is gone, no sample may show it again,
 * no sample shows idle over the page being left, and no animation frame shows
 * loading over the new page.
 */

export interface NavIdleOverlapScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  expectNoPageError: (page: Page) => Disposable;
  /** The app's NAV_IDLE_EXTERNAL. */
  externalUrl: string;
}

/** One recorded screen: an animation frame, or the DOM after a mutation. */
type Sample = {
  kind: "frame" | "mutation";
  chips: string;
  tags: string;
  idle: string;
  fullIdle: string;
};
type Overlap = { event: string; tags: string; search: string };
type NavIdleEntry = { idle: boolean; fullIdle: boolean; search: string };
type ProbeWindow = {
  __chipSamples?: Sample[];
  __navIdleOverlap?: Overlap[];
  __navIdleLog?: NavIdleEntry[];
};

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const VARIANTS = [
  { name: "with a view transition", vt: true },
  { name: "where view transitions are unsupported", vt: false },
] as const;

async function open(
  page: Page,
  options: NavIdleOverlapScenarioOptions,
  vt: boolean,
): Promise<void> {
  if (!vt) {
    await page.addInitScript(() => {
      delete (Document.prototype as { startViewTransition?: unknown })
        .startViewTransition;
    });
  }
  await page.goto(options.url("/nav-idle-overlap?tag=a&tag=b"));
  await options.waitForHydration(page);
  await expect(testId(page, "nav-idle-server-tags")).toHaveText("a,b");
  expect(await page.evaluate(() => "startViewTransition" in document)).toBe(vt);
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.__chipSamples = [];
    w.__navIdleOverlap = [];
    w.__navIdleLog = [];
    const sample = (kind: Sample["kind"]): void => {
      const chips = [
        ...document.querySelectorAll('[data-testid^="nav-idle-remove-"]'),
      ]
        .map((el) => el.getAttribute("data-testid")!.slice(16))
        .join(",");
      const tags =
        document.querySelector('[data-testid="nav-idle-server-tags"]')
          ?.textContent ?? "";
      const list = document.querySelector<HTMLElement>(
        '[data-testid="nav-idle-chips"]',
      );
      w.__chipSamples!.push({
        kind,
        chips,
        tags,
        idle: list?.dataset.idle ?? "",
        fullIdle: list?.dataset.fullIdle ?? "",
      });
    };
    new MutationObserver(() => sample("mutation")).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-idle", "data-full-idle"],
    });
    const frame = (): void => {
      sample("frame");
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Waits for the page, then asserts chip a never came back after it left. */
async function expectChipNeverReturns(page: Page): Promise<void> {
  await expect(testId(page, "nav-idle-server-tags")).toHaveText("b", {
    timeout: 15000,
  });
  // A few frames after the page, so the recorder holds its commit.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const { samples, log } = await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    return { samples: w.__chipSamples ?? [], log: w.__navIdleLog ?? [] };
  });
  const gone = samples.findIndex((s) => !s.chips.split(",").includes("a"));
  expect(gone, "chip a left the screen").toBeGreaterThanOrEqual(0);
  const after = samples.slice(gone);
  const back = after.filter((s) => s.chips.split(",").includes("a"));
  expect(
    { samples: after.length, showingChipA: back.length, first: back[0] },
    "samples showing chip a again",
  ).toEqual({ samples: after.length, showingChipA: 0, first: undefined });
  const end = after[after.length - 1];
  expect({ chips: end.chips, tags: end.tags, idle: end.idle }).toEqual({
    chips: "b",
    tags: "b",
    idle: "true",
  });
  // The cause, on the hooks: from the navigation's loading on, no commit had
  // idle with the old search (the click's own commit, before loading, has),
  // through a selector or through the full state; and no recorded screen
  // showed idle over the page being left.
  for (const read of ["idle", "fullIdle"] as const) {
    const fromLoading = log.slice(log.findIndex((e) => !e[read]));
    expect(
      fromLoading.filter((e) => e[read] && e.search === "tag=a&tag=b"),
      `commits with ${read} and the old search`,
    ).toEqual([]);
    const screens = after.slice(after.findIndex((e) => e[read] === "false"));
    expect(
      screens.filter((e) => e[read] === "true" && e.tags === "a,b").length,
      `screens with ${read} over the page being left`,
    ).toBe(0);
  }
  // The page commits with the hold's loading and its release brings idle
  // right after (docs/internal/execution-model.md): in the same task, or in
  // a view transition when its `ready` resolves. No animation frame shows
  // loading over the new page.
  expect(
    after.filter(
      (e) =>
        e.kind === "frame" &&
        e.tags === "b" &&
        (e.idle === "false" || e.fullIdle === "false"),
    ).length,
    "animation frames with loading over the new page",
  ).toBe(0);
}

async function overlaps(page: Page): Promise<Overlap[]> {
  return page.evaluate(
    () => (window as unknown as ProbeWindow).__navIdleOverlap ?? [],
  );
}

/** The filter navigation committed its URL and React holds its page. */
async function waitForHeldPage(page: Page): Promise<void> {
  await page.waitForURL(/\?tag=b$/);
  await expect(testId(page, "nav-idle-server-tags")).toHaveText("a,b");
}

export function runNavIdleOverlapTests(
  options: NavIdleOverlapScenarioOptions,
): void {
  for (const variant of VARIANTS) {
    test(`${variant.name}: an action that settles while the page is held never brings the removed chip back`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, variant.vt);

      // The action is in flight when the chip is removed, and answers
      // during the 1.5 s hold.
      await testId(page, "nav-idle-action").click();
      await testId(page, "nav-idle-remove-a").click();
      await expect
        .poll(async () =>
          (await overlaps(page)).find((o) => o.event === "action-settled"),
        )
        .toBeTruthy();
      expect(
        (await overlaps(page)).find((o) => o.event === "action-settled"),
        "the action settled while React held the page",
      ).toEqual({ event: "action-settled", tags: "a,b", search: "?tag=b" });

      await expectChipNeverReturns(page);
    });

    test(`${variant.name}: an action that starts and settles while the page is held never brings the removed chip back`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      await open(page, options, variant.vt);

      await testId(page, "nav-idle-remove-a").click();
      await waitForHeldPage(page);
      await testId(page, "nav-idle-action").click();
      expect(
        (await overlaps(page)).find((o) => o.event === "action-start"),
        "the action started while React held the page",
      ).toEqual({ event: "action-start", tags: "a,b", search: "?tag=b" });

      await expectChipNeverReturns(page);
    });

    test(`${variant.name}: a newer navigation answered with an external redirect never brings the removed chip back`, async ({
      page,
    }) => {
      using _ = options.expectNoPageError(page);
      // The external host answers 204, so the browser stays on the page, as
      // it does while a real one is slow to respond.
      const external = new URL(options.externalUrl);
      let redirected = false;
      await page.route(`${external.origin}/**`, (route) => {
        redirected = true;
        return route.fulfill({ status: 204 });
      });
      await open(page, options, variant.vt);

      await testId(page, "nav-idle-remove-a").click();
      await waitForHeldPage(page);
      await testId(page, "nav-idle-away").click();
      await expect.poll(() => redirected).toBe(true);
      expect(
        await testId(page, "nav-idle-server-tags").textContent(),
        "the newer navigation ended while React held the page",
      ).toBe("a,b");

      await expectChipNeverReturns(page);
    });
  }
}
