import { test } from "@playwright/test";
import { runHookFieldsTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * useNavigation()'s fields in every reader shape, and useAction() beside
 * them, while React holds a transition() page. Body:
 * tests/shared-e2e/src/hook-fields-scenario.ts. Fixture:
 * src/components/HookFields.tsx, src/actions/hook-fields.ts and
 * src/pages/hook-fields.tsx.
 */
const OPTIONS = { waitForHydration, expectNoPageError };

test.describe("hook fields while a page is held", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(60000);
  runHookFieldsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});

test.describe("hook fields while a page is held (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(60000);
  runHookFieldsTests({ url: (pathname) => f.url(pathname), ...OPTIONS });
});
