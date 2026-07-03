import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Regression guard for #642. A name-less 3-arg children-fn route —
// path("/unnamed-children-fn", component, () => [loading(...)]) — used to
// collapse the whole app route map at type level (Rango.Path -> never). The
// TYPE guarantee is pinned by the router unit type-test and by this app's
// `pnpm typecheck` (RegisteredRoutes extends typeof router.routeMap). These
// e2e checks pin the RUNTIME contract the issue asserted but never proved:
// the route still resolves, renders, and hydrates — in dev AND production.
function describeUnnamedChildrenFn(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`name-less children-fn route renders (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    test("resolves by URL and renders its component", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/unnamed-children-fn"));
      await waitForHydration(page);

      await expect(testId(page, "unnamed-children-fn-route")).toBeVisible();
      await expect(testId(page, "unnamed-children-fn-route")).toContainText(
        "unnamed children-fn route works",
      );
    });
  });
}

describeUnnamedChildrenFn("dev");
describeUnnamedChildrenFn("build");
