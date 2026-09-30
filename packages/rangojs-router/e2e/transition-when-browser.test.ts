import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";
import {
  bump,
  clicks,
  goTxSrc,
  mounts,
  readFlash,
  watchFlash,
  whenLog,
} from "./transition-when-helpers";

/**
 * transition({ when }) is a browser predicate: it runs once per navigation,
 * at the first commit that presents the destination, with
 * { kind, from, to, isAction, action }. It never runs on the document load or
 * on the server.
 *
 * Fixtures: test-app/src/urls/conditional-transition.tsx (/tx-src, /tx-act),
 * prerender.tsx (/docs/:slug) and urls/client-urls-transition.tsx; the
 * predicates log to window.__txWhenLog / __ctWhenLog.
 */

function browserDecisionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`transition-when browser decision (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);

    test("a server-route when runs in the browser with the real source, never on the document load", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("a", {
        timeout: 8000,
      });
      expect(await whenLog(page), "no decision on the document load").toEqual(
        [],
      );

      await goTxSrc(page, "tx-src-to-b", "b");
      expect(await whenLog(page)).toEqual([
        {
          name: "txSrc",
          kind: "push",
          from: "/tx-src/a",
          to: "/tx-src/b",
          sameLocation: false,
          fromParams: { n: "a" },
          toParams: { n: "b" },
          fromRouteName: "txSrc",
          toRouteName: "txSrc",
          isAction: false,
          result: true,
        },
      ]);
    });

    test("an inline when in urls() is hoisted into a client module and decides in the browser", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const bodies: string[] = [];
      page.on("response", async (res) => {
        const u = new URL(res.url());
        if (!u.pathname.startsWith("/tx-inline/")) return;
        bodies.push(await res.text().catch(() => ""));
      });
      await page.goto(f.url("/tx-inline/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-inline-n").last()).toHaveText("a", {
        timeout: 8000,
      });
      const inlineLog = () =>
        page.evaluate(
          () =>
            (window as unknown as { __txInlineLog?: string[] }).__txInlineLog ??
            [],
        );
      expect(await inlineLog(), "no decision on the document load").toEqual([]);

      await watchFlash(page, "tx-inline-loading");
      await testId(page, "tx-inline-to-b").last().click();
      await expect(testId(page, "tx-inline-n").last()).toHaveText("b", {
        timeout: 8000,
      });
      expect(await readFlash(page), "into b: gated off").toBe(true);
      await page.waitForTimeout(600);

      await watchFlash(page, "tx-inline-loading");
      await testId(page, "tx-inline-to-c").last().click();
      await expect(testId(page, "tx-inline-n").last()).toHaveText("c", {
        timeout: 8000,
      });
      expect(await readFlash(page), "into c: holds").toBe(false);

      expect(await inlineLog()).toEqual([
        "push /tx-inline/a->/tx-inline/b:false",
        "push /tx-inline/b->/tx-inline/c:true",
      ]);
      // The payload carries the hoisted module's export as a client
      // reference, not the function.
      expect(bodies.join("")).toContain("__rango_when");
    });

    test("Def.read(ctx.to): a Link pushing { animate: false } gates its navigation off", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("a", {
        timeout: 8000,
      });

      await watchFlash(page, "tx-src-loading");
      await goTxSrc(page, "tx-src-to-f-no-animate", "f");
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
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("a", {
        timeout: 8000,
      });
      await bump(page, 2);
      const m0 = await mounts(page);

      // From a, txSrcWhen would hold; the opt-out commits urgently instead.
      await watchFlash(page, "tx-src-loading");
      await goTxSrc(page, "tx-src-to-g-no-transition", "g");
      expect(await readFlash(page), "gated off: the skeleton streams").toBe(
        true,
      );
      expect(await whenLog(page), "the predicate is never called").toEqual([]);
      // Same route: the segment reconciles, it does not remount (#995).
      expect(await mounts(page)).toBe(m0);
      expect(await clicks(page)).toBe("clicks:2");

      // The next navigation without the opt-out decides as usual.
      await goTxSrc(page, "tx-src-to-b", "b");
      expect(await whenLog(page)).toEqual([
        expect.objectContaining({
          kind: "push",
          from: "/tx-src/g",
          result: true,
        }),
      ]);
    });

    test("an action commit decides with kind action, to === from, and the action's formData and result", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/b"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("b", {
        timeout: 8000,
      });
      await bump(page, 2);
      const m0 = await mounts(page);

      // A form action (useActionState): React opens a transition for the
      // call, but the router's commit runs after the response, outside it.
      // Gated off, that commit is urgent and the re-rendered route segment
      // streams its loading() skeleton.
      await watchFlash(page, "tx-src-loading");
      await testId(page, "tx-action-run").click();
      await expect(testId(page, "tx-action-run")).toHaveText("actions:1", {
        timeout: 8000,
      });
      expect(await readFlash(page), "gated-off action commit is urgent").toBe(
        true,
      );
      await testId(page, "tx-action-run").click();
      await expect(testId(page, "tx-action-run")).toHaveText("actions:2", {
        timeout: 8000,
      });
      await page.waitForTimeout(600);

      const log = (await whenLog(page)).filter((e) => e.kind === "action");
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0]).toMatchObject({
        from: "/tx-src/b",
        to: "/tx-src/b",
        sameLocation: true,
        fromParams: { n: "b" },
        toRouteName: "txSrc",
        isAction: true,
        actionFormData: true,
        actionResult: 1,
        actionError: false,
        // Leaving b gates off: an urgent commit, and the gated-off tree keeps
        // useActionState and component state.
        result: false,
      });
      expect(await mounts(page)).toBe(m0);
      expect(await clicks(page)).toBe("clicks:2");
    });

    test("a failed action's error-boundary commit decides with action.error", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-act/x"));
      await waitForHydration(page);
      await expect(testId(page, "tx-act-n")).toHaveText("x");

      await testId(page, "tx-action-fail").click();
      await expect(testId(page, "tx-act-error")).toBeVisible({
        timeout: 8000,
      });
      expect(await whenLog(page)).toEqual([
        expect.objectContaining({
          name: "txAct",
          kind: "action",
          sameLocation: true,
          isAction: true,
          actionError: true,
          result: true,
        }),
      ]);
    });

    test("router.refresh() gated off commits urgently: the skeleton streams", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/b"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("b", {
        timeout: 8000,
      });

      // On b the predicate returns false (the source is n=b).
      await watchFlash(page, "tx-src-loading");
      await testId(page, "tx-refresh").click();
      await expect
        .poll(async () => (await whenLog(page)).length, { timeout: 8000 })
        .toBe(1);
      await expect(testId(page, "tx-src-loading")).toHaveCount(0, {
        timeout: 8000,
      });
      expect(await readFlash(page), "gated-off refresh is urgent").toBe(true);
      expect(await whenLog(page)).toEqual([
        expect.objectContaining({ kind: "revalidate", result: false }),
      ]);
    });

    test("router.refresh() decides with kind revalidate", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("a", {
        timeout: 8000,
      });

      await testId(page, "tx-refresh").click();
      await expect
        .poll(async () => (await whenLog(page)).length, { timeout: 8000 })
        .toBe(1);
      expect(await whenLog(page)).toEqual([
        expect.objectContaining({
          kind: "revalidate",
          from: "/tx-src/a",
          to: "/tx-src/a",
          sameLocation: true,
          isAction: false,
        }),
      ]);
    });

    test("back/forward decides with kind pop against the entry left", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/tx-src/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-src-n").last()).toHaveText("a", {
        timeout: 8000,
      });
      await bump(page, 2);
      const m0 = await mounts(page);
      await goTxSrc(page, "tx-src-to-b", "b");
      await page.goBack();
      await expect(testId(page, "tx-src-n").last()).toHaveText("a", {
        timeout: 8000,
      });
      await page.waitForTimeout(600);
      await page.goForward();
      await expect(testId(page, "tx-src-n").last()).toHaveText("b", {
        timeout: 8000,
      });
      await page.waitForTimeout(600);

      const log = await whenLog(page);
      expect(
        log.map(
          (e) =>
            `${e.kind} ${e.from}->${e.to} ${e.fromRouteName}->${e.toRouteName}:${e.result}`,
        ),
      ).toEqual([
        "push /tx-src/a->/tx-src/b txSrc->txSrc:true",
        "pop /tx-src/b->/tx-src/a txSrc->txSrc:false",
        "pop /tx-src/a->/tx-src/b txSrc->txSrc:true",
      ]);
      expect(await mounts(page)).toBe(m0);
      expect(await clicks(page)).toBe("clicks:2");
    });

    test("a prerendered route carries its when as a client reference and decides in the browser", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const bodies: string[] = [];
      page.on("response", async (res) => {
        const u = new URL(res.url());
        if (
          u.pathname !== "/docs/api-reference" ||
          !u.searchParams.has("_rsc_partial")
        )
          return;
        bodies.push(await res.text().catch(() => ""));
      });
      await page.goto(f.url("/docs/getting-started"));
      await waitForHydration(page);
      await testId(page, "docs-to-api-reference").click();
      await expect(testId(page, "docs-article-title")).toHaveText(
        "api-reference",
        { timeout: 8000 },
      );
      await page.waitForTimeout(300);

      expect(await whenLog(page)).toEqual([
        expect.objectContaining({
          name: "docs",
          kind: "push",
          from: "/docs/getting-started",
          to: "/docs/api-reference",
          fromRouteName: "docs.article",
          toRouteName: "docs.article",
          result: true,
        }),
      ]);
      // The stored artifact never holds the predicate; the payload carries it.
      expect(bodies.join("")).toContain("docsWhen");
    });

    test("clientUrls(): a same-route navigation decides at the commit, and false streams the skeleton", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/client-urls-transition/items/one"));
      await waitForHydration(page);
      await expect(testId(page, "ct-item-param")).toHaveText("one", {
        timeout: 8000,
      });

      await watchFlash(page, "ct-item-loading");
      await testId(page, "ct-item-to-three-gated").click();
      await expect(testId(page, "ct-item-param")).toHaveText("three", {
        timeout: 8000,
      });
      const gatedFlash = await readFlash(page);

      await watchFlash(page, "ct-item-loading");
      await testId(page, "ct-item-to-two").click();
      await expect(testId(page, "ct-item-param")).toHaveText("two", {
        timeout: 8000,
      });
      const heldFlash = await readFlash(page);

      expect(await whenLog(page, "__ctWhenLog")).toEqual([
        {
          name: "item",
          kind: "push",
          from: "/client-urls-transition/items/one",
          to: "/client-urls-transition/items/three?gate=off",
          fromParams: { itemId: "one" },
          toParams: { itemId: "three" },
          toRouteName: "clientTransition.item",
          result: false,
        },
        {
          name: "item",
          kind: "push",
          from: "/client-urls-transition/items/three?gate=off",
          to: "/client-urls-transition/items/two",
          fromParams: { itemId: "three" },
          toParams: { itemId: "two" },
          toRouteName: "clientTransition.item",
          result: true,
        },
      ]);
      expect(gatedFlash, "false opts out of the group's hold").toBe(true);
      expect(heldFlash, "true holds the same-route navigation").toBe(false);
    });

    test("clientUrls(): a cross-route navigation decides once, at the optimistic swap", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/client-urls-transition/items/one"));
      await waitForHydration(page);
      await expect(testId(page, "ct-item-param")).toHaveText("one", {
        timeout: 8000,
      });

      await testId(page, "ct-item-to-other-gated").click();
      await expect(testId(page, "ct-other-param")).toHaveText("one", {
        timeout: 8000,
      });
      await expect(testId(page, "ct-other-loader")).not.toBeEmpty();
      await page.waitForTimeout(300);

      // Decided at the swap (destination from the definition's match); the
      // canonical commit reused the decision instead of running it again.
      expect(await whenLog(page, "__ctWhenLog")).toEqual([
        {
          name: "other",
          kind: "push",
          from: "/client-urls-transition/items/one",
          to: "/client-urls-transition/other/one?gate=off",
          fromParams: { itemId: "one" },
          toParams: { itemId: "one" },
          toRouteName: "clientTransition.other",
          result: false,
        },
      ]);
    });

    test("clientUrls(): <Link transition={false}> gates the cross-route swap off without calling when", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/client-urls-transition/items/one"));
      await waitForHydration(page);
      await expect(testId(page, "ct-item-param")).toHaveText("one", {
        timeout: 8000,
      });

      await testId(page, "ct-item-to-other-no-transition").click();
      await expect(testId(page, "ct-other-param")).toHaveText("two", {
        timeout: 8000,
      });
      await expect(testId(page, "ct-other-loader")).not.toBeEmpty();
      await page.waitForTimeout(300);

      expect(
        await whenLog(page, "__ctWhenLog"),
        "neither the destination's nor a kept segment's when is called",
      ).toEqual([]);
    });
  });
}

browserDecisionTests("dev");
browserDecisionTests("build");
