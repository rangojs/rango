import { test } from "@playwright/test";
import { runActionBoundaryTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * An action that throws on a route with its own errorBoundary(), under a
 * layout whose loader reads its write (rango-t124). Body:
 * tests/shared-e2e/src/action-boundary-scenario.ts.
 */
test.describe("action under a route's errorBoundary()", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runActionBoundaryTests({ url: (pathname) => f.url(pathname) });
});

test.describe("action under a route's errorBoundary() (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runActionBoundaryTests({ url: (pathname) => f.url(pathname) });
});
