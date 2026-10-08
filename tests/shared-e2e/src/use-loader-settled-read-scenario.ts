import { expect, test, type Page } from "@playwright/test";
import { readProbe, watchFlash } from "./flash-probe.js";

// Why every useLoader read with route context calls use(): src/use-loader.tsx.
// Fixture: held-boundary.tsx in each app (/settled-read hub and page). React
// logs the warning in development only, so a production describe pins the
// same flows' value and the absence of a fallback instead.

export interface UseLoaderSettledReadScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  production: boolean;
}

const CONDITIONAL_USE = "did not call use() when it finished";
const RUN_VALUE = /^settled-read-run-\d+$/;

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

function readCommits(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __settledReadCommits?: number })
        .__settledReadCommits ?? 0,
  );
}

function trackConditionalUse(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes(CONDITIONAL_USE)) seen.push(text);
  });
  return seen;
}

// Enters the page by a client navigation: the reader mounts while the 400 ms
// loader streams, behind the route's loading() fallback.
async function enterStreaming(
  page: Page,
  options: UseLoaderSettledReadScenarioOptions,
): Promise<string> {
  await page.goto(options.url("/settled-read"));
  await options.waitForHydration(page);
  await testId(page, "settled-read-hub-link").click();
  const value = testId(page, "settled-read-value");
  await expect(value).toHaveText(RUN_VALUE);
  return (await value.textContent()) ?? "";
}

export function runUseLoaderSettledReadTests(
  options: UseLoaderSettledReadScenarioOptions,
): void {
  const { production } = options;
  const suffix = production ? "" : " and logs no conditional use()";

  test(`useLoader reader mounted on a stream, then rendered settled by a click to the page already shown: keeps the value with no fallback${suffix}`, async ({
    page,
  }) => {
    const conditionalUse = trackConditionalUse(page);
    const first = await enterStreaming(page, options);
    const value = testId(page, "settled-read-value");

    await watchFlash(page, "settled-read-fallback", ["settled-read-value"]);
    // The value on screen is the same before and after the click, so the
    // reader's commit counter (held-boundary.client.tsx) marks the render.
    const commits = await readCommits(page);
    await testId(page, "settled-read-self-link").click();
    await expect.poll(() => readCommits(page)).toBeGreaterThan(commits);
    await expect(value).toHaveText(first);

    const seen = await readProbe(page);
    expect(seen.installed, "the flash probe is still installed").toBe(true);
    expect(seen.flash, "no loading() fallback on the page already shown").toBe(
      false,
    );
    expect(
      conditionalUse,
      "React must not log a conditional use() for a useLoader read",
    ).toEqual([]);
  });

  test(`useLoader reader mounted on a stream, then rendered settled by back through the history to the page: reads the value${suffix}`, async ({
    page,
  }) => {
    const conditionalUse = trackConditionalUse(page);
    await enterStreaming(page, options);

    await testId(page, "settled-read-to-hub").click();
    await expect(testId(page, "settled-read-hub")).toBeVisible();
    await page.goBack();
    await expect(testId(page, "settled-read-hub")).toBeHidden();
    await expect(testId(page, "settled-read-value")).toHaveText(RUN_VALUE);

    expect(
      conditionalUse,
      "React must not log a conditional use() for a useLoader read",
    ).toEqual([]);
  });
}
