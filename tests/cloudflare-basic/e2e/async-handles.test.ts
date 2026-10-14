import { test } from "@playwright/test";
import { runAsyncHandlesTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * Async handle values: awaited in SSR, held then swapped on navigations. Body:
 * tests/shared-e2e/src/async-handles-scenario.ts. Fixture:
 * src/pages/async-handles.tsx (/async-handles/*).
 */
function asyncHandlesTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`async handle values (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runAsyncHandlesTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

asyncHandlesTests("dev");
asyncHandlesTests("build");
