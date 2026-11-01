import { test } from "@playwright/test";
import { runInterceptBoundaryTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * An open intercept through router.refresh() and another tab's action (the
 * full page, as a reload), and Back onto one whose action threw.
 * Body: tests/shared-e2e/src/intercept-boundary-scenario.ts.
 */
test.describe("an open intercept through a refresh and Back", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runInterceptBoundaryTests({ url: (pathname) => f.url(pathname) });
});

test.describe("an open intercept through a refresh and Back (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runInterceptBoundaryTests({ url: (pathname) => f.url(pathname) });
});
