import { test } from "@playwright/test";
import { runHookFieldsTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * useNavigation()'s fields and the URL hooks in every reader shape while React
 * holds a transition() page. Body: tests/shared-e2e/src/hook-fields-scenario.ts.
 * Fixture: test-app/src/components/HookFields.tsx and
 * test-app/src/urls/hook-fields.tsx.
 */
const OPTIONS = { waitForHydration, expectNoPageError };

test.describe("hook fields while a page is held", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(30000);
  runHookFieldsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("hook fields while a page is held (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(30000);
  runHookFieldsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
