import { test } from "@playwright/test";
import { runOptimisticSettleTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * useLinkStatus() and useAction() values settle in the page's commit and
 * leave it its transition types (hooks review W2). Body:
 * tests/shared-e2e/src/optimistic-settle-scenario.ts. Fixture:
 * src/pages/optimistic-settle.tsx (/opt-settle/*).
 */
function optimisticSettleTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`optimistic hook values settle with the page (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runOptimisticSettleTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

optimisticSettleTests("dev");
optimisticSettleTests("build");
