import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A route's loader, held on every partial (`loader(L, () =>
 * [revalidate(() => false)])`), and a child layout with a parallel slot that
 * reads it through useLoader(). With no route loading() fallback the
 * layout's inherited copy of the loader is redundant, so no request sends
 * it. It used to be resolved on every request and dropped only beside the
 * route's own copy: an action or a same-route navigation, which hold the
 * route's loader, re-ran the copy alone. The layout gained a loader entry
 * (StreamedLoaderErrorBoundary, segment-system.tsx) and remounted, and Back
 * remounted it again.
 *
 * Fixture, in each app: /parallel-loader-inherit-held-loader (no loading())
 * and /parallel-loader-inherit-held-loader-off (loading(false)). The route
 * renders its run count and the `x` search param, and links to `?x=2`; the
 * layout keeps a click count in local state, which a remount resets, and an
 * action button. Both apps call this from a dev and a (production) describe.
 */

export interface ParallelLoaderInheritHeldScenarioOptions {
  url: (pathname: string) => string;
}

async function rendersOf(page: Page): Promise<number> {
  return Number(await page.getByTestId("pli-renders").textContent());
}

async function layoutKeepsItsState(
  page: Page,
  options: ParallelLoaderInheritHeldScenarioOptions,
  pathname: string,
): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(options.url(pathname));
  await waitForShellHydration(page);
  await expect(page.getByTestId("inherit-probe-runs")).toHaveText(/^\d+$/);
  const runs = await page.getByTestId("inherit-probe-runs").textContent();

  await page.getByTestId("inherit-probe-click").click();
  await expect(page.getByTestId("inherit-probe-clicks")).toHaveText("1");

  // The action's revalidation re-runs the route's handler and holds its loader.
  const before = await rendersOf(page);
  await page.getByTestId("inherit-probe-action").click();
  await expect.poll(() => rendersOf(page)).toBeGreaterThan(before);
  await expect(page.getByTestId("inherit-probe-clicks")).toHaveText("1");
  await expect(page.getByTestId("inherit-probe-runs")).toHaveText(runs!);

  // A same-route navigation holds the loader too.
  await page.getByTestId("pli-nav").click();
  await expect(page.getByTestId("pli-x")).toHaveText("2");
  await expect(page.getByTestId("inherit-probe-clicks")).toHaveText("1");
  await expect(page.getByTestId("inherit-probe-runs")).toHaveText(runs!);

  await page.goBack();
  await expect(page.getByTestId("pli-x")).toHaveText("");
  await expect(page.getByTestId("inherit-probe-clicks")).toHaveText("1");
  await expect(page.getByTestId("inherit-probe-runs")).toHaveText(runs!);

  expect(errors).toEqual([]);
}

export function runParallelLoaderInheritHeldTests(
  options: ParallelLoaderInheritHeldScenarioOptions,
): void {
  test("held route loader, no loading(): the layout keeps its state across an action, a same-route navigation and Back", async ({
    page,
  }) => {
    await layoutKeepsItsState(
      page,
      options,
      "/parallel-loader-inherit-held-loader",
    );
  });

  test("held route loader, loading(false): the layout keeps its state across an action, a same-route navigation and Back", async ({
    page,
  }) => {
    await layoutKeepsItsState(
      page,
      options,
      "/parallel-loader-inherit-held-loader-off",
    );
  });
}
