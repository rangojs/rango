import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { expectNoPageError, prodDescribe, waitForHydration } from "./helper";

/**
 * /errors/revalidation: a Save action succeeds, and the stock loader its
 * revalidation reruns throws while the toggle is on (dc-t28). The action
 * resolves, the loader throws at its useLoader read, the nearest boundary
 * catches it (a local React ErrorBoundary, or the route's errorBoundary()),
 * useAction(saveNote).revalidationError reports it, the controls outside the
 * boundary keep their instance and the note, and a Save with the toggle off
 * clears the fallback.
 */

const variants = [
  {
    name: "urls() route with a local ErrorBoundary",
    path: "/errors/revalidation",
    fallback: "rv-local-fallback",
  },
  {
    name: "urls() route with loading() and a local ErrorBoundary",
    path: "/errors/revalidation/loading",
    fallback: "rv-local-fallback",
  },
  {
    name: "urls() route with its own errorBoundary()",
    path: "/errors/revalidation/route-boundary",
    fallback: "rv-route-fallback",
  },
  {
    name: "clientUrls() group with a local ErrorBoundary",
    path: "/errors/revalidation/group",
    fallback: "rv-local-fallback",
  },
];

/** A build redacts a loader error's message on its way to the browser. */
const REPORTED = /^(Stock service unavailable|An error occurred)$/;

async function runScenario(
  page: Page,
  url: string,
  fallback: string,
): Promise<void> {
  using _ = expectNoPageError(page);
  await page.goto(url);
  await waitForHydration(page);

  const tid = (id: string) => page.getByTestId(id);
  await expect(tid("rv-stock-as-of")).toHaveText("stock as of save #0");
  await tid("rv-note").fill("restock A-1");
  await tid("rv-controls").evaluate((el) =>
    el.setAttribute("data-e2e-kept", "1"),
  );

  // The toggle's action skips the stock loader (its revalidate()), so the
  // list stays until the next Save reruns it.
  await tid("rv-fail-toggle").click();
  await expect(tid("rv-fail-toggle")).toHaveAttribute("data-failing", "true");
  await expect(tid("rv-stock-as-of")).toHaveText("stock as of save #0");

  await tid("rv-save").click();
  // The action resolved with its result.
  await expect(tid("rv-result")).toHaveText("Saved #1: restock A-1");
  // The stock read threw in place; its nearest boundary shows the error.
  await expect(tid(fallback)).toBeVisible();
  await expect(tid("rv-stock")).toHaveCount(0);
  await expect(tid("rv-revalidation-error")).toHaveText(REPORTED);
  // The page's other loader committed in the same commit.
  if (fallback === "rv-local-fallback") {
    await expect(tid("rv-saves")).toHaveText(
      "Saves the page's other loader saw: 1",
    );
  }
  // The controls outside the boundary kept their instance and the note.
  await expect(tid("rv-note")).toHaveValue("restock A-1");
  await expect(tid("rv-controls")).toHaveAttribute("data-e2e-kept", "1");
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
  ).toHaveCount(0);

  // Toggle off and Save again: the rerun succeeds and the fallback clears.
  await tid("rv-fail-toggle").click();
  await expect(tid("rv-fail-toggle")).toHaveAttribute("data-failing", "false");
  await tid("rv-save").click();
  await expect(tid("rv-result")).toHaveText("Saved #2: restock A-1");
  await expect(tid(fallback)).toHaveCount(0);
  await expect(tid("rv-stock-as-of")).toHaveText("stock as of save #2");
  await expect(tid("rv-revalidation-error")).toHaveText("none");
  await expect(tid("rv-note")).toHaveValue("restock A-1");
  await expect(tid("rv-controls")).toHaveAttribute("data-e2e-kept", "1");
}

devTest.describe(
  "errors: a loader that throws in an action's revalidation",
  () => {
    for (const variant of variants) {
      devTest(
        `${variant.name}: the Save resolves, the read throws into its nearest boundary, and a later Save clears it`,
        async ({ page, devServerURL }) => {
          await runScenario(
            page,
            devURL(devServerURL, variant.path),
            variant.fallback,
          );
        },
      );
    }
  },
);

prodDescribe(
  "errors: a loader that throws in an action's revalidation",
  (f) => {
    for (const variant of variants) {
      test(`${variant.name}: the Save resolves, the read throws into its nearest boundary, and a later Save clears it`, async ({
        page,
      }) => {
        await runScenario(page, f.url(variant.path), variant.fallback);
      });
    }
  },
);
