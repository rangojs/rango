import { test } from "@playwright/test";
import { runTxIdleViewTransitionTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * The escape hatches for the idle view transition under transition() +
 * loading() (#1078). Body: tests/shared-e2e/src/tx-idle-view-transition-scenario.ts.
 * Fixture: src/pages/tx-when.tsx (/tx-idle/*).
 */
function idleViewTransitionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`transition idle view transition (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runTxIdleViewTransitionTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

idleViewTransitionTests("dev");
idleViewTransitionTests("build");
