import { test } from "@playwright/test";
import { runRedispatchedDomContentLoadedTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * #1205: a DOMContentLoaded a script dispatches again leaves the document's
 * Flight stream alone. Body:
 * tests/shared-e2e/src/redispatched-dom-content-loaded-scenario.ts.
 */
function describeRedispatchedDomContentLoaded(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`redispatched DOMContentLoaded (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runRedispatchedDomContentLoadedTests({
      url: (pathname) => f.url(pathname),
    });
  });
}

describeRedispatchedDomContentLoaded("dev");
describeRedispatchedDomContentLoaded("build");
