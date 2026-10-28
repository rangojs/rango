import { test } from "@playwright/test";
import { runHandlesOverlapTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A second click over a held transition() page: a pending crumb never holds
 * the page, and no frame shows the new page with another page's title or
 * crumb (hook lock rows HD4 and HD13). Body:
 * tests/shared-e2e/src/handles-overlap-scenario.ts. Fixture:
 * test-app/src/urls/handles-overlap.tsx (/handles-overlap/*).
 */
function handlesOverlapTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`a second click over a held page (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);
    runHandlesOverlapTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

handlesOverlapTests("dev");
handlesOverlapTests("build");
