import { test } from "@playwright/test";
import { runLateHandleHistoryTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * Back keeps a late handle push after a navigation made while the document is
 * still hydrating. Body: tests/shared-e2e/src/late-handle-history-scenario.ts.
 */
function describeLateHandleHistory(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`late handle history (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runLateHandleHistoryTests({
      url: (pathname) => f.url(pathname),
    });
  });
}

describeLateHandleHistory("dev");
describeLateHandleHistory("build");
