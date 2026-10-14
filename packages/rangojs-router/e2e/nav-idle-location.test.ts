import { test } from "@playwright/test";
import { runNavIdleLocationTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, expectNoReload, waitForHydration } from "./helper";

/**
 * #1164: useNavigation() idle commits with useSearchParams() on a same-route
 * search navigation, with and without view transitions. Body:
 * tests/shared-e2e/src/nav-idle-location-scenario.ts. Fixture:
 * test-app/src/components/NavIdleFilters.tsx and test-app/src/urls/nav-idle-location.tsx.
 */
function navIdleLocationTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`useNavigation idle commits with useSearchParams (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(30000);
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
