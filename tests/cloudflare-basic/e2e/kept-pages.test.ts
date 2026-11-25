import { test } from "@playwright/test";
import { runKeptPagesTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * `<Outlet keep />` keeps the pages an outlet leaves mounted and hidden.
 * Body: tests/shared-e2e/src/kept-pages-scenario.ts. Fixture:
 * src/pages/kept-pages.tsx and src/kept-pages/urls.tsx.
 */
function keptPagesTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`Outlet keep (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runKeptPagesTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      expectNoPageError,
      mode,
    });
  });
}

keptPagesTests("dev");
keptPagesTests("build");
