import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * transition({ when }) — conditional hold.
 *
 * /tx-when/:hold/:n sets a mark in its handler (hold === "1") and gates its
 * transition with `when: (ctx) => ctx.get(mark) === true`, evaluated server-side
 * AFTER the handler. The hold is observed on a SAME-route param nav (:n a -> b),
 * which re-suspends the existing boundary: with the transition kept (mark true)
 * the previous content is held — no loading() skeleton flash; with it dropped
 * (mark false) the skeleton re-streams.
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

    test("transition({ when }) holds the same-route nav (no skeleton) when the handler-set mark is true", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-when/1/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-when-n")).toHaveText("a", {
        timeout: 8000,
      });

      // Same-route nav a -> b: the post-handler `when` returns true, the
      // transition is kept, so the re-suspend is held — no skeleton flash.
      await watchFlash(page, "tx-when-loading");
      await testId(page, "tx-when-to-b").click();
      await expect(testId(page, "tx-when-n")).toHaveText("b", {
        timeout: 8000,
      });
      expect(
        await readFlash(page),
        "mark=true must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
    });

    test("transition({ when }) re-streams the skeleton on same-route nav when the mark is false", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-when/0/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-when-n")).toHaveText("a", {
        timeout: 8000,
      });

      // Same-route nav a -> b: the post-handler `when` returns false, the router
      // drops the transition, so the boundary re-suspends and re-streams.
      await watchFlash(page, "tx-when-loading");
      await testId(page, "tx-when-to-b").click();
      await expect(testId(page, "tx-when-n")).toHaveText("b", {
        timeout: 8000,
      });
      expect(
        await readFlash(page),
        "mark=false must re-stream the loading() skeleton",
      ).toBe(true);
    });

    // /tx-src/:n gates on the navigation SOURCE: `when: ({ currentParams }) =>
    // currentParams?.n !== "b"`. This pins that the predicate now receives the
    // revalidate-shaped nav metadata (currentParams = the page navigated away
    // from) end-to-end, in both dev and production. (`!== "b"` is true on the
    // initial load where currentParams is undefined, so the route mounts inside
    // a transition scope; from-a holds, from-b drops.)
    test("transition({ when }) gates on the navigation source: holds when navigating away from n=a", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n")).toHaveText("a", { timeout: 8000 });

      // Same-route nav a -> b: the gate sees currentParams.n === "a" (the
      // SOURCE), keeps the transition, so the re-suspend holds — no flash.
      await watchFlash(page, "tx-src-loading");
      await testId(page, "tx-src-to-b").click();
      await expect(testId(page, "tx-src-n")).toHaveText("b", { timeout: 8000 });
      expect(
        await readFlash(page),
        "source n=a (currentParams.n !== 'b') must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
    });

    test("transition({ when }) gates on the navigation source: re-streams when navigating away from n=b", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/b"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n")).toHaveText("b", { timeout: 8000 });

      // Same-route nav b -> a: currentParams.n === "b", predicate returns false,
      // the transition is dropped, so the boundary re-streams the skeleton.
      await watchFlash(page, "tx-src-loading");
      await testId(page, "tx-src-to-a").click();
      await expect(testId(page, "tx-src-n")).toHaveText("a", { timeout: 8000 });
      expect(
        await readFlash(page),
        "source n=b (currentParams.n !== 'b' is false) must re-stream the loading() skeleton",
      ).toBe(true);
    });

    // NOTE on action-triggered gating: the gate DOES receive the action fields
    // (actionId/actionResult/formData/method) on a server-action revalidation —
    // pinned through the public type in src/testing/__tests__/transition-when.test.ts.
    // There is intentionally no browser assertion for it here: an action
    // revalidation holds the route's content by default (stale-while-revalidate),
    // so dropping the transition produces no observable skeleton, and on stable
    // React the <ViewTransition> animation is a no-op. The action fields gate the
    // animation, not a content-hold, so the only end-to-end coverage that adds
    // signal is the unit test.
  });
}

conditionalTransitionTests("dev");
conditionalTransitionTests("build");
