import { test } from "@playwright/test";
import { runDocCacheSourceTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * rango-t238: a partial whose kept layout depends on the source page is not
 * stored by the document cache, so a page with the same ids gets its own
 * diff. Body: tests/shared-e2e/src/doc-cache-source-scenario.ts.
 */
function describeDocCacheSource(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`document cache and a source-held partial (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    runDocCacheSourceTests({ url: (pathname) => f.url(pathname) });
  });
}

describeDocCacheSource("dev");
describeDocCacheSource("build");
