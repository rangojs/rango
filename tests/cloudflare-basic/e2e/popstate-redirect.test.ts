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
    protectedUrl: f.url("/auth-redirect/protected"),
    targetUrl: f.url("/auth-redirect?rejected=route-mw"),
    beforeUrl: f.url("/auth-redirect?tag=before"),
    fillerUrl: (n) => f.url(`/location-state-app-version?step=filler-${n}`),
    cookie: { name: "auth-redirect-token", value: "yes" },
    protectedTestId: "auth-redirect-protected",
    targetTestId: "auth-redirect-target",
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
  const f = useFixture({ root: ".", mode: "dev" });
  popstateRedirectSuite(f);
});

test.describe("popstate-redirect (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  popstateRedirectSuite(f);
});
