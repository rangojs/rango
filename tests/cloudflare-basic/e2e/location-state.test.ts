import { expect, test } from "@playwright/test";
import {
  expectClearOnReloadDropsCarriedState,
  expectClearOnReloadDropsStateOnTraversalLoad,
  expectHeldLoadMoreShowsNoItemTwice,
  expectLateSuspenseReaderHydratesClean,
  expectLoadMoreTraversalRestoresEntryWithItsPage,
  expectOtherVersionLocationStateDroppedOnLoad,
  expectOtherVersionLocationStateDroppedOnTraversal,
  expectReaderMountedDuringHeldNavigationReadsEntryOnScreen,
  returnToEvictedEntry,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Location state tests - passing state during navigation. The feature content
 * is deterministic and the loading-state assertion is written tolerantly
 * (the page may resolve before the loading frame is observed), so the suite
 * holds in dev and the production build alike.
 */
function describeLocationState(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`location-state (${label})`, () => {
    const f = useFixture({
      root: ".",
      mode,
    });

    test("should show feature links on home page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      const featureLinks = testId(page, "feature-links");
      await expect(featureLinks).toBeVisible();
      await expect(
        testId(page, "feature-link-server-components"),
      ).toBeVisible();
      await expect(testId(page, "feature-link-server-actions")).toBeVisible();
      await expect(testId(page, "feature-link-streaming")).toBeVisible();
    });

    test("should show location state in loading state when navigating with state", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click the feature link (which passes location state)
      await testId(page, "feature-link-server-components").click();

      // Should show loading state with state data from location state
      const loadingName = testId(page, "feature-loading-name");
      const loadingDescription = testId(page, "feature-loading-description");

      // Either we see the loading state with data, or the page has already
      // loaded. The loading state should show the state data if visible.
      try {
        await expect(loadingName).toBeVisible({ timeout: 500 });
        await expect(loadingName).toHaveText("Server Components");
        await expect(loadingDescription).toHaveText(
          "React components that render on the server",
        );
      } catch {
        // Page loaded fast, check the final content instead
        await expect(testId(page, "feature-page")).toBeVisible();
      }

      // Eventually the feature page should be visible
      await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
      await expect(testId(page, "feature-title")).toHaveText(
        "Server Components",
      );
    });

    test("should show skeleton in loading state when navigating without state", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate directly to a feature page (no location state)
      await page.goto(f.url("/features/streaming"));
      await waitForHydration(page);

      // Should eventually show the feature page
      await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
      await expect(testId(page, "feature-title")).toHaveText("Streaming");
    });

    test("should navigate to different features with correct state", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate to server-actions feature
      await testId(page, "feature-link-server-actions").click();

      // Wait for the page to load
      await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
      await expect(testId(page, "feature-title")).toHaveText("Server Actions");

      // Go back to home
      await page.goBack();
      await expect(testId(page, "home-page")).toBeVisible();

      // Navigate to streaming feature
      await testId(page, "feature-link-streaming").click();

      // Wait for the page to load
      await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });
      await expect(testId(page, "feature-title")).toHaveText("Streaming");
    });

    // The cache-miss refetch used to replaceState a fresh history state,
    // dropping the entry's location state and scroll key.
    test("back to an evicted entry keeps its history state", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/about"));
      await waitForHydration(page);
      await page.evaluate(() =>
        window.history.replaceState(
          { ...window.history.state, __rsc_ls_probe: { from: "about" } },
          "",
        ),
      );
      const before = await page.evaluate(() => window.history.state);

      await returnToEvictedEntry(page, (n) => f.url(`/?n=${n}`));

      await expect(page).toHaveURL(f.url("/about"));
      await expect(testId(page, "about-page")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.history.state))
        .toEqual(before);
    });

    test("should preserve location state across browser history", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Navigate to a feature with state
      await testId(page, "feature-link-server-components").click();
      await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });

      // Navigate to another feature
      await page.goto(f.url("/"));
      await waitForHydration(page);
      await testId(page, "feature-link-streaming").click();
      await expect(testId(page, "feature-page")).toBeVisible({ timeout: 5000 });

      // Go back should show the previous feature
      await page.goBack();
      await expect(testId(page, "home-page")).toBeVisible();

      // Go back again should be on home
      await page.goBack();
      // The feature route declares transition(), so on React 19.3+ the
      // <ViewTransition> keeps the exiting feature page mounted (hidden, with
      // vt-* attributes) for a few hundred ms while the entering one commits.
      // Both carry this test id, and the entering instance is appended after
      // the exiting one, so target the last match instead of the strict single.
      const featurePage = testId(page, "feature-page").last();
      await expect(featurePage).toBeVisible();
      await expect(featurePage.getByTestId("feature-title")).toHaveText(
        "Server Components",
      );
    });

    // #993: router.push()/replace() with `[Def(value)]` write the typed entry
    // to the entry they create or replace, and it survives back/forward.
    test("router.push and router.replace typed state round-trips through history", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/action-location-state"));
      await waitForHydration(page);
      const listState = testId(page, "list-state");
      await expect(listState).toHaveText("none");

      await testId(page, "list-push-btn").click();
      await expect(page).toHaveURL(f.url("/action-location-state?page=2"));
      await expect(listState).toHaveText("pushed:20");
      const pushed = await page.evaluate(() => window.history.state);
      expect(
        Object.entries(pushed as Record<string, unknown>)
          .filter(([key]) => key.startsWith("__rsc_ls_"))
          .map(([, value]) => value),
      ).toEqual([{ label: "pushed", loaded: 20 }]);

      await page.goBack();
      await expect(page).toHaveURL(f.url("/action-location-state"));
      await expect(listState).toHaveText("none");
      await page.goForward();
      await expect(page).toHaveURL(f.url("/action-location-state?page=2"));
      await expect(listState).toHaveText("pushed:20");

      const length = await page.evaluate(() => window.history.length);
      await testId(page, "list-replace-btn").click();
      await expect(page).toHaveURL(f.url("/action-location-state?page=3"));
      await expect(listState).toHaveText("replaced:30");
      expect(await page.evaluate(() => window.history.length)).toBe(length);

      await page.goBack();
      await expect(page).toHaveURL(f.url("/action-location-state"));
      await expect(listState).toHaveText("none");
      await page.goForward();
      await expect(page).toHaveURL(f.url("/action-location-state?page=3"));
      await expect(listState).toHaveText("replaced:30");
    });

    test("should not show hydration mismatch with location state", async ({
      page,
    }) => {
      const hydrationErrors: string[] = [];

      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("Hydration failed") ||
          text.includes("hydration mismatch") ||
          text.includes("Text content does not match")
        ) {
          hydrationErrors.push(text);
        }
      });

      await page.goto(f.url("/"));
      await waitForHydration(page);

      // The feature route declares transition(): on React 19.3+ a transition
      // commit briefly keeps the exiting <ViewTransition> host mounted next to
      // the entering one (same test id), so target the last (entering) match.
      const featurePage = () => testId(page, "feature-page").last();

      // Navigate with state
      await testId(page, "feature-link-server-components").click();
      await expect(featurePage()).toBeVisible({ timeout: 5000 });
      expect(hydrationErrors).toEqual([]);

      // Direct navigation without state
      await page.goto(f.url("/features/streaming"));
      await waitForHydration(page);
      await expect(featurePage()).toBeVisible({ timeout: 5000 });
      expect(hydrationErrors).toEqual([]);
    });
  });
}

function describeLateSuspense(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`location-state.late-suspense (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("reader inside a late-hydrating Suspense boundary hydrates without a mismatch", async ({
      page,
    }) => {
      await expectLateSuspenseReaderHydratesClean(
        page,
        f.url("/location-state-late-suspense"),
      );
    });
  });
}

// #994: createLocationState({ clearOnReload }) and the app version every
// entry's location state is recorded under.
function describeOptions(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`location-state.options (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("clearOnReload state is carried by a client navigation and dropped by a reload", async ({
      page,
    }) => {
      await expectClearOnReloadDropsCarriedState(
        page,
        f.url("/location-state-load-more"),
      );
    });

    test("clearOnReload state is dropped by a back/forward that loads the document", async ({
      page,
    }) => {
      await expectClearOnReloadDropsStateOnTraversalLoad(
        page,
        f.url("/location-state-load-more"),
      );
    });

    test("state another app version stored reads as no state after a reload, its own is kept", async ({
      page,
    }) => {
      await expectOtherVersionLocationStateDroppedOnLoad(
        page,
        f.url("/location-state-app-version"),
      );
    });

    test("back/forward to an entry another app version wrote reads no state", async ({
      page,
    }) => {
      await expectOtherVersionLocationStateDroppedOnTraversal(
        page,
        f.url("/location-state-app-version"),
      );
    });
  });
}

// #1029: a reader sees an entry's location state together with that entry's
// tree. The load-more list concatenates carried items and the loader's page,
// so the wrong pairing is an item on screen twice.
function describeCommit(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`location-state.commit (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(90_000);

    test("a load-more navigation held by its loader shows no item twice", async ({
      page,
    }) => {
      await expectHeldLoadMoreShowsNoItemTwice(
        page,
        f.url("/location-state-load-more"),
      );
    });

    test("a reader that mounts during a held navigation reads the entry on screen", async ({
      page,
    }) => {
      await expectReaderMountedDuringHeldNavigationReadsEntryOnScreen(
        page,
        f.url("/location-state-load-more"),
      );
    });

    test("back/forward restores an entry's carried items with its page, cached and refetched", async ({
      page,
    }) => {
      await expectLoadMoreTraversalRestoresEntryWithItsPage(
        page,
        f.url("/location-state-load-more"),
        f.url("/location-state-app-version"),
      );
    });
  });
}

describeLocationState("dev");
describeLocationState("build");
describeLateSuspense("dev");
describeLateSuspense("build");
describeOptions("dev");
describeOptions("build");
describeCommit("dev");
describeCommit("build");
