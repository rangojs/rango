import { test } from "@playwright/test";
import { runRefreshOutcomeTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * What a stale entry's refresh does with notFound(), redirect() and an error,
 * for the document cache, route cache(), a loader's cache() and a response
 * route's cache(). Body: tests/shared-e2e/src/refresh-outcome-scenario.ts.
 * Fixture: e2e/test-app/src/urls/refresh-outcome.tsx.
 */

test.describe("stale refresh outcome", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runRefreshOutcomeTests({ url: (pathname) => f.url(pathname) });
});

test.describe("stale refresh outcome (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runRefreshOutcomeTests({ url: (pathname) => f.url(pathname) });
});
