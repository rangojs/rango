import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * Cloudflare-basic coverage for transition({ when }), the browser-run
 * navigation predicate. Mirrors
 * packages/rangojs-router/e2e/conditional-transition.test.ts and
 * transition-when-browser.test.ts so the feature is pinned in BOTH the router
 * e2e app and cloudflare-basic (dev + production), per the repo's both-apps
 * e2e mandate.
 *
 * Fixtures: src/pages/tx-when.tsx. /tx-when/:hold/:n declares an inline
 * predicate (hoisted into a client module by the build) that holds when the
 * destination's :hold is "1"; /tx-src/:n imports txSrcWhen from
 * src/components/transition-when.ts, which logs every call to
 * window.__txWhenLog. A hold is observed on a SAME-route param nav, which
 * re-suspends the existing boundary: held, the previous content stays (no
 * loading() skeleton flash); gated off, the skeleton re-streams.
 *
 * Flash detection uses a MutationObserver on addedNodes so even a single-frame
 * skeleton is caught; a plain toBeHidden() would miss it.
 */

interface TxWhenLogEntry {
  name: string;
  kind: string;
  from: string;
  to: string;
  fromParams: Record<string, string>;
  toParams: Record<string, string>;
  toRouteName?: string;
  toAnimate?: boolean;
  result: boolean;
}

async function whenLog(page: Page): Promise<TxWhenLogEntry[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __txWhenLog?: TxWhenLogEntry[] }).__txWhenLog ??
      [],
  );
}

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

    async function openTxSrc(page: Page, n: string) {
      await page.goto(f.url(`/tx-src/${n}`));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n")).toHaveText(n, { timeout: 8000 });
    }

    async function clickTxSrc(page: Page, linkId: string, n: string) {
      await testId(page, linkId).click();
      await expect(testId(page, "tx-src-n")).toHaveText(n, { timeout: 8000 });
    }

    test("an inline when holds the same-route nav (no skeleton) when the destination's :hold is 1", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-when/1/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-when-n")).toHaveText("a", {
        timeout: 8000,
      });

      await watchFlash(page, "tx-when-loading");
      await testId(page, "tx-when-to-b").click();
      await expect(testId(page, "tx-when-n")).toHaveText("b", {
        timeout: 8000,
      });
      expect(
        await readFlash(page),
        "when -> true must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
    });

    test("an inline when re-streams the skeleton on same-route nav when the destination's :hold is 0", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-when/0/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-when-n")).toHaveText("a", {
        timeout: 8000,
      });

      await watchFlash(page, "tx-when-loading");
      await testId(page, "tx-when-to-b").click();
      await expect(testId(page, "tx-when-n")).toHaveText("b", {
        timeout: 8000,
      });
      expect(
        await readFlash(page),
        "when -> false must re-stream the loading() skeleton",
      ).toBe(true);
    });

    test("when runs in the browser with the navigation source, never on the document load, and holds away from n=a", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openTxSrc(page, "a");
      expect(await whenLog(page), "no decision on the document load").toEqual(
        [],
      );

      await watchFlash(page, "tx-src-loading");
      await clickTxSrc(page, "tx-src-to-b", "b");
      expect(
        await readFlash(page),
        "source n=a must hold the same-route nav (no skeleton flash)",
      ).toBe(false);
      expect(await whenLog(page)).toEqual([
        {
          name: "txSrc",
          kind: "push",
          from: "/tx-src/a",
          to: "/tx-src/b",
          fromParams: { n: "a" },
          toParams: { n: "b" },
          toRouteName: "txSrc",
          result: true,
        },
      ]);
    });

    test("when gates on the navigation source: re-streams when navigating away from n=b", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openTxSrc(page, "b");

      await watchFlash(page, "tx-src-loading");
      await clickTxSrc(page, "tx-src-to-a", "a");
      expect(
        await readFlash(page),
        "source n=b must re-stream the loading() skeleton",
      ).toBe(true);
      expect(await whenLog(page)).toEqual([
        expect.objectContaining({ from: "/tx-src/b", result: false }),
      ]);
    });

    test("Def.read(ctx.to): a Link pushing { animate: false } gates its navigation off", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openTxSrc(page, "a");

      await watchFlash(page, "tx-src-loading");
      await clickTxSrc(page, "tx-src-to-f-no-animate", "f");
      expect(await readFlash(page), "gated off: the skeleton streams").toBe(
        true,
      );
      expect(await whenLog(page)).toEqual([
        expect.objectContaining({
          kind: "push",
          to: "/tx-src/f",
          toAnimate: false,
          result: false,
        }),
      ]);
    });

    test("<Link transition={false}> gates its navigation off without calling when", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openTxSrc(page, "a");

      await watchFlash(page, "tx-src-loading");
      await clickTxSrc(page, "tx-src-to-g-no-transition", "g");
      expect(await readFlash(page), "gated off: the skeleton streams").toBe(
        true,
      );
      expect(await whenLog(page), "the predicate is never called").toEqual([]);
    });

    test("back/forward decides with kind pop against the entry left", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await openTxSrc(page, "a");
      await clickTxSrc(page, "tx-src-to-b", "b");
      await page.waitForTimeout(600);

      await page.goBack();
      await expect(testId(page, "tx-src-n")).toHaveText("a", { timeout: 8000 });
      await page.waitForTimeout(300);
      const pops = (await whenLog(page)).filter((e) => e.kind === "pop");
      expect(pops).toEqual([
        expect.objectContaining({
          from: "/tx-src/b",
          to: "/tx-src/a",
          fromParams: { n: "b" },
          toParams: { n: "a" },
          // Leaving n=b gates off.
          result: false,
        }),
      ]);
    });
  });
}

txWhenTransitionTests("dev");
txWhenTransitionTests("build");
