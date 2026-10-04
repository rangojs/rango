import { test } from "@playwright/test";
import {
  expectCachedTraversalChangesUrlWithItsPage,
  expectLoaderHeldBackKeepsUrlForMountedReaders,
  expectReaderMountedInHeldPageReadsItsUrl,
  expectRequestHeldBackKeepsUrlOfPageOnScreen,
  expectRequestHeldPushKeepsUrlOfPageOnScreen,
} from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// #1031: on back/forward, usePathname() and useSearchParams() change with
// the page, not at the popstate event. While the entry is being fetched the
// page being left stays on screen and its readers keep its URL; the address
// bar is already the entry's.
function urlCommitSuite(f: Fixture) {
  test.setTimeout(90_000);
  const list = () => f.url("/location-state-load-more");
  const panel = () => f.url("/location-state-app-version");

  test("a refetched back keeps the URL of the page on screen while its request is out (same route)", async ({
    page,
  }) => {
    await expectRequestHeldBackKeepsUrlOfPageOnScreen(
      page,
      list(),
      panel(),
      "same-route",
    );
  });

  test("a refetched back keeps the URL of the page on screen while its request is out (cross route)", async ({
    page,
  }) => {
    await expectRequestHeldBackKeepsUrlOfPageOnScreen(
      page,
      list(),
      panel(),
      "cross-route",
    );
  });

  test("a refetched back held by its loader keeps the URL of the page on screen for mounted readers", async ({
    page,
  }) => {
    await expectLoaderHeldBackKeepsUrlForMountedReaders(page, list());
  });

  test("known gap #1046: a reader mounted while React holds a refetched back reads the page's URL", async ({
    page,
  }) => {
    await expectReaderMountedInHeldPageReadsItsUrl(page, list(), (reason) =>
      test.fail(true, reason),
    );
  });

  test("a push keeps the URL of the page on screen while its request is out", async ({
    page,
  }) => {
    await expectRequestHeldPushKeepsUrlOfPageOnScreen(page, list());
  });

  test("a cached back/forward changes the URL with its page", async ({
    page,
  }) => {
    await expectCachedTraversalChangesUrlWithItsPage(page, list());
  });
}

test.describe("navigation-url-commit", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  urlCommitSuite(f);
});

test.describe("navigation-url-commit (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  urlCommitSuite(f);
});
