import { test } from "@playwright/test";
import { runKeptLayoutSourceTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * #1331: a prefetch held a layout because its revalidate() read the source
 * page; another page that adopted it kept its own copy of the layout. Body:
 * tests/shared-e2e/src/kept-layout-source-scenario.ts.
 */
function describeKeptLayoutSource(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`kept layout from another source (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runKeptLayoutSourceTests({ url: (pathname) => f.url(pathname) });
  });
}

describeKeptLayoutSource("dev");
describeKeptLayoutSource("build");
