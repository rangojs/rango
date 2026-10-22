import { test } from "@playwright/test";
import { runActionFollowUpTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * The follow-up revalidation after an action that did not land on the page
 * on screen. Body: tests/shared-e2e/src/action-follow-up-scenario.ts.
 */
function describeActionFollowUp(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`action follow-up (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runActionFollowUpTests({
      url: (pathname) => f.url(pathname),
      warmUp: mode === "dev",
    });
  });
}

describeActionFollowUp("dev");
describeActionFollowUp("build");
