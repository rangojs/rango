import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * The shapes the declared-under guard must keep accepting, in a real app
 * (fixture: test-app/src/urls/dsl-nesting.tsx).
 *
 * - /dsl-nesting: the route is a const created inside the callback that nests
 *   it. The layout renders because the route stays under it — the bug this
 *   guard is about made the layout disappear and still answered 200.
 * - /dsl-nesting/cached: a bare cache() wraps the siblings after it, which are
 *   declared one level below the callback's own entry, so the guard's
 *   "the callback's entry or a descendant" walk is what keeps them legal.
 *
 * The rejected shape is e2e/declared-outside.test.ts: it fails discovery and
 * the build, so it cannot live in this app.
 */

function dslNestingTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`a definition declared in the callback that nests it (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test("keeps the layout around a route created in its own callback", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/dsl-nesting"));
      await waitForHydration(page);
      await expect(testId(page, "dsl-nesting-layout")).toBeVisible();
      await expect(testId(page, "dsl-nesting-page")).toHaveText(
        "declared inside its layout callback",
      );
    });

    test("serves a route declared after a bare cache()", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/dsl-nesting/cached"));
      await waitForHydration(page);
      await expect(testId(page, "dsl-nesting-cached-page")).toHaveText(
        "sibling of a bare cache()",
      );
    });
  });
}

dslNestingTests("dev");
dslNestingTests("build");
