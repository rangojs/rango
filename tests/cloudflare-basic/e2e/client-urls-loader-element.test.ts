import { test } from "@playwright/test";
import { runLoaderElementTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A no-script document of a clientUrls() route whose inline <Suspense> draws
 * a client component from a loader's answer renders it in dev as in a build
 * (#1106). Body: tests/shared-e2e/src/loader-element-scenario.ts.
 */
test.describe("clientUrls loader element", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runLoaderElementTests({
    url: (pathname) => f.url(pathname),
    path: "/client-urls-loader-element",
  });
});

test.describe("clientUrls loader element (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runLoaderElementTests({
    url: (pathname) => f.url(pathname),
    path: "/client-urls-loader-element",
  });
});
