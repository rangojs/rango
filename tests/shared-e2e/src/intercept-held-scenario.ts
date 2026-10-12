import { expect, test, type Page } from "@playwright/test";

/**
 * Intercept slot contracts in the live lane. Fixture: intercept-held* in each
 * app, a layout with a @modal slot and five intercepted routes opened from
 * its index page. Both apps call this from a dev and a (production) describe.
 *
 * 1. A modal whose loaders skip revalidate() keeps their data when a server
 *    action is called from it, or when a link in it opens another intercepted
 *    route whose modal reads them: an intercept's loaders are loader segments
 *    of its slot, each revalidated on its own, and the browser keeps the ones
 *    the server skipped (segment-system.tsx foldInterceptLoaders folds them
 *    onto the slot). The handler re-ran, and its render applies. Userland
 *    pins (router package):
 *    src/testing/__tests__/serve-shell-request-intercept-held-loaders.rsc-test.tsx,
 *    src/testing/__tests__/prefetch-false-intercept.rsc-test.tsx.
 * 2. A handle pushed from an intercept's loader or handler is filed under the
 *    slot's segment id (resolveInterceptEntry pins `_currentSegmentId`), so
 *    it reaches the page when the modal opens over segments the client holds.
 *    A held loader's push stays when an action re-runs the slot's handler
 *    alone (handles/pushed-by.ts: `matched` lists the loader segment). Userland
 *    pins: src/testing/__tests__/serve-shell-request-intercept-handle-owner.rsc-test.tsx,
 *    src/testing/__tests__/prefetch-false-intercept.rsc-test.tsx.
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

  test("a link in the open modal to another intercepted route keeps the data of a loader both modals read and neither re-runs", async ({
    page,
  }) => {
    await openModal(page, "ih-open-mixed", "ih-modal");
    const before = await readModal(page);

    await page.getByTestId("ih-modal-to-loader").click();

    await expect(page).toHaveURL(/\/intercept-held\/loader\/1$/);
    await expect(page.getByTestId("ih-modal")).toBeVisible();
    await expect(page.getByTestId("ih-modal-rerun-runs")).toHaveCount(0);
    // The held-loader modal's handler rendered, with the held loader's data.
    await expect(page.getByTestId("ih-modal-renders")).not.toHaveText(
      before.renders,
    );
    await expect(page.getByTestId("ih-modal-runs")).toHaveText(before.runs);
    await expect(page.getByTestId("ih-index")).toBeVisible();
  });

  test("a held intercept loader's handle push stays when an action re-runs the slot's handler", async ({
    page,
  }) => {
    await openModal(page, "ih-open-push-held", "ih-held-push-modal");
    const crumb = (text: string) =>
      page.getByTestId("ih-crumb").filter({ hasText: new RegExp(`^${text}$`) });
    const renders = page.getByTestId("ih-held-push-renders");
    const opened = await renders.innerText();
    await expect(crumb(`held-handler:1:${opened}`)).toHaveCount(1);
    await expect(crumb("held-loader:1")).toHaveCount(1);

    await callActionFromModal(page);

    // The handler re-ran: the action's response was applied.
    await expect(renders).not.toHaveText(opened);
    // The handler's push from that run replaced its first one: the action's
    // handle stream has merged.
    await expect(
      crumb(`held-handler:1:${await renders.innerText()}`),
    ).toHaveCount(1);
    await expect(crumb(`held-handler:1:${opened}`)).toHaveCount(0);
    await expect(crumb("held-loader:1")).toHaveCount(1);
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
