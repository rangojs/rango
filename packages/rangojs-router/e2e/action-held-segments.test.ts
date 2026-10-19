import { test } from "@playwright/test";
import { runActionHeldSegmentsTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A navigation never moves data on screen backwards (dc-t110, open). Body:
 * tests/shared-e2e/src/action-held-segments-scenario.ts.
 */
function describeActionHeldSegments(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`action held segments (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runActionHeldSegmentsTests({
      url: (pathname) => f.url(pathname),
    });
  });
}

describeActionHeldSegments("dev");
describeActionHeldSegments("build");
