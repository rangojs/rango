import { test } from "@playwright/test";
import { runActionStalePrefetchTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A server action marks prefetches stale: a click on one commits it, then
 * revalidates (#1329). Body:
 * tests/shared-e2e/src/action-stale-prefetch-scenario.ts.
 */
function describeActionStalePrefetch(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`action stale prefetch (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runActionStalePrefetchTests({
      url: (pathname) => f.url(pathname),
      warmUp: mode === "dev",
    });
  });
}

describeActionStalePrefetch("dev");
describeActionStalePrefetch("build");
