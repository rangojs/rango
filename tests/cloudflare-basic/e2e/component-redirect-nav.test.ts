import { test } from "@playwright/test";
import { runComponentRedirectNavTests } from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * A server component that throws redirect(), reached by a Link click, lands
 * on the redirect's target. Body:
 * tests/shared-e2e/src/component-redirect-nav-scenario.ts. Fixture:
 * src/pages/component-redirect-nav.tsx, under the workerd runtime.
 */
const OPTIONS = { waitForHydration, expectNoPageError };

test.describe("component redirect on navigation", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runComponentRedirectNavTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});

test.describe("component redirect on navigation (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runComponentRedirectNavTests({
    url: (pathname) => f.url(pathname),
    ...OPTIONS,
  });
});
