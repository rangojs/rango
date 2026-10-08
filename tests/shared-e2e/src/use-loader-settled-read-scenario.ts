import { expect, test, type Page } from "@playwright/test";

/**
 * A useLoader read that mounted while its loader streamed, rendered again
 * with the value settled, must call use() on both renders (src/use-loader.tsx).
 * React logs "called use() to suspend in a previous render but did not call
 * use() when it finished" in development otherwise; a build never logs it, so
 * the production describe pins the same flow's output instead. Fixture:
 * held-boundary.tsx in each app (/ulr hub, /ulr/a); both apps call this from
 * a dev and a (production) describe.
 */

export interface UseLoaderSettledReadScenarioOptions {
  url: (pathname: string) => string;
  waitForHydration: (page: Page) => Promise<void>;
  production: boolean;
}

const CONDITIONAL_USE = "did not call use() when it finished";
const VALUE = "ulr-loader-data";

const testId = (page: Page, id: string) =>
  page.locator(`[data-testid="${id}"]`);

function trackConditionalUse(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes(CONDITIONAL_USE)) seen.push(text);
  });
  return seen;
}

// Enters /ulr/a by a client navigation: the reader mounts while the 400 ms
// loader streams, behind the route's loading() fallback.
async function enterStreaming(
  page: Page,
  options: UseLoaderSettledReadScenarioOptions,
): Promise<void> {
  await page.goto(options.url("/ulr"));
  await options.waitForHydration(page);
  await testId(page, "ulr-hub-plain").click();
  await expect(testId(page, "ulr-value")).toHaveText(VALUE);
}

interface Flow {
  name: string;
  run: (
    page: Page,
    options: UseLoaderSettledReadScenarioOptions,
  ) => Promise<void>;
}

const FLOWS: Flow[] = [
  {
    name: "a plain click to the page already shown",
    run: async (page) => {
      await testId(page, "ulr-self-plain").click();
    },
  },
  {
    name: "back through the history to the page",
    run: async (page) => {
      await testId(page, "ulr-to-hub").click();
      await expect(testId(page, "ulr-hub")).toBeVisible();
      await page.goBack();
    },
  },
];

export function runUseLoaderSettledReadTests(
  options: UseLoaderSettledReadScenarioOptions,
): void {
  for (const flow of FLOWS) {
    test(`useLoader reader mounted on a stream, then rendered settled by ${flow.name}: reads the value${options.production ? "" : " and logs no conditional use()"}`, async ({
      page,
    }) => {
      const conditionalUse = trackConditionalUse(page);
      await enterStreaming(page, options);
      await flow.run(page, options);

      await expect(testId(page, "ulr-value")).toHaveText(VALUE);
      // Past React's 300 ms minimum fallback display and any trailing render.
      await page.waitForTimeout(800);
      await expect(testId(page, "ulr-value")).toHaveText(VALUE);
      await expect(testId(page, "ulr-fallback")).toHaveCount(0);
      expect(
        conditionalUse,
        "React must not log a conditional use() for a useLoader read",
      ).toEqual([]);
    });
  }
}
