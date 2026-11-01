import { test } from "@playwright/test";
import { runActionPersistsTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, expectNoReload, waitForHydration } from "./helper";

/**
 * useAction() keeps a settled call's result and error until the action's
 * next call. Body:
 * tests/shared-e2e/src/action-persists-scenario.ts. Fixture:
 * src/components/ActionPersists.tsx, src/actions/action-persists.ts and
 * src/pages/action-persists.tsx.
 */
const OPTIONS = { waitForHydration, expectNoPageError, expectNoReload };

test.describe("useAction keeps a settled call until the next call", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(60000);
  runActionPersistsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("useAction keeps a settled call until the next call (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(60000);
  runActionPersistsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
