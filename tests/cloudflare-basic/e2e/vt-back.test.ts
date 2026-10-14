import { test } from "@playwright/test";
import { runVtBackTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A back/forward restored from the history cache runs a view transition
 * under transition(). Body: tests/shared-e2e/src/vt-back-scenario.ts.
 * Fixture: src/pages/vt-back.tsx (/vt-back/*, /vt-back-plain/*).
 */
function vtBackTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`cached back/forward view transitions (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runVtBackTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

vtBackTests("dev");
vtBackTests("build");
