import { test } from "@playwright/test";
import { runInterceptHeldTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A modal whose loaders all skip revalidate() keeps its data across a server
 * action; a handle pushed inside an intercept slot reaches the page. Fixture:
 * test-app/src/urls/intercept-held.tsx. Body:
 * tests/shared-e2e/src/intercept-held-scenario.ts.
 */
function describeInterceptHeld(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`intercept slot handles and held loaders (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runInterceptHeldTests({
      url: (pathname) => f.url(pathname),
      basePath: "/intercept-held",
    });
  });
}

describeInterceptHeld("dev");
describeInterceptHeld("build");
