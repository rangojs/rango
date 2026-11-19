import { test } from "@playwright/test";
import { runHeldNavigationScrollTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A navigation that redraws nothing still applies its scroll. Body:
 * tests/shared-e2e/src/held-navigation-scroll-scenario.ts.
 */
test.describe("held navigation scroll", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runHeldNavigationScrollTests({ url: (pathname) => f.url(pathname) });
});

test.describe("held navigation scroll (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runHeldNavigationScrollTests({ url: (pathname) => f.url(pathname) });
});
