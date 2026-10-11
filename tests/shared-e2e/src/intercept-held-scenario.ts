import { expect, test, type Page } from "@playwright/test";

/**
 * Intercept slot contracts in the live lane. Fixture: intercept-held* in each
 * app, a layout with a @modal slot and five intercepted routes opened from
 * its index page. Both apps call this from a dev and a (production) describe.
 *
 * 1. A modal whose loaders all skip revalidate() keeps its loader data when a
 *    server action is called from it: resolveInterceptEntry sends the slot
 *    with an empty loader aggregate, which the browser's reconcile merges
 *    into the one it holds. The handler re-ran, and its render applies, held
 *    loaders or not (browser/merge-segment-loaders.ts). Userland pin (router
 *    package):
 *    src/testing/__tests__/serve-shell-request-intercept-held-loaders.rsc-test.tsx.
 * 2. A handle pushed from an intercept's loader or handler is filed under the
 *    slot's segment id (resolveInterceptEntry pins `_currentSegmentId`), so
 *    it reaches the page when the modal opens over segments the client holds.
 *    Userland pin:
 *    src/testing/__tests__/serve-shell-request-intercept-handle-owner.rsc-test.tsx.
 */

export interface InterceptHeldScenarioOptions {
  url: (pathname: string) => string;
  /** Path of the fixture's index page (the layout's "/" route). */
  basePath: string;
}

export function runInterceptHeldTests(
  options: InterceptHeldScenarioOptions,
): void {
  async function openModal(page: Page, link: string, modal: string) {
    await page.goto(options.url(options.basePath));
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await page.getByTestId(link).click();
    await expect(page.getByTestId(modal)).toBeVisible();
  }

  /** The modal as it was opened: the handler's render and the loader's run. */
  async function readModal(page: Page) {
    return {
      renders: await page.getByTestId("ih-modal-renders").innerText(),
      runs: await page.getByTestId("ih-modal-runs").innerText(),
    };
  }

  async function callActionFromModal(page: Page) {
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        "rsc-action" in response.request().headers(),
    );
    await page.getByTestId("ih-modal-action").click();
    await answered;
  }

  test("control: a modal whose loader follows the default re-runs it across a server action", async ({
    page,
  }) => {
    await openModal(page, "ih-open-rerun", "ih-modal");
    const before = await readModal(page);

    await callActionFromModal(page);

    await expect(page.getByTestId("ih-modal-renders")).not.toHaveText(
      before.renders,
    );
    await expect(page.getByTestId("ih-modal-runs")).not.toHaveText(before.runs);
    await expect(page.getByTestId("ih-modal")).toBeVisible();
  });

  test("a modal whose loaders all skip revalidate() keeps its loader data across a server action", async ({
    page,
  }) => {
    await openModal(page, "ih-open-loader", "ih-modal");
    const before = await readModal(page);

    await callActionFromModal(page);

    // The handler re-ran (the response was applied), the loader did not.
    await expect(page.getByTestId("ih-modal-renders")).not.toHaveText(
      before.renders,
    );
    await expect(page.getByTestId("ih-modal-runs")).toHaveText(before.runs);
  });

  test("a modal with one held loader and one re-run shows the handler's re-render and both loaders' data", async ({
    page,
  }) => {
    await openModal(page, "ih-open-mixed", "ih-modal");
    const before = await readModal(page);
    const rerunBefore = await page
      .getByTestId("ih-modal-rerun-runs")
      .innerText();

    await callActionFromModal(page);

    await expect(page.getByTestId("ih-modal-renders")).not.toHaveText(
      before.renders,
    );
    await expect(page.getByTestId("ih-modal-rerun-runs")).not.toHaveText(
      rerunBefore,
    );
    await expect(page.getByTestId("ih-modal-runs")).toHaveText(before.runs);
  });

  test("a handle pushed by an intercept's loader reaches the page", async ({
    page,
  }) => {
    await openModal(page, "ih-open-push", "ih-push-modal");

    await expect(
      page.getByTestId("ih-crumb").filter({ hasText: "modal-loader:1" }),
    ).toHaveCount(1);
  });

  test("a handle pushed by an intercept's handler reaches the page", async ({
    page,
  }) => {
    await openModal(page, "ih-open-handler", "ih-handler-modal");

    await expect(
      page.getByTestId("ih-crumb").filter({ hasText: "modal-handler:1" }),
    ).toHaveCount(1);
  });
}
