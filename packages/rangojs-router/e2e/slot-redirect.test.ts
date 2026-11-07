import { test } from "@playwright/test";
import { runSlotRedirectTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * An action from a parallel() slot whose handler declares loading() and
 * redirects: the browser follows the redirect instead of rendering the
 * Response in the slot.
 * Body: tests/shared-e2e/src/slot-redirect-scenario.ts.
 */
test.describe("a slot handler that redirects on an action", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runSlotRedirectTests({ url: (pathname) => f.url(pathname) });
});

test.describe("a slot handler that redirects on an action (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runSlotRedirectTests({ url: (pathname) => f.url(pathname) });
});
