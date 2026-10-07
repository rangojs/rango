import { test } from "@playwright/test";
import { runZeroLoaderBoundaryTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A boundary with no loaders must not show its fallback over content it
 * already holds. Body: tests/shared-e2e/src/zero-loader-boundary-scenario.ts.
 */
function describeZeroLoaderBoundary(label: string, mode: "dev" | "build") {
  test.describe(`zero-loader boundary (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runZeroLoaderBoundaryTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

describeZeroLoaderBoundary("dev", "dev");
describeZeroLoaderBoundary("production", "build");
