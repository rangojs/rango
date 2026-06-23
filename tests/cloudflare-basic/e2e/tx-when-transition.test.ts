import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Cloudflare-basic coverage for transition({ when }) — the conditional,
 * post-handler transition gate. Mirrors
 * packages/rangojs-router/e2e/conditional-transition.test.ts so the feature is
 * pinned in BOTH the router e2e app and cloudflare-basic (dev + production), per
 * the repo's both-apps e2e mandate.
 *
 * /tx-when/:hold/:n sets a mark from :hold; the post-handler `when` predicate
 * reads it. The hold is observed on a SAME-route param nav (:n a -> b), which
 * re-suspends the existing boundary: with the transition kept (mark true) the
 * previous content is held (no loading() skeleton flash); with it dropped (mark
 * false) the skeleton re-streams.
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

function txWhenTransitionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`tx-when transition (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    test.setTimeout(60000);

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
  });
}

txWhenTransitionTests("dev");
txWhenTransitionTests("build");
