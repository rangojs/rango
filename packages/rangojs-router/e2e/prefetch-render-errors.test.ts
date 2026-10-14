import { test } from "@playwright/test";
import { runPrefetchRenderErrorTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A prefetch whose render reported an error is kept neither in memory nor in
 * the HTTP cache (#1170). Body:
 * tests/shared-e2e/src/prefetch-render-errors-scenario.ts.
 */
const PATH = "/prefetch-render-errors";

test.describe("a prefetch whose render failed is not kept", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runPrefetchRenderErrorTests({
    url: (pathname) => f.url(pathname),
    path: PATH,
  });
});

test.describe("a prefetch whose render failed is not kept (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runPrefetchRenderErrorTests({
    url: (pathname) => f.url(pathname),
    path: PATH,
  });
});
