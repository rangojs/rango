import { test } from "@playwright/test";
import { runActionPersistsTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, expectNoReload, waitForHydration } from "./helper";

/**
 * useAction() keeps a settled call's result and error until the action's
 * next call (rango-t223). Body:
 * tests/shared-e2e/src/action-persists-scenario.ts. Fixture:
 * test-app/src/components/ActionPersists.tsx,
 * test-app/src/actions/action-persists.ts and
 * test-app/src/urls/action-persists.tsx.
 */
const OPTIONS = { waitForHydration, expectNoPageError, expectNoReload };

test.describe("useAction keeps a settled call until the next call", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(30000);
  runActionPersistsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("useAction keeps a settled call until the next call (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(30000);
  runActionPersistsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
