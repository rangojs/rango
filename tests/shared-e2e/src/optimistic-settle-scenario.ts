import { expect, test, type Page } from "@playwright/test";
import {
  countViewTransitions,
  viewTransitionTypes,
} from "./view-transition-probe.js";

/**
 * Optimistic hook values show the work at once, settle in the page's commit,
 * and never take the page's transition types (hooks review dc-d152, W2: rows
 * LS1, LS6, TT4, A2).
 *
 * Fixture in each app: /opt-settle/<variant>/:id (test-app
 * urls/optimistic-settle.tsx, cloudflare-basic pages/optimistic-settle.tsx).
 * Every request waits 400 ms, and a page takes 1500 ms more, so a
 * navigation's commit is handed to React long before its page can show. The
 * shell's links 2, 3, r and f carry a useLinkStatus() spinner, link 4 none;
 * r redirects to 4, and f's page throws into the route's errorBoundary().
 * The shell's Save button runs a server action that a useAction() reader
 * beside it follows. The page renders a <ViewTransition> whose map animates
 * `push` only.
 *
 * - window.__optSettleLog: every commit of a spinner,
 *   "<link>:<pending|idle>:<page on screen>".
 * - window.__optSettleVt: each commit that animates the page's push-keyed
 *   <ViewTransition>, "<event>:<page>:<types>".
 * - countViewTransitions: the types of each document.startViewTransition.
 *
 * React keeps one queue of transition types per root, and the first commit
 * made only of transition lanes takes all of it (react-dom
 * claimQueuedTransitionTypes); it renders each transition lane on its own. A
 * hook that set its value in a transition of its own while a page was held
 * made such a commit, which took the page's types and could start a view
 * transition with none.
 */

export interface OptimisticSettleScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

type ProbeWindow = { __optSettleLog?: string[]; __optSettleVt?: string[] };

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

const PAGE_TIMEOUT = { timeout: 10000 };

// Two animation frames and a short tail: a late commit lands before the read.
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, 200)),
        ),
      ),
  );
}

function spinnerLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as ProbeWindow).__optSettleLog ?? [],
  );
}

function animated(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as ProbeWindow).__optSettleVt ?? [],
  );
}

/** Spinner `id`'s commits, as "<pending|idle>:<page on screen>", deduplicated. */
async function spinner(page: Page, id: string): Promise<string[]> {
  return (await spinnerLog(page))
    .filter((entry) => entry.startsWith(`${id}:`))
    .map((entry) => entry.slice(id.length + 1))
    .filter((entry, i, all) => all[i - 1] !== entry);
}

export function runOptimisticSettleTests(
  options: OptimisticSettleScenarioOptions,
): void {
  /** Open page 1 of `variant`; resolves the view transitions started so far. */
  const open = async (page: Page, variant: string): Promise<number> => {
    await countViewTransitions(page);
    await page.goto(options.url(`/opt-settle/${variant}/1`));
    await options.waitForHydration(page);
    await expect(testId(page, "opt-settle-page")).toHaveText("1");
    await settle(page);
    await page.evaluate(() => {
      const w = window as unknown as ProbeWindow;
      w.__optSettleLog = [];
      w.__optSettleVt = [];
    });
    return (await viewTransitionTypes(page)).length;
  };

  /** Click link `id`, and wait until its commit is handed to React. */
  const clickAndHold = async (
    page: Page,
    variant: string,
    id: string,
  ): Promise<void> => {
    await testId(page, `opt-settle-to-${id}`).click();
    await expect(page).toHaveURL(
      new RegExp(`/opt-settle/${variant}/${id}$`),
      PAGE_TIMEOUT,
    );
    await expect(testId(page, "opt-settle-page")).toHaveText("1");
  };

  /** The view transitions started since `from`, as their types. */
  const transitionsSince = async (page: Page, from: number) =>
    (await viewTransitionTypes(page)).slice(from).map((each) => each.join(","));

  for (const variant of ["vt", "none"] as const) {
    test(`${variant}: a lone click keeps its link pending until its page shows`, async ({
      page,
    }) => {
      await open(page, variant);
      await testId(page, "opt-settle-to-2").click();
      await expect(testId(page, "opt-settle-page")).toHaveText(
        "2",
        PAGE_TIMEOUT,
      );
      await settle(page);
      // Pending at the click, on the page being left; idle in the commit
      // that shows the destination (its skeleton without transition()).
      expect(await spinner(page, "2")).toEqual(
        variant === "vt"
          ? ["pending:1", "idle:2"]
          : ["pending:1", "idle:skeleton"],
      );
      if (variant === "vt") {
        expect(await animated(page)).toEqual(["update:2:push,navigation"]);
      }
    });

    test(`${variant}: through a server redirect the clicked link stays pending until the target page shows`, async ({
      page,
    }) => {
      await open(page, variant);
      await testId(page, "opt-settle-to-r").click();
      await expect(testId(page, "opt-settle-page")).toHaveText(
        "4",
        PAGE_TIMEOUT,
      );
      await expect(page).toHaveURL(new RegExp(`/opt-settle/${variant}/4$`));
      await settle(page);
      expect(await spinner(page, "r")).toEqual(
        variant === "vt"
          ? ["pending:1", "idle:4"]
          : ["pending:1", "idle:skeleton"],
      );
    });

    test(`${variant}: a newer click ends the earlier link's pending at once`, async ({
      page,
    }) => {
      await open(page, variant);
      if (variant === "vt") {
        // The earlier link's page is handed to React, which holds it.
        await clickAndHold(page, variant, "2");
      } else {
        await testId(page, "opt-settle-to-2").click();
      }
      await expect(testId(page, "opt-settle-spinner-2")).toHaveText("…");
      await testId(page, "opt-settle-to-3").click();
      // On the page being left: the earlier link ends, the newer is pending.
      await expect(testId(page, "opt-settle-spinner-2")).toHaveText("");
      await expect(testId(page, "opt-settle-spinner-3")).toHaveText("…");
      await expect(testId(page, "opt-settle-page")).toHaveText(
        "3",
        PAGE_TIMEOUT,
      );
      await settle(page);
      expect((await spinner(page, "2")).slice(0, 2)).toEqual([
        "pending:1",
        "idle:1",
      ]);
      expect(await spinner(page, "3")).toEqual(
        variant === "vt"
          ? ["pending:1", "idle:3"]
          : ["pending:1", "idle:skeleton"],
      );
    });
  }

  test("vt: Back while a page is held ends its link's pending", async ({
    page,
  }) => {
    await open(page, "vt");
    await clickAndHold(page, "vt", "2");
    await expect(testId(page, "opt-settle-spinner-2")).toHaveText("…");
    await page.goBack();
    await expect(page).toHaveURL(/\/opt-settle\/vt\/1$/);
    await expect(testId(page, "opt-settle-spinner-2")).toHaveText("");
    await settle(page);
    expect(await spinner(page, "2")).toEqual(["pending:1", "idle:1"]);
    await expect(testId(page, "opt-settle-page")).toHaveText("1");
  });

  test("vt: a navigation whose page fails ends its link's pending with the error", async ({
    page,
  }) => {
    await open(page, "vt");
    await testId(page, "opt-settle-to-f").click();
    await expect(testId(page, "opt-settle-error")).toBeVisible(PAGE_TIMEOUT);
    await settle(page);
    expect(await spinner(page, "f")).toEqual(["pending:1", "idle:error"]);
  });

  test("vt: a second click while a page is held, to a link with a useLinkStatus reader, animates the page with push", async ({
    page,
  }) => {
    const before = await open(page, "vt");
    await clickAndHold(page, "vt", "2");
    await testId(page, "opt-settle-to-3").click();
    await expect(testId(page, "opt-settle-page")).toHaveText("3", PAGE_TIMEOUT);
    await settle(page);
    expect(await animated(page)).toEqual(["update:3:push,navigation"]);
    expect(await transitionsSince(page, before)).not.toContain("");
  });

  test("vt: a second click while a page is held, to a link with no useLinkStatus reader, animates the page with push", async ({
    page,
  }) => {
    const before = await open(page, "vt");
    await clickAndHold(page, "vt", "2");
    await testId(page, "opt-settle-to-4").click();
    await expect(testId(page, "opt-settle-page")).toHaveText("4", PAGE_TIMEOUT);
    await settle(page);
    expect(await animated(page)).toEqual(["update:4:push,navigation"]);
    expect(await transitionsSince(page, before)).not.toContain("");
  });

  test("vt: a server action started before the hand-over, whose refetch runs while the page is held, leaves the link pending until its page shows", async ({
    page,
  }) => {
    const before = await open(page, "vt");
    await testId(page, "opt-settle-to-2").click();
    // On the page being left: the action's answer finds the URL moved, and
    // the router refetches the new page in the background while React still
    // holds it.
    await testId(page, "opt-settle-save").click();
    await expect(testId(page, "opt-settle-page")).toHaveText("2", PAGE_TIMEOUT);
    await expect(testId(page, "opt-settle-save")).toHaveText(
      "save:idle",
      PAGE_TIMEOUT,
    );
    await settle(page);
    expect(await spinner(page, "2")).toEqual(["pending:1", "idle:2"]);
    expect(
      (await animated(page)).filter((entry) => entry.includes(":2:"))[0],
    ).toBe("update:2:push,navigation");
    expect(await transitionsSince(page, before)).not.toContain("");
  });

  test("vt: a server action while a page is held leaves the page its push animation and starts no view transition without types", async ({
    page,
  }) => {
    const before = await open(page, "vt");
    await clickAndHold(page, "vt", "2");
    await testId(page, "opt-settle-save").click();
    await expect(testId(page, "opt-settle-save")).not.toHaveText("save:idle");
    await expect(testId(page, "opt-settle-page")).toHaveText("2", PAGE_TIMEOUT);
    await expect(testId(page, "opt-settle-save")).toHaveText(
      "save:idle",
      PAGE_TIMEOUT,
    );
    await settle(page);
    expect(
      (await animated(page)).filter((entry) => entry.includes(":2:")),
    ).toEqual(["update:2:push,navigation"]);
    expect(await transitionsSince(page, before)).not.toContain("");
    // The action's refetch is no newer navigation: the link waits for its page.
    expect(await spinner(page, "2")).toEqual(["pending:1", "idle:2"]);
  });
}
