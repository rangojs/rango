import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Hook render-stability suite.
//
// Each probe on /render-stability/p/:id calls exactly one router hook and is
// wrapped in React.memo, recording its render-phase invocations and committed
// renders on window.__RANGO_RENDERS__ (see e2e/test-app/src/render-tracker.ts).
//
// Two facts drive the assertions:
//   - Commit deltas across an interaction are StrictMode-invariant: StrictMode
//     doubles only the initial mount, never updates. So "did this re-render"
//     assertions use commit deltas and hold identically in every variant.
//   - The initial-mount RENDER count is the StrictMode signal: in development
//     StrictMode double-invokes render (2), and without it the body runs once
//     (1). In production StrictMode is a no-op, so both variants mount once.
//
// The strict variant uses the shared (default) server; the non-strict variant
// runs an isolated server with RANGO_STRICT=off, which makes the test-app
// router pass createRouter({ strictMode: false }). Comparing the two isolates
// StrictMode's intentional double-render from genuine re-renders.

const PROBES = [
  "router",
  "href",
  "pathname",
  "params",
  "search",
  "segments",
  "navigation",
] as const;

interface RenderSnapshot {
  renders: Record<string, number>;
  commits: Record<string, number>;
}

async function readRenders(page: Page): Promise<RenderSnapshot> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __RANGO_RENDERS__?: { snapshot(): RenderSnapshot };
        }
      ).__RANGO_RENDERS__?.snapshot() ?? { renders: {}, commits: {} },
  );
}

interface SuiteOpts {
  mode: "dev" | "build";
  strictMode: boolean;
  /**
   * Expected render-phase invocations per probe on the initial (hydration)
   * mount. StrictMode double-invokes render in development, so this is 2 when
   * StrictMode is on in dev, and 1 otherwise (off, or any production build where
   * StrictMode is a no-op).
   */
  mountRenders: number;
  /**
   * Expected committed renders per probe on the initial (hydration) mount.
   * StrictMode does NOT double-fire effects during hydration, so this is 1 in
   * every variant.
   */
  mountCommits: number;
  /**
   * Expected committed renders for one fresh CLIENT-side mount (e.g. the route
   * subtree remounting after a param change). Unlike hydration, StrictMode DOES
   * double-fire effects on a client mount in development, so this is 2 when
   * StrictMode is on in dev, and 1 otherwise.
   */
  remountCommits: number;
}

function defineStabilitySuite(opts: SuiteOpts) {
  // Derive the describe title from mode + strictMode so the `(production)`
  // bucket tag can never drift from the fixture mode. A build fixture ALWAYS
  // gets a `(production)` title and a dev fixture never does — closing the
  // guard-blind gap where an independently-passed title could silently land a
  // production suite in the dev bucket.
  const variant = opts.strictMode ? "" : " (strictMode off)";
  const prodTag = opts.mode === "build" ? " (production)" : "";
  const title = `Hook render stability${variant}${prodTag}`;

  test.describe(title, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode: opts.mode,
      // The non-strict variant must NOT reuse the shared (strict) server, so it
      // spawns its own server with RANGO_STRICT=off. The strict variant reuses
      // the shared dev/preview server (default = StrictMode on).
      isolatedServer: !opts.strictMode,
      cliOptions: opts.strictMode
        ? undefined
        : { env: { RANGO_STRICT: "off" } },
    });

    async function open(page: Page) {
      await page.goto(f.url("/render-stability/p/1"));
      await waitForHydration(page);
      await expect(testId(page, "probe-params")).toContainText("id:1");
      await expect(testId(page, "probe-search")).toContainText("n:none");
    }

    test("each probe mounts the expected number of times", async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page);

      const { renders, commits } = await readRenders(page);
      for (const probe of PROBES) {
        expect(renders[probe], `renders[${probe}]`).toBe(opts.mountRenders);
        expect(commits[probe], `commits[${probe}]`).toBe(opts.mountCommits);
      }
    });

    test("an unrelated local-state change re-renders zero probes", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await open(page);

      const before = await readRenders(page);
      await testId(page, "bump-local").click();
      await expect(testId(page, "page-tick")).toContainText("tick:1");
      // Give any (incorrect) re-render a chance to commit before asserting.
      await page.waitForTimeout(50);
      const after = await readRenders(page);

      for (const probe of PROBES) {
        expect(
          after.commits[probe]! - before.commits[probe]!,
          `commit delta[${probe}]`,
        ).toBe(0);
      }
    });

    test("a search-only change re-renders useSearchParams (plus nav state) and nothing else", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await open(page);

      const before = await readRenders(page);
      await testId(page, "change-search").click();
      // Same path, new search -> only the search slice and the transient
      // navigation state change.
      await expect(testId(page, "probe-search")).toContainText("n:1");
      await expect(testId(page, "probe-pathname")).toContainText(
        "path:/render-stability/p/1",
      );
      // Wait for navigation to settle back to idle so the nav-state churn is
      // fully counted (and exact-zero probes have had their chance to misfire).
      await expect(testId(page, "probe-navigation")).toContainText(
        "state:idle",
      );
      await page.waitForTimeout(50);
      const after = await readRenders(page);

      const delta = (probe: string) =>
        after.commits[probe]! - before.commits[probe]!;

      // The committed search string changed exactly once -> exactly one commit.
      // Exact (not >= 1) so a redundant re-render fails the contract.
      expect(delta("search"), "search committed").toBe(1);
      // useNavigation tracks the transient navigation state (idle -> loading ->
      // idle), so it legitimately re-renders at least once. This is why the
      // claim is NOT "only useSearchParams".
      expect(
        delta("navigation"),
        "navigation committed",
      ).toBeGreaterThanOrEqual(1);
      // Every other slice is unchanged: useRouter/useHref have no subscription
      // (and return referentially stable values); pathname/params/segments bail
      // out on equal values. EXACTLY zero re-renders.
      for (const probe of [
        "router",
        "href",
        "pathname",
        "params",
        "segments",
      ]) {
        expect(delta(probe), `commit delta[${probe}]`).toBe(0);
      }
    });

    test("a param change remounts the route subtree", async ({ page }) => {
      using _ = expectNoPageError(page);
      await open(page);

      const before = await readRenders(page);
      await testId(page, "change-param").click();
      await expect(testId(page, "probe-params")).toContainText("id:2");
      await expect(testId(page, "probe-pathname")).toContainText(
        "path:/render-stability/p/2",
      );

      await expect(testId(page, "probe-navigation")).toContainText(
        "state:idle",
      );
      await page.waitForTimeout(50);
      const after = await readRenders(page);
      const delta = (probe: string) =>
        after.commits[probe]! - before.commits[probe]!;

      // The param is part of the route segment key, so a param change remounts
      // the whole subtree uniformly: every probe — INCLUDING the stable-reference
      // hooks (useRouter/useHref) that a search change leaves untouched — gets
      // exactly one fresh client mount. Asserting the exact remount count (not
      // >= 1) is the contrast with the search-only case: there these are 0, here
      // they are all the same fresh-mount count.
      for (const probe of [
        "router",
        "href",
        "pathname",
        "params",
        "search",
        "segments",
      ]) {
        expect(delta(probe), `remount delta[${probe}]`).toBe(
          opts.remountCommits,
        );
      }
      // useNavigation additionally churns during the navigation (the OLD
      // instance re-renders on idle->loading before unmount), so it is at least
      // the fresh-mount count.
      expect(delta("navigation"), "navigation").toBeGreaterThanOrEqual(
        opts.remountCommits,
      );
    });
  });
}

// Dev, StrictMode on (default): the hydration render runs twice (the StrictMode
// signal), hydration effects run once, and a later client remount runs effects
// twice.
defineStabilitySuite({
  mode: "dev",
  strictMode: true,
  mountRenders: 2,
  mountCommits: 1,
  remountCommits: 2,
});

// Dev, StrictMode off: everything is exactly once — the doubling above is gone,
// which is precisely what createRouter({ strictMode: false }) isolates.
defineStabilitySuite({
  mode: "dev",
  strictMode: false,
  mountRenders: 1,
  mountCommits: 1,
  remountCommits: 1,
});

// Production: StrictMode is a no-op, so both variants behave identically and
// everything renders/commits exactly once. The strictMode option makes NO
// render-count difference in a production build.
defineStabilitySuite({
  mode: "build",
  strictMode: true,
  mountRenders: 1,
  mountCommits: 1,
  remountCommits: 1,
});

defineStabilitySuite({
  mode: "build",
  strictMode: false,
  mountRenders: 1,
  mountCommits: 1,
  remountCommits: 1,
});
