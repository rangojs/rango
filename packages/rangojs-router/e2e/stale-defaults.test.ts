import { test } from "@playwright/test";
import { runStaleDefaultsTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * Back onto a page a server action made stale: its stale revalidation and
 * the layout loader it holds (rango-t128). Body:
 * tests/shared-e2e/src/stale-defaults-scenario.ts.
 */
test.describe("stale revalidation defaults", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runStaleDefaultsTests({ url: (pathname) => f.url(pathname) });
});

test.describe("stale revalidation defaults (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runStaleDefaultsTests({ url: (pathname) => f.url(pathname) });
});
