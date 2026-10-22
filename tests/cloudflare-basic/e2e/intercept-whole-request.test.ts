import { test } from "@playwright/test";
import { runInterceptWholeRequestTests } from "@shared/e2e";
import { useFixture } from "./fixture";

// Body: tests/shared-e2e/src/intercept-whole-request-scenario.ts.
function describeInterceptWholeRequest(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`intercept whole request keeps the page under the intercept (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runInterceptWholeRequestTests({
      url: (pathname) => f.url(pathname),
      basePath: "/intercept-held",
    });
  });
}

describeInterceptWholeRequest("dev");
describeInterceptWholeRequest("build");
