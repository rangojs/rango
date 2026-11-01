import { test } from "@playwright/test";
import { runActionStaleHttpCacheTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A server action bumps the write part of the rango state, so a prefetch
 * whose response carries its own Cache-Control: max-age is not answered
 * from the browser HTTP cache after the write. Body:
 * tests/shared-e2e/src/action-stale-http-cache-scenario.ts.
 */
function describeActionStaleHttpCache(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`action stale http cache (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runActionStaleHttpCacheTests({
      url: (pathname) => f.url(pathname),
      warmUp: mode === "dev",
    });
  });
}

describeActionStaleHttpCache("dev");
describeActionStaleHttpCache("build");
