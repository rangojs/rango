import { test } from "@playwright/test";
import { runHeldBoundaryTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A boundary on screen must not be replaced by its loading() fallback when
 * nothing in it is pending. Body: tests/shared-e2e/src/held-boundary-scenario.ts.
 */
function describeHeldBoundary(mode: "dev" | "build") {
  const production = mode === "build";
  test.describe(`held boundary (${production ? "production" : "dev"})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runHeldBoundaryTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      production,
    });
  });
}

describeHeldBoundary("dev");
describeHeldBoundary("build");
