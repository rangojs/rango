import { test } from "@playwright/test";
import { runInterceptSourceKeyTests } from "@shared/e2e";
import { useFixture } from "./fixture";

// Body: tests/shared-e2e/src/intercept-source-key-scenario.ts.
test.describe("intercept source page history key (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runInterceptSourceKeyTests({
    url: (pathname) => f.url(pathname),
    basePath: "/intercept-held",
  });
});

test.describe("intercept source page history key (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runInterceptSourceKeyTests({
    url: (pathname) => f.url(pathname),
    basePath: "/intercept-held",
  });
});
