import { test } from "@playwright/test";
import { runHistoryCacheHandlesTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A link to a page the history cache holds keeps that page's handle pushes
 * when the response re-renders part of it. Body:
 * tests/shared-e2e/src/history-cache-handles-scenario.ts.
 */
function describeHistoryCacheHandles(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`history cache handles (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runHistoryCacheHandlesTests({ url: (pathname) => f.url(pathname) });
  });
}

describeHistoryCacheHandles("dev");
describeHistoryCacheHandles("build");
