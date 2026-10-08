import { test } from "@playwright/test";
import { runUseLoaderSettledReadTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A useLoader read that mounted on a stream and later renders settled keeps
 * calling use(). Body: tests/shared-e2e/src/use-loader-settled-read-scenario.ts.
 */
function describeUseLoaderSettledRead(mode: "dev" | "build") {
  const production = mode === "build";
  test.describe(`useLoader settled read (${production ? "production" : "dev"})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runUseLoaderSettledReadTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      production,
    });
  });
}

describeUseLoaderSettledRead("dev");
describeUseLoaderSettledRead("build");
