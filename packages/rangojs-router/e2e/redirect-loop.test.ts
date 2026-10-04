import { test } from "@playwright/test";
import { expectRedirectLoopEndsInErrorBoundary } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// #1047: the client stops following server redirects that loop.
function redirectLoopSuite(f: Fixture) {
  test.setTimeout(90_000);

  test("a redirect loop stops at the hop limit and renders the error boundary", async ({
    page,
  }) => {
    await expectRedirectLoopEndsInErrorBoundary(page, {
      indexUrl: f.url("/redirect-loop"),
      indexTestId: "redirect-loop-index",
      loopUrl: f.url("/redirect-loop/ping"),
    });
  });
}

test.describe("redirect-loop", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  redirectLoopSuite(f);
});

test.describe("redirect-loop (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  redirectLoopSuite(f);
});
