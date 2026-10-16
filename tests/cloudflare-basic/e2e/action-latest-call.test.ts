import { test } from "@playwright/test";
import { runActionLatestCallTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, expectNoReload, waitForHydration } from "./helper";

/**
 * Hook lock row A3 (dc-t84): useAction() reports the latest call when the
 * same action is called twice and the later call returns first. Body:
 * tests/shared-e2e/src/action-latest-call-scenario.ts. Fixture:
 * src/components/ActionLatestCall.tsx, src/actions/action-latest-call.ts and
 * src/pages/action-latest-call.tsx.
 */
const OPTIONS = { waitForHydration, expectNoPageError, expectNoReload };

test.describe("useAction reports the latest call", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(60000);
  runActionLatestCallTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("useAction reports the latest call (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(60000);
  runActionLatestCallTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
