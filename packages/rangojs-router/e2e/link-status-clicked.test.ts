import { test } from "@playwright/test";
import { runLinkStatusClickedTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * useLinkStatus() marks the clicked link, not every link to the same
 * address; a navigation no link started marks every link to its URL. Body:
 * tests/shared-e2e/src/link-status-clicked-scenario.ts. Fixture:
 * test-app/src/urls/optimistic-settle.tsx (/opt-settle/*).
 */
function linkStatusClickedTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`useLinkStatus marks the clicked link (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runLinkStatusClickedTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

linkStatusClickedTests("dev");
linkStatusClickedTests("build");
