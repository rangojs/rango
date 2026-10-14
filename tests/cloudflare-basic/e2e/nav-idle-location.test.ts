import { test } from "@playwright/test";
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
