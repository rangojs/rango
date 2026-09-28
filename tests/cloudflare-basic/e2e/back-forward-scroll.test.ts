import { test } from "@playwright/test";
import { expectBackLeavesScrollToBrowser } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

// Contract and mechanism: expectBackLeavesScrollToBrowser.
function backForwardScrollTests(f: Fixture): void {
  test("back leaves scroll restoration to the browser", async ({ page }) => {
    using _ = expectNoPageError(page);
    await expectBackLeavesScrollToBrowser(page, {
      url: f.url("/"),
      originTestId: "home-page",
      linkTestId: "nav-about",
      destinationUrl: f.url("/about"),
      destinationTestId: "about-page",
      waitForHydration,
    });
  });
}

test.describe("back/forward scroll without ScrollRestoration", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  backForwardScrollTests(f);
});

test.describe("back/forward scroll without ScrollRestoration (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  backForwardScrollTests(f);
});
