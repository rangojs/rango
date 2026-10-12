import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expectConsole } from "./console-guard.js";

/**
 * A loader that fails on its rerun after a server action (#1106, dc-t28). The
 * action itself succeeds; the page's loader then throws once (`/throw`, and
 * under a `loading()` at `/throw-loading`) or returns the failure as data
 * (`/data`). Fixture: action-failure* in each app, a clientUrls() group, its
 * urls() twin, and the group mounted a second time under an
 * `errorBoundary()`, whose layout holds controls of its own. The throw page
 * reads the loader inside the app's own error boundary, next to a draft
 * input (a form's React state), an outcome line (what the action call
 * resolved or rejected with, also on `<html data-af-outcome>`), the last
 * `revalidationError` useAction reported, buttons that call the action
 * directly or together with a slow one, and a `<form action>` that submits
 * it; `bare` in the URL drops the app's boundary. A `run` search param per
 * test scopes the fixture's failure switch and run counters. Both apps call
 * this from a dev and a (production) describe.
 *
 * The contract: the call resolves with the action's result, the loader
 * throws in place at its useLoader read, the nearest boundary to the read
 * catches it (the app's, else the errorBoundary(), else the router's root
 * one), useAction(action).revalidationError reports it, and what sits
 * outside that boundary keeps its instance and state.
 */

export interface ActionFailureScenarioOptions {
  url: (pathname: string) => string;
  /** Mount of the clientUrls() group. */
  clientPath: string;
  /** Mount of the urls() twin. */
  serverPath: string;
  /** Mount of the group under an errorBoundary(). */
  boundedPath: string;
  /** A build: an error's message reaches the browser as "An error occurred". */
  production: boolean;
}

async function open(
  page: Page,
  url: (pathname: string) => string,
  pathname: string,
  query = "",
): Promise<void> {
  await page.goto(url(`${pathname}?run=${randomUUID()}${query}`));
  await expect(page.getByTestId("af-page")).toBeVisible();
  await page.waitForFunction(() =>
    document.documentElement.hasAttribute("data-hydrated"),
  );
}

/** Marks an element; a remount drops the mark. */
async function mark(page: Page, testId: string): Promise<void> {
  await page
    .getByTestId(testId)
    .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
}

async function expectKept(page: Page, testId: string): Promise<void> {
  await expect(page.getByTestId(testId)).toHaveAttribute("data-e2e-kept", "1");
}

export function runActionFailureTests(
  options: ActionFailureScenarioOptions,
): void {
  const reported = (run: number): string =>
    options.production
      ? "An error occurred"
      : `stock service unavailable (run ${run})`;

  const inPlace = [
    { name: "clientUrls() group", path: `${options.clientPath}/throw` },
    {
      name: "clientUrls() group with loading()",
      path: `${options.clientPath}/throw-loading`,
    },
    { name: "urls() route", path: `${options.serverPath}/throw` },
    {
      name: "urls() route with loading()",
      path: `${options.serverPath}/throw-loading`,
    },
    // The app's boundary at the read is nearer than the errorBoundary().
    {
      name: "clientUrls() group under errorBoundary()",
      path: `${options.boundedPath}/throw`,
    },
  ];

  /**
   * After the failing action: the call resolved, the app's boundary at the
   * read shows the loader's error, useAction reported it, and the page
   * around the read kept its instance and the draft.
   */
  async function expectThrownInPlace(page: Page, run: number): Promise<void> {
    await expect(page.getByTestId("af-app-boundary")).toHaveText(reported(run));
    await expect(page.getByTestId("af-value")).toHaveCount(0);
    await expect(page.getByTestId("af-revalidation-error")).toHaveText(
      reported(run),
    );
    await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
    await expectKept(page, "af-page");
    await expectKept(page, "af-draft");
    await expect(page.getByTestId("af-error-boundary")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Internal Server Error" }),
    ).toHaveCount(0);
  }

  async function openMarked(page: Page, pathname: string): Promise<void> {
    await open(page, options.url, pathname);
    await expect(page.getByTestId("af-value")).toHaveText("stock:1");
    await page.getByTestId("af-draft").fill("kept draft");
    await mark(page, "af-page");
    await mark(page, "af-draft");
  }

  for (const variant of inPlace) {
    test(`${variant.name}: a loader that throws on its rerun after an action throws at its read, where the app's boundary catches it; the call resolves, useAction reports it, and a later action recovers in place`, async ({
      page,
    }) => {
      await openMarked(page, variant.path);

      await page.getByTestId("af-fail").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:failing",
      );
      await expectThrownInPlace(page, 2);

      await page.getByTestId("af-recover").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:recovered",
      );
      await expect(page.getByTestId("af-value")).toHaveText("stock:3");
      await expect(page.getByTestId("af-app-boundary")).toHaveCount(0);
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
      await expectKept(page, "af-page");
    });

    test(`${variant.name}: a form action whose loader rerun throws shows the error at the read, keeps the form's state, and reports it`, async ({
      page,
    }) => {
      await openMarked(page, variant.path);

      await page.getByTestId("af-fail-form").click();
      await expectThrownInPlace(page, 2);
    });

    // The fast action's answer lands while the slow one is still fetching,
    // and the slow one refetches for both; the loader throws on every run
    // until the switch goes off: run 2 on the fast answer, 3 on the slow
    // one, 4 on the refetch, whose commit is the one on screen. The fast
    // answer is never rendered and reports nothing; the slow action, whose
    // refetch ran, reports run 4.
    test(`${variant.name}: two overlapping actions whose refetch's loader throws both resolve, show the error at the read, and the refetching action reports it`, async ({
      page,
    }) => {
      await openMarked(page, variant.path);

      await page.getByTestId("af-fail-concurrent").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:failing,slow",
      );
      await expect(page.getByTestId("af-slow-revalidation-error")).toHaveText(
        reported(4),
      );
      await expect(page.getByTestId("af-app-boundary")).toHaveText(reported(4));
      await expect(page.getByTestId("af-revalidation-error")).toHaveText(
        "none",
      );
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
      await expectKept(page, "af-page");

      await page.getByTestId("af-recover").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:recovered",
      );
      await expect(page.getByTestId("af-value")).toHaveText("stock:5");
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
      await expectKept(page, "af-page");
    });

    test(`${variant.name}: a successful action reruns the loader without remounting the route`, async ({
      page,
    }) => {
      await openMarked(page, variant.path);

      await page.getByTestId("af-recover").click();
      await expect(page.getByTestId("af-outcome")).toHaveText(
        "resolved:recovered",
      );
      await expect(page.getByTestId("af-value")).toHaveText("stock:2");
      await expect(page.getByTestId("af-revalidation-error")).toHaveText(
        "none",
      );
      await expectKept(page, "af-page");
      await expectKept(page, "af-draft");
      await expect(page.getByTestId("af-draft")).toHaveValue("kept draft");
    });
  }

  /** The bounded mount with no app boundary at the read. */
  async function openBare(page: Page): Promise<void> {
    await open(page, options.url, `${options.boundedPath}/throw`, "&bare");
    await expect(page.getByTestId("af-value")).toHaveText("stock:1");
    await page.getByTestId("af-bounded-draft").fill("kept draft");
    await mark(page, "af-bounded-controls");
  }

  async function expectBoundedFallbackClears(page: Page): Promise<void> {
    await page.getByTestId("af-bounded-recover").click();
    await expect(page.getByTestId("af-bounded-outcome")).toHaveText(
      "resolved:recovered",
    );
    await expect(page.getByTestId("af-error-boundary")).toHaveCount(0);
    await expect(page.getByTestId("af-value")).toHaveText("stock:2");
    await expect(page.getByTestId("af-bounded-draft")).toHaveValue(
      "kept draft",
    );
    await expectKept(page, "af-bounded-controls");
  }

  test("clientUrls() group under errorBoundary() with no app boundary at the read: a loader that throws on its rerun after an action shows the errorBoundary() fallback in place of the group, and a later action whose rerun succeeds clears it", async ({
    page,
  }) => {
    await openBare(page);

    await page.getByTestId("af-fail").click();
    await expect(page.getByTestId("af-error-boundary")).toBeVisible();
    await expect(page.getByTestId("af-page")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-af-outcome",
      "resolved:failing",
    );
    await expectKept(page, "af-bounded-controls");

    // Run 3 succeeds: the boundary holding the fallback resets on the new
    // loader data.
    await page.getByTestId("af-bounded-recover").click();
    await expect(page.getByTestId("af-bounded-outcome")).toHaveText(
      "resolved:recovered",
    );
    await expect(page.getByTestId("af-error-boundary")).toHaveCount(0);
    await expect(page.getByTestId("af-value")).toHaveText("stock:3");
    await expect(page.getByTestId("af-bounded-draft")).toHaveValue(
      "kept draft",
    );
    await expectKept(page, "af-bounded-controls");
  });

  test("clientUrls() group under errorBoundary() with no app boundary at the read: an errorBoundary() fallback a navigation showed clears after an action whose rerun succeeds", async ({
    page,
  }) => {
    await openBare(page);

    // Same route and params, new run: its first loader run throws on the
    // navigation, at the read.
    await page.getByTestId("af-bounded-fail-nav").click();
    await expect(page.getByTestId("af-error-boundary")).toBeVisible();
    await expect(page.getByTestId("af-page")).toHaveCount(0);
    await expect(page).toHaveURL(/fail-first/);

    await expectBoundedFallbackClears(page);
  });

  for (const variant of [
    { name: "clientUrls() group", base: options.clientPath },
    { name: "urls() route", base: options.serverPath },
  ]) {
    test(`${variant.name} with no boundary at the read: a loader that throws on its rerun after an action reaches the router's root boundary, and the call resolves`, async ({
      page,
    }) => {
      expectConsole(page, { allow: [/\[RootErrorBoundary\]/] });
      await open(page, options.url, `${variant.base}/throw`, "&bare");
      await expect(page.getByTestId("af-value")).toHaveText("stock:1");

      await page.getByTestId("af-fail").click();
      await expect(
        page.getByRole("heading", { name: "Internal Server Error" }),
      ).toBeVisible();
      await expect(page.getByTestId("af-page")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute(
        "data-af-outcome",
        "resolved:failing",
      );
    });
  }

  // A delete action whose item loader then throws redirect(): the redirect
  // replaces only the route's content and navigates; the layout above keeps
  // its instance across the action and the navigation.
  test("urls() route: a loader that throws redirect() on its rerun after a delete action navigates to its target, and the layout keeps its instance", async ({
    page,
  }) => {
    // Known drift, as on main: the action lane plants LoaderRedirect as the
    // outlet's children in place of the StreamedLoaderErrorBoundary-wrapped
    // content (packages/rangojs-router/src/segment-system.tsx, the
    // `!isAction && isLoaderRedirectNode` sites), so the route's wrapper chain
    // loses a link while it redirects. The layout above is untouched.
    expectConsole(page, {
      allow: [
        /I5 drift at outlet:\S+: wrapper chain link \d+ changed from StreamedLoaderErrorBoundary to nothing/,
      ],
    });
    const run = randomUUID();
    await page.goto(options.url(`${options.serverPath}/items/7?run=${run}`));
    await expect(page.getByTestId("af-item-name")).toHaveText("item 7");
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await mark(page, "af-items-layout");

    await page.getByTestId("af-item-delete").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-af-outcome",
      "resolved:7",
    );
    await expect(page).toHaveURL(
      new RegExp(`${options.serverPath}/items\\?run=${run}$`),
    );
    await expect(page.getByTestId("af-items")).toBeVisible();
    await expect(page.getByTestId("af-item")).toHaveCount(0);
    await expectKept(page, "af-items-layout");
  });

  const data = [
    { name: "clientUrls() group", base: options.clientPath },
    { name: "urls() route", base: options.serverPath },
  ];

  for (const variant of data) {
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
      // Data, not an error: nothing to report.
      await expect(page.getByTestId("af-revalidation-error")).toHaveText(
        "none",
      );

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
}
