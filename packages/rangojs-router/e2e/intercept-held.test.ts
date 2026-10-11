import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { testId, waitForHydration } from "./helper";

/**
 * Two known gaps in the live intercept lane. Fixture:
 * test-app/src/urls/intercept-held.tsx.
 *
 * 1. A modal whose loaders all skip revalidate() loses its loader boundary
 *    when a server action is called from it: resolveInterceptEntry sends the slot
 *    with `loaderIds: undefined`, the browser's reconcile replaces the cached
 *    aggregate with it, and the modal's useLoader() throws. Userland pin:
 *    src/testing/__tests__/serve-shell-request-intercept-held-loaders.rsc-test.tsx.
 * 2. resolveInterceptEntry never pins `_currentSegmentId`, so a handle push
 *    from an intercept's loader is dropped and one from its handler throws
 *    ("used outside of handler context") when the client holds the page's
 *    segments. Userland pin:
 *    src/testing/__tests__/serve-shell-request-intercept-handle-owner.rsc-test.tsx.
 *
 * Every test is `test.fail`: it stays green while the gap exists and turns red
 * the moment the behavior is fixed; drop the annotation then.
 */

const HELD_LOADER_GAP =
  "KNOWN GAP: a held intercept slot whose loaders all skip revalidate() is sent with no loader aggregate";
const HANDLE_OWNER_GAP =
  "KNOWN GAP: resolveInterceptEntry never pins _currentSegmentId, so an intercept's handle pushes are lost";

function interceptHeldTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`intercept slot gaps (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    async function openModal(page: Page, link: string, modal: string) {
      await page.goto(f.url("/intercept-held"));
      await waitForHydration(page);
      await testId(page, link).click();
      await expect(testId(page, modal)).toBeVisible();
    }

    /** The modal as it was opened: the handler's render and the loader's run. */
    async function readHeldModal(page: Page) {
      return {
        renders: await testId(page, "ih-modal-renders").innerText(),
        runs: await testId(page, "ih-modal-runs").innerText(),
      };
    }

    async function callActionFromModal(page: Page) {
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          "rsc-action" in response.request().headers(),
      );
      await testId(page, "ih-modal-action").click();
      await answered;
    }

    async function expectModalHeldOnItsLoaderData(
      page: Page,
      before: { renders: string; runs: string },
    ) {
      // The handler re-ran (the response was applied), the loader did not.
      await expect(testId(page, "ih-modal-renders")).not.toHaveText(
        before.renders,
      );
      await expect(testId(page, "ih-modal-runs")).toHaveText(before.runs);
    }

    test("control: a modal whose loader follows the default re-runs it across a server action", async ({
      page,
    }) => {
      await openModal(page, "ih-open-rerun", "ih-modal");
      const before = await readHeldModal(page);

      await callActionFromModal(page);

      await expect(testId(page, "ih-modal-renders")).not.toHaveText(
        before.renders,
      );
      await expect(testId(page, "ih-modal-runs")).not.toHaveText(before.runs);
      await expect(testId(page, "ih-modal")).toBeVisible();
    });

    test("a modal whose loaders all skip revalidate() keeps its loader data across a server action", async ({
      page,
    }) => {
      test.fail(true, HELD_LOADER_GAP);
      await openModal(page, "ih-open-loader", "ih-modal");
      const before = await readHeldModal(page);

      await callActionFromModal(page);

      await expectModalHeldOnItsLoaderData(page, before);
    });

    test("a handle pushed by an intercept's loader reaches the page", async ({
      page,
    }) => {
      test.fail(true, HANDLE_OWNER_GAP);
      await openModal(page, "ih-open-push", "ih-push-modal");

      await expect(
        testId(page, "ih-crumb").filter({ hasText: "modal-loader:1" }),
      ).toHaveCount(1);
    });

    test("a handle pushed by an intercept's handler reaches the page", async ({
      page,
    }) => {
      test.fail(true, HANDLE_OWNER_GAP);
      await openModal(page, "ih-open-handler", "ih-handler-modal");

      await expect(
        testId(page, "ih-crumb").filter({ hasText: "modal-handler:1" }),
      ).toHaveCount(1);
    });
  });
}

interceptHeldTests("dev");
interceptHeldTests("build");
