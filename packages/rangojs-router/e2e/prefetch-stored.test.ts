import { test } from "@playwright/test";
import { runPrefetchStoredTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * rango-t82: a prefetch answer with nothing live in it carries the router's
 * prefetch Cache-Control; one with a live segment or a loader carries none.
 * The test-app sets prefetchCacheTTL: 60. Body:
 * tests/shared-e2e/src/prefetch-stored-scenario.ts.
 */
function describePrefetchStored(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`a prefetch answered from storage (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runPrefetchStoredTests({
      url: (pathname) => f.url(pathname),
      ttlSeconds: 60,
    });
  });
}

describePrefetchStored("dev");
describePrefetchStored("build");
