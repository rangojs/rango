import { test } from "@playwright/test";
import { runInterceptPrefetchInsideTests } from "@shared/e2e";
import { useFixture } from "./fixture";

// Body: tests/shared-e2e/src/intercept-prefetch-inside-scenario.ts.
test.describe("intercept prefetch inside an open intercept (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runInterceptPrefetchInsideTests({
    url: (pathname) => f.url(pathname),
    basePath: "/intercept-held",
  });
});

test.describe("intercept prefetch inside an open intercept (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runInterceptPrefetchInsideTests({
    url: (pathname) => f.url(pathname),
    basePath: "/intercept-held",
  });
});
