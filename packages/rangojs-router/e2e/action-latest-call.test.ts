import { test } from "@playwright/test";
import { runActionLatestCallTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, expectNoReload, waitForHydration } from "./helper";

/**
 * Hook lock row A3: useAction() reports the latest call when the same action
 * is called twice and the later call returns first. Body:
 * tests/shared-e2e/src/action-latest-call-scenario.ts. Fixture:
 * test-app/src/components/ActionLatestCall.tsx,
 * test-app/src/actions/action-latest-call.ts and
 * test-app/src/urls/action-latest-call.tsx.
 */
const OPTIONS = { waitForHydration, expectNoPageError, expectNoReload };

test.describe("useAction reports the latest call", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(30000);
  runActionLatestCallTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("useAction reports the latest call (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(30000);
  runActionLatestCallTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
