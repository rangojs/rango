import { expect, test, type Page } from "@playwright/test";

/**
 * useLinkStatus() marks the link that was clicked, not every link to the
 * same address; a navigation no link started marks every link to its URL.
 *
 * Fixture in each app: the /opt-settle/<variant>/:id shell (test-app
 * urls/optimistic-settle.tsx, cloudflare-basic pages/optimistic-settle.tsx),
 * described in optimistic-settle-scenario.ts. Links 2 and 2b both go to page
 * 2, links r and rb both to r, which redirects to page 4; each carries a
 * useLinkStatus() spinner. The push button calls useRouter().push to page 2.
 * Every request waits 400 ms and a page 1500 ms more, so the pending frame
 * lasts long enough to read.
 *
 * - window.__optSettleLog: every commit of a spinner,
 *   "<link>:<pending|idle>:<page on screen>".
 */

export interface LinkStatusClickedScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
}

type ProbeWindow = { __optSettleLog?: string[] };

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

/** Spinner `id`'s commits, as "<pending|idle>:<page on screen>", deduplicated. */
async function spinner(page: Page, id: string): Promise<string[]> {
  const log = await page.evaluate(
    () => (window as unknown as ProbeWindow).__optSettleLog ?? [],
  );
  return log
    .filter((entry) => entry.startsWith(`${id}:`))
    .map((entry) => entry.slice(id.length + 1))
    .filter((entry, i, all) => all[i - 1] !== entry);
}

export function runLinkStatusClickedTests(
  options: LinkStatusClickedScenarioOptions,
): void {
  const open = async (page: Page, variant: string): Promise<void> => {
    await page.goto(options.url(`/opt-settle/${variant}/1`));
    await options.waitForHydration(page);
    await expect(testId(page, "opt-settle-page")).toHaveText("1");
    await settle(page);
    await page.evaluate(() => {
      (window as unknown as ProbeWindow).__optSettleLog = [];
    });
  };

  for (const variant of ["vt", "none"] as const) {
    test(`${variant}: of two links to one address, a click marks only the clicked one until its page shows`, async ({
      page,
    }) => {
      await open(page, variant);
      await testId(page, "opt-settle-to-2b").click();
      await expect(testId(page, "opt-settle-spinner-2b")).toHaveText("…");
      // Read once, not retried: both links take a match in the same commit.
      expect(await testId(page, "opt-settle-spinner-2").textContent()).toBe("");
      await expect(testId(page, "opt-settle-page")).toHaveText(
        "2",
        PAGE_TIMEOUT,
      );
      await settle(page);
      expect(await spinner(page, "2b")).toEqual(
        variant === "vt"
          ? ["pending:1", "idle:2"]
          : ["pending:1", "idle:skeleton"],
      );
      expect(await spinner(page, "2")).not.toContain("pending:1");
    });

    test(`${variant}: of two links to a redirecting address, the clicked one stays pending through the redirect alone`, async ({
      page,
    }) => {
      await open(page, variant);
      await testId(page, "opt-settle-to-rb").click();
      await expect(testId(page, "opt-settle-page")).toHaveText(
        "4",
        PAGE_TIMEOUT,
      );
      await expect(page).toHaveURL(new RegExp(`/opt-settle/${variant}/4$`));
      await settle(page);
      expect(await spinner(page, "rb")).toEqual(
        variant === "vt"
          ? ["pending:1", "idle:4"]
          : ["pending:1", "idle:skeleton"],
      );
      expect(await spinner(page, "r")).not.toContain("pending:1");
    });
  }

  test("vt: a click on the other link to the same address moves the mark to it", async ({
    page,
  }) => {
    await open(page, "vt");
    await testId(page, "opt-settle-to-2").click();
    await expect(testId(page, "opt-settle-spinner-2")).toHaveText("…");
    await testId(page, "opt-settle-to-2b").click();
    await expect(testId(page, "opt-settle-spinner-2b")).toHaveText("…");
    expect(await testId(page, "opt-settle-spinner-2").textContent()).toBe("");
    await expect(testId(page, "opt-settle-page")).toHaveText("2", PAGE_TIMEOUT);
    await settle(page);
    // Link 2 ends at the second click, on the page being left.
    expect((await spinner(page, "2")).slice(0, 2)).toEqual([
      "pending:1",
      "idle:1",
    ]);
    expect(await spinner(page, "2b")).toEqual(["pending:1", "idle:2"]);
  });

  test("vt: useRouter().push, which no link started, marks every link to its URL", async ({
    page,
  }) => {
    await open(page, "vt");
    await testId(page, "opt-settle-push-2").click();
    await expect(testId(page, "opt-settle-spinner-2")).toHaveText("…");
    await expect(testId(page, "opt-settle-spinner-2b")).toHaveText("…");
    await expect(testId(page, "opt-settle-page")).toHaveText("2", PAGE_TIMEOUT);
    await settle(page);
    expect(await spinner(page, "2")).toEqual(["pending:1", "idle:2"]);
    expect(await spinner(page, "2b")).toEqual(["pending:1", "idle:2"]);
  });
}
