import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Hook render-stability suite for the Cloudflare app — the dual-app counterpart
// to packages/rangojs-router/e2e/hook-render-stability.test.ts. It proves the
// render-tracker harness, StrictMode-by-default hydration, and hook re-render
// isolation all hold inside a real CF worker, in BOTH dev and production.
//
// This app keeps StrictMode at its default (on): a CF worker reads env through
// wrangler `vars`, not the dev process env, so the RANGO_STRICT=off toggle used
// by the test-app's non-strict variant is not reliable here. The strictMode:
// false ISOLATION is covered by the test-app suite (node, reliable process.env);
// the strictMode option's metadata flow is preset-agnostic (shared rsc-rendering
// path), so proving the default-on behavior in CF is the meaningful CF coverage.

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
  /** Hydration render-phase count per probe (2 in dev under StrictMode, else 1). */
  mountRenders: number;
  /** Hydration commit count per probe (StrictMode never doubles hydration effects). */
  mountCommits: number;
  /** One fresh client mount's commit count (2 in dev under StrictMode, else 1). */
  remountCommits: number;
}

function defineStabilitySuite(opts: SuiteOpts) {
  // Title DERIVED from mode so the `(production)` bucket tag can never drift.
  const title = `Hook render stability${opts.mode === "build" ? " (production)" : ""}`;

  test.describe(title, () => {
    const f = useFixture({ root: ".", mode: opts.mode });

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
      await expect(testId(page, "probe-search")).toContainText("n:1");
      await expect(testId(page, "probe-pathname")).toContainText(
        "path:/render-stability/p/1",
      );
      await expect(testId(page, "probe-navigation")).toContainText(
        "state:idle",
      );
      await page.waitForTimeout(50);
      const after = await readRenders(page);

      const delta = (probe: string) =>
        after.commits[probe]! - before.commits[probe]!;

      expect(delta("search"), "search committed").toBe(1);
      expect(
        delta("navigation"),
        "navigation committed",
      ).toBeGreaterThanOrEqual(1);
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
      expect(delta("navigation"), "navigation").toBeGreaterThanOrEqual(
        opts.remountCommits,
      );
    });
  });
}

// Dev: StrictMode on by default -> hydration render runs twice; a client remount
// runs effects twice.
defineStabilitySuite({
  mode: "dev",
  mountRenders: 2,
  mountCommits: 1,
  remountCommits: 2,
});

// Production: StrictMode is a no-op, so everything renders/commits exactly once.
defineStabilitySuite({
  mode: "build",
  mountRenders: 1,
  mountCommits: 1,
  remountCommits: 1,
});
