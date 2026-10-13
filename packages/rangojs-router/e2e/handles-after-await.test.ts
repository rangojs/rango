import { test } from "@playwright/test";
import { runHandlesAfterAwaitTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * Meta and Breadcrumbs pushed after `await wait(1000)` from a route handler,
 * a layout handler, a loader and an async component handed ctx. Body:
 * tests/shared-e2e/src/handles-after-await-scenario.ts.
 */
function describeHandlesAfterAwait(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`handles after await (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runHandlesAfterAwaitTests({
      url: (pathname) => f.url(pathname),
      production: mode === "build",
    });
  });
}

describeHandlesAfterAwait("dev");
describeHandlesAfterAwait("build");
