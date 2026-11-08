import { test } from "@playwright/test";
import { runInterceptRedirectTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * An action from an open intercept whose handler declares loading() and
 * redirects: the browser follows the redirect instead of rendering the
 * Response in the modal.
 * Body: tests/shared-e2e/src/intercept-redirect-scenario.ts.
 */
test.describe("an intercept handler that redirects on an action", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runInterceptRedirectTests({ url: (pathname) => f.url(pathname) });
});

test.describe("an intercept handler that redirects on an action (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runInterceptRedirectTests({ url: (pathname) => f.url(pathname) });
});
