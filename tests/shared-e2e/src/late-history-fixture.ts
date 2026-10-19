import { expect, type Page } from "@playwright/test";

// Drives the late-history.tsx fixture each app ships (late-handle-history and
// redispatched-dom-content-loaded scenarios).
export interface LateHistoryFixtureOptions {
  url: (pathname: string) => string;
}

export async function gotoLateHistory(
  page: Page,
  options: LateHistoryFixtureOptions,
  search: string,
): Promise<void> {
  await page.goto(options.url(`/late-history/page?${search}`), {
    waitUntil: "commit",
  });
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-lh-mounted"),
  );
}

// Loads the fixture's modules once, so the timed load hydrates before its push.
export async function warmUp(
  page: Page,
  options: LateHistoryFixtureOptions,
): Promise<void> {
  await page.goto(options.url("/late-history/other"));
  await expect(page.getByTestId("lh-other")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-lh-mounted"),
  );
}
