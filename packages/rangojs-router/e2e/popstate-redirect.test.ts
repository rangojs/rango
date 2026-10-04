import { test } from "@playwright/test";
import {
  expectLinkClickToRedirectingPageFollowsRedirect,
  expectRefetchedBackFollowsRedirectByReplacing,
  type PopstateRedirectFixture,
} from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// #1047: back/forward to an evicted entry that the server now redirects
// follows the redirect and replaces the entry.
function popstateRedirectSuite(f: Fixture) {
  test.setTimeout(90_000);
  const fixture = (): PopstateRedirectFixture => ({
    protectedUrl: f.url("/auth-boundary/route-protected"),
    targetUrl: f.url("/auth-boundary?rejected=route-mw"),
    beforeUrl: f.url("/auth-boundary?tag=before"),
    fillerUrl: (n) => f.url(`/location-state/app-version?step=filler-${n}`),
    cookie: { name: "auth-boundary-token", value: "yes" },
    protectedTestId: "auth-boundary-route-protected",
    targetTestId: "auth-boundary-index",
  });

  test("a refetched back to a page the server now redirects follows the redirect and replaces the entry", async ({
    page,
  }) => {
    await expectRefetchedBackFollowsRedirectByReplacing(page, fixture());
  });

  test("a link click to the same page follows the redirect", async ({
    page,
  }) => {
    await expectLinkClickToRedirectingPageFollowsRedirect(page, fixture());
  });
}

test.describe("popstate-redirect", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  popstateRedirectSuite(f);
});

test.describe("popstate-redirect (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  popstateRedirectSuite(f);
});
