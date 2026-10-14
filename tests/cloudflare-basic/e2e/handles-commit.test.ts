import { test } from "@playwright/test";
import { runHandlesCommitTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * A navigation's title and crumbs commit with its page. Body:
 * tests/shared-e2e/src/handles-commit-scenario.ts. Fixture:
 * src/pages/handles-commit.tsx (/handles-commit/*).
 */
function handlesCommitTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`handles commit with the page (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);
    runHandlesCommitTests({
      url: (pathname) => f.url(pathname),
      waitForHydration,
    });
  });
}

handlesCommitTests("dev");
handlesCommitTests("build");
