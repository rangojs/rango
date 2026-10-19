import { test } from "@playwright/test";
import { runActionStaleNavigationTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * An action makes the next navigation stale. Body:
 * tests/shared-e2e/src/action-stale-navigation-scenario.ts.
 */
function describeActionStaleNavigation(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`action stale navigation (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runActionStaleNavigationTests({
      url: (pathname) => f.url(pathname),
      warmUp: mode === "dev",
    });
  });
}

describeActionStaleNavigation("dev");
describeActionStaleNavigation("build");
