import { test } from "@playwright/test";
import { runRefreshOutcomeTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * What a stale entry's refresh does with notFound(), redirect() and an error,
 * on the CFCacheStore, for the document cache, route cache(), a loader's
 * cache() and a response route's cache(). Body:
 * tests/shared-e2e/src/refresh-outcome-scenario.ts. Fixture:
 * src/pages/refresh-outcome.tsx.
 */
function describeRefreshOutcome(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`stale refresh outcome (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runRefreshOutcomeTests({ url: (pathname) => f.url(pathname) });
  });
}

describeRefreshOutcome("dev");
describeRefreshOutcome("build");
