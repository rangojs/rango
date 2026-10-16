import { expect, test } from "@playwright/test";
import { runNavIdleLocationTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, expectNoReload, waitForHydration } from "./helper";

/**
 * #1164: useNavigation() idle commits with useSearchParams() on a same-route
 * search navigation, with and without view transitions. Body:
 * tests/shared-e2e/src/nav-idle-location-scenario.ts. Fixture:
 * src/components/NavIdleFilters.tsx, src/loaders/nav-idle.ts and
 * src/pages/nav-idle.tsx.
 */
function navIdleLocationTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`useNavigation idle commits with useSearchParams (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runNavIdleLocationTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      expectNoPageError,
      expectNoReload,
    });
  });
}

navIdleLocationTests("dev");
navIdleLocationTests("build");

/**
 * useNavigation() separates a navigation from a server action: `state` is
 * loading for both, `isNavigating` is true for the navigation only. The
 * loader delays the navigation by 400 ms and the action takes 1.5 s.
 */
function navigatingTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`useNavigation isNavigating (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);

    test("isNavigating is true during a navigation and false during an action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/nav-idle?tag=a&tag=b"));
      await waitForHydration(page);

      const status = page.locator('[data-testid="nav-idle-status"]');
      await expect(status).toHaveText("state:idle navigating:false");

      await page.locator('[data-testid="nav-idle-remove-a"]').click();
      await expect(status).toHaveText("state:loading navigating:true", {
        timeout: 3000,
      });
      await expect(status).toHaveText("state:idle navigating:false", {
        timeout: 10000,
      });

      await page.locator('[data-testid="nav-idle-action"]').click();
      await expect(status).toHaveText("state:loading navigating:false", {
        timeout: 3000,
      });
      await expect(status).toHaveText("state:idle navigating:false", {
        timeout: 10000,
      });
    });
  });
}

navigatingTests("dev");
navigatingTests("build");
