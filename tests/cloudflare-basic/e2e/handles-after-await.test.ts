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
    // The Cloudflare dev server pushes the async-component cases' server
    // error to every open page as Vite's error overlay, which covers another
    // test's page; one test at a time keeps each overlay on its own test.
    if (mode === "dev") test.describe.configure({ mode: "serial" });
    const f = useFixture({ root: ".", mode });
    runHandlesAfterAwaitTests({
      url: (pathname) => f.url(pathname),
      production: mode === "build",
    });
  });
}

describeHandlesAfterAwait("dev");
describeHandlesAfterAwait("build");
