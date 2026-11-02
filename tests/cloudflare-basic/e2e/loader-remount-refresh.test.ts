import { test } from "@playwright/test";
import { runLoaderRemountRefreshTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * A refreshed registered useLoader reader across navigations: a reader that
 * mounts on another page or a new visit, or is held across new route data,
 * shows its own route data. Body:
 * tests/shared-e2e/src/loader-remount-refresh-scenario.ts. Fixture:
 * src/pages/loader-remount-refresh.tsx.
 */
const OPTIONS = {
  waitForHydration,
  expectNoPageError,
  base: "/loader-remount",
};

test.describe("a refreshed registered reader across navigations", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(60000);
  runLoaderRemountRefreshTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});

test.describe("a refreshed registered reader across navigations (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(60000);
  runLoaderRemountRefreshTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});
