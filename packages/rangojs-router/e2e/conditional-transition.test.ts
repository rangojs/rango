import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * transition({ when }) — conditional hold.
 *
 * /tx-when/:hold/:n gates its transition with a browser predicate that holds
 * only when the destination's :hold param is "1" (txHoldWhen,
 * test-app/src/components/transition-when.ts). The hold is observed on a
 * SAME-route param nav (:n a -> b), which re-suspends the existing boundary:
 * when the predicate holds the previous content stays — no loading()
 * skeleton; false makes the commit urgent and the skeleton re-streams.
 *
 * Flash detection uses a MutationObserver on addedNodes so even a single-frame
 * skeleton is caught — a plain toBeHidden() would miss it.
 */

async function watchFlash(page: Page, fallbackTestId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as {
      __flash?: boolean;
      __obs?: MutationObserver;
    };
    w.__flash = document.querySelector(`[data-testid="${id}"]`) != null;
    const hit = (n: Node) =>
      n.nodeType === 1 &&
      ((n as Element).matches?.(`[data-testid="${id}"]`) ||
        (n as Element).querySelector?.(`[data-testid="${id}"]`) != null);
    w.__obs = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes)) if (hit(n)) w.__flash = true;
    });
    w.__obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }, fallbackTestId);
}
async function readFlash(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __flash?: boolean;
      __obs?: MutationObserver;
    };
    w.__obs?.disconnect();
    return w.__flash === true;
  });
}

function conditionalTransitionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`conditional-transition (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(40000);

    test("transition({ when }) holds the same-route nav (no skeleton) when the predicate returns true", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-when/1/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-when-n")).toHaveText("a", {
        timeout: 8000,
      });

      // Same-route nav a -> b: `when` returns true (:hold is "1"), so the
      // re-suspend is held — no skeleton flash.
      await watchFlash(page, "tx-when-loading");
      await testId(page, "tx-when-to-b").click();
      await expect(testId(page, "tx-when-n")).toHaveText("b", {
        timeout: 8000,
      });
      expect(
        await readFlash(page),
        "when true must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
    });

    test("transition({ when }) re-streams the skeleton on same-route nav when the predicate returns false", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-when/0/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-when-n")).toHaveText("a", {
        timeout: 8000,
      });

      // Same-route nav a -> b: `when` returns false (:hold is "0"), the commit
      // is urgent, so the boundary re-suspends and re-streams.
      await watchFlash(page, "tx-when-loading");
      await testId(page, "tx-when-to-b").click();
      await expect(testId(page, "tx-when-n")).toHaveText("b", {
        timeout: 8000,
      });
      expect(
        await readFlash(page),
        "when false must re-stream the loading() skeleton",
      ).toBe(true);
    });

    // /tx-src/:n gates on the navigation SOURCE: `({ from }) =>
    // from.params.n !== "b"`, the location being left. From-a holds, from-b
    // gates off.
    test("transition({ when }) gates on the navigation source: holds when navigating away from n=a", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n")).toHaveText("a", { timeout: 8000 });

      // Same-route nav a -> b: the predicate sees from.params.n === "a" (the
      // SOURCE) and holds — no flash.
      await watchFlash(page, "tx-src-loading");
      await testId(page, "tx-src-to-b").click();
      await expect(testId(page, "tx-src-n")).toHaveText("b", { timeout: 8000 });
      expect(
        await readFlash(page),
        "source n=a must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
    });

    test("transition({ when }) gates on the navigation source: re-streams when navigating away from n=b", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/b"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n")).toHaveText("b", { timeout: 8000 });

      // Same-route nav b -> a: from.params.n === "b", the predicate returns
      // false, so the boundary re-streams the skeleton.
      await watchFlash(page, "tx-src-loading");
      await testId(page, "tx-src-to-a").click();
      await expect(testId(page, "tx-src-n")).toHaveText("a", { timeout: 8000 });
      expect(
        await readFlash(page),
        "source n=b must re-stream the loading() skeleton",
      ).toBe(true);
    });

    // Action commits (kind "action") keep their hold whatever the predicate
    // returns; the context they see is pinned in
    // transition-when-browser.test.ts.
  });
}

conditionalTransitionTests("dev");
conditionalTransitionTests("build");
