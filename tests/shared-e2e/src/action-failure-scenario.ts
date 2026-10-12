import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expectConsole } from "./console-guard.js";

/**
 * A loader that fails on its rerun after a server action (#1106). The action
 * itself succeeds; the page's loader then throws (`/throw`) or returns the
 * failure as data (`/data`). Fixture: action-failure* in each app, a
 * clientUrls() group, its urls() twin, and the group mounted a second time
 * under an `errorBoundary()`. The page holds a draft input (a form's React
 * state), an outcome line (what the action call resolved or rejected with),
 * buttons that call the action directly and a `<form action>` that submits
 * it. A `run` search param per test scopes the fixture's failure switch and
 * run counters. Both apps call this from a dev and a (production) describe.
 */

export interface ActionFailureScenarioOptions {
  url: (pathname: string) => string;
  /** Mount of the clientUrls() group. */
  clientPath: string;
  /** Mount of the urls() twin. */
  serverPath: string;
  /** Mount of the group under an errorBoundary(). */
  boundedPath: string;
}

async function open(
  page: Page,
  url: (pathname: string) => string,
  pathname: string,
): Promise<void> {
  await page.goto(url(`${pathname}?run=${randomUUID()}`));
  await expect(page.getByTestId("af-page")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
}

export function runActionFailureTests(
  options: ActionFailureScenarioOptions,
): void {
  const variants = [
    { name: "clientUrls() group", base: options.clientPath },
    { name: "urls() route", base: options.serverPath },
  ];

  for (const variant of variants) {
    test(`${variant.name}: a loader that throws on its rerun after an action rejects the action call, and the page keeps its data and form state`, async ({
      page,
    }) => {
      await open(page, options.url, `${variant.base}/throw`);
      await expect(page.getByTestId("af-value")).toHaveText("stock:1");
      await page.getByTestId("af-draft").fill("kept draft");

      await page.getByTestId("af-fail").click();
      // The action ran and returned; its call rejects with the loader's
      // error, whose message a production build redacts.
      await expect(page.getByTestId("af-outcome")).toHaveText(
        /^rejected:(stock service unavailable \(run 2\)|An error occurred)$/,
      );
      // Nothing of that revalidation commits: the previous data stays.
      await expect(page.getByTestId("af-value")).toHaveText("stock:1");
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");

      // The next action reruns it. Its exact run varies: right after the
      // rejected call, that action can add a consolidation refetch.
      await page.getByTestId("af-recover").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:recovered",
      );
      await expect(page.getByTestId("af-value")).toHaveText(/^stock:[3-9]$/);
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
    });

    test(`${variant.name}: a form action whose loader rerun throws reaches the root error boundary, which replaces the page`, async ({
      page,
    }) => {
      // React hands a rejected form action to the nearest error boundary;
      // the fixture has none of its own, so the router's root boundary
      // catches it.
      expectConsole(page, { allow: [/\[RootErrorBoundary\]/] });
      await open(page, options.url, `${variant.base}/throw`);
      await page.getByTestId("af-draft").fill("lost draft");

      await page.getByTestId("af-fail-form").click();
      await expect(
        page.getByRole("heading", { name: "Internal Server Error" }),
      ).toBeVisible();
      await expect(page.getByTestId("af-page")).toHaveCount(0);
    });

    test(`${variant.name}: a loader that returns its failure as data keeps the page and its form state, and recovers`, async ({
      page,
    }) => {
      await open(page, options.url, `${variant.base}/data`);
      await expect(page.getByTestId("af-value")).toHaveText("price:1");
      await page.getByTestId("af-draft").fill("kept draft");

      await page.getByTestId("af-fail").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:failing",
      );
      await expect(page.getByTestId("af-failure")).toHaveText(
        "price service unavailable (run 2)",
      );
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");

      await page.getByTestId("af-recover").click();
      await expect(page.getByTestId("af-value")).toHaveText("price:3");
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");

      // A form action takes the same path: the failure renders in place.
      await page.getByTestId("af-fail-form").click();
      await expect(page.getByTestId("af-failure")).toHaveText(
        "price service unavailable (run 4)",
      );
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
    });

    test(`${variant.name}: a form's React state survives an action's revalidation`, async ({
      page,
    }) => {
      await open(page, options.url, `${variant.base}/data`);
      await expect(page.getByTestId("af-value")).toHaveText("price:1");
      await page.getByTestId("af-draft").fill("kept draft");

      await page.getByTestId("af-recover").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:recovered",
      );
      await expect(page.getByTestId("af-value")).toHaveText("price:2");
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
    });
  }

  test("clientUrls() group under errorBoundary(): a loader that throws on its rerun after an action renders the boundary in place of the route", async ({
    page,
  }) => {
    // The fallback replaces the route's subtree, the remount this test pins:
    // the dev suspense audit reports the wrapper it drops.
    expectConsole(page, {
      allow: [
        /I5 drift at outlet:\S+: wrapper chain link \d+ changed from StreamedLoaderErrorBoundary to nothing/,
      ],
    });
    await open(page, options.url, `${options.boundedPath}/throw`);
    await page.getByTestId("af-draft").fill("lost draft");

    await page.getByTestId("af-fail").click();
    await expect(page.getByTestId("af-error-boundary")).toBeVisible();
    await expect(page.getByTestId("af-page")).toHaveCount(0);
  });
}
