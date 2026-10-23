import { test } from "@playwright/test";
import { runInterceptHistoryTests } from "@shared/e2e";
import { useFixture } from "./fixture";

// Body: tests/shared-e2e/src/intercept-history-scenario.ts.
test.describe("intercept history entries (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runInterceptHistoryTests({
    url: (pathname) => f.url(pathname),
    basePath: "/intercept-held",
  });
});

test.describe("intercept history entries (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runInterceptHistoryTests({
    url: (pathname) => f.url(pathname),
    basePath: "/intercept-held",
  });
});
