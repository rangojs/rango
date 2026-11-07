import { test } from "@playwright/test";
import { runPrefetchPreloadsTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A viewport prefetch holds the target page's image preloads; the click that
 * uses it starts them. Body: tests/shared-e2e/src/prefetch-preloads-scenario.ts.
 */
function describePrefetchPreloads(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`a prefetch's image preloads (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runPrefetchPreloadsTests({ url: (pathname) => f.url(pathname) });
  });
}

describePrefetchPreloads("dev");
describePrefetchPreloads("build");
