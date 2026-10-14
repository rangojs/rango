import { test } from "@playwright/test";
import { runTransitionKindsTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * #1165: each transition commit carries its transition({ when }) kind as a
 * transition type. Body: tests/shared-e2e/src/transition-kinds-scenario.ts.
 * Fixture: test-app/src/urls/transition-kinds.tsx (/vt-kinds/*).
 */
function transitionKindsTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`transition kind types (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runTransitionKindsTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

transitionKindsTests("dev");
transitionKindsTests("build");
