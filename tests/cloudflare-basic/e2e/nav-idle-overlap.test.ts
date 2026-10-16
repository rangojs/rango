import { test } from "@playwright/test";
import { runNavIdleOverlapTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * #1164's filter chips while an action settles, or a newer navigation ends
 * with no page, during the held page (hook-lock rows S10 and S8). Body:
 * tests/shared-e2e/src/nav-idle-overlap-scenario.ts. Fixture:
 * src/pages/nav-idle.tsx (/nav-idle-overlap), src/loaders/nav-idle.ts,
 * src/components/NavIdleOverlapControls.tsx and src/actions/nav-idle-overlap.ts.
 */
function navIdleOverlapTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`useNavigation idle waits for the held page (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runNavIdleOverlapTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
      expectNoPageError,
      // NAV_IDLE_EXTERNAL in src/pages/nav-idle.tsx.
      externalUrl: "https://nav-idle-external.example/",
    });
  });
}

navIdleOverlapTests("dev");
navIdleOverlapTests("build");
