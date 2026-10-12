import { test } from "@playwright/test";
import { runActionFailureTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A loader that fails on its rerun after a server action, in a clientUrls()
 * group and on a urls() route (#1106). Body:
 * tests/shared-e2e/src/action-failure-scenario.ts.
 */
const OPTIONS = {
  clientPath: "/action-failure-client",
  serverPath: "/action-failure-server",
  boundedPath: "/action-failure-bounded",
};

test.describe("loader failure after an action", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runActionFailureTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("loader failure after an action (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runActionFailureTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
