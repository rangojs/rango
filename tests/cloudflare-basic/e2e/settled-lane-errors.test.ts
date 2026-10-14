import { test } from "@playwright/test";
import { runSettledLaneErrorTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A loader error or redirect() committed by a fully-prefetched click or a
 * back/forward restore (dc-t65). Body:
 * tests/shared-e2e/src/settled-lane-errors-scenario.ts.
 */
const PATH = "/settled-lane-errors";

test.describe("loader errors on settled lanes", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runSettledLaneErrorTests({
    url: (pathname) => f.url(pathname),
    path: PATH,
    production: false,
  });
});

test.describe("loader errors on settled lanes (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runSettledLaneErrorTests({
    url: (pathname) => f.url(pathname),
    path: PATH,
    production: true,
  });
});
