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
} from "./transition-when-helpers";

/**
 * transition({ when }) regressions, asserted on what the page does (mounts,
 * component state, the loading fallback), not on the predicate API:
 *
 * - #995: a `when` that flips true -> false -> true on the same route never
 *   remounts it. The decision only switches the <ViewTransition> classes and
 *   the commit lane; the route keeps its key.
 * - #989: a layout the navigation keeps (never re-sent) is decided too. Its
 *   `when` returning false makes the sibling navigation urgent: no view
 *   transition runs (document.startViewTransition is counted).
 * - prefetch source: a prefetched response carries no decision, so reusing a
 *   prefetch fired from another page is decided against the page actually
 *   left.
 *
 * Fixtures: /tx-src/:n (hold unless leaving n=b) and /tx-keep (layout `when`,
 * false into /tx-keep/b), test-app/src/urls/conditional-transition.tsx.
 */

function regressionTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`transition-when regressions (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });
    test.setTimeout(60000);

    test("#995: state survives when true -> false -> true, and false still streams the skeleton", async ({
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

      await watchFlash(page, "tx-src-loading");
      await goTxSrc(page, "tx-src-to-b", "b"); // leaving a: holds
      expect(await readFlash(page), "a -> b holds").toBe(false);
      expect(await clicks(page)).toBe("clicks:2");

      await watchFlash(page, "tx-src-loading");
      await goTxSrc(page, "tx-src-to-a", "a"); // leaving b: gated off
      expect(await readFlash(page), "b -> a streams the skeleton").toBe(true);
      expect(await clicks(page), "b -> a keeps component state").toBe(
        "clicks:2",
      );

      await bump(page, 3);
      await watchFlash(page, "tx-src-loading");
      await goTxSrc(page, "tx-src-to-b", "b"); // leaving a: holds again
      expect(await readFlash(page), "a -> b holds again").toBe(false);
      expect(await clicks(page)).toBe("clicks:5");
      expect(await mounts(page), "no remount across the flip").toBe(m0);
    });

    test("#989: a kept layout's when gates a sibling navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.addInitScript(() => {
        const w = window as unknown as { __vtCount?: number };
        w.__vtCount = 0;
        const original = document.startViewTransition?.bind(document);
        if (!original) return;
        document.startViewTransition = ((arg: unknown) => {
          w.__vtCount = (w.__vtCount ?? 0) + 1;
          return original(arg as never);
        }) as typeof document.startViewTransition;
      });
      const vtCount = () =>
        page.evaluate(
          () => (window as unknown as { __vtCount?: number }).__vtCount ?? 0,
        );
      await page.goto(f.url("/tx-keep/a"));
      await waitForHydration(page);
      await expect(testId(page, "tx-keep-n")).toHaveText("a", {
        timeout: 8000,
      });

      // Into c the kept layout's when holds: the layout's <ViewTransition>
      // animates the outlet.
      await testId(page, "tx-keep-to-c").click();
      await expect(testId(page, "tx-keep-n")).toHaveText("c", {
        timeout: 8000,
      });
      await expect.poll(vtCount, { timeout: 4000 }).toBe(1);

      // Into b it returns false for the layout the navigation keeps: urgent,
      // no view transition.
      await testId(page, "tx-keep-to-b").click();
      await expect(testId(page, "tx-keep-n")).toHaveText("b", {
        timeout: 8000,
      });
      await page.waitForTimeout(500);
      expect(
        await vtCount(),
        "c -> b: the kept layout's when is false, so nothing animates",
      ).toBe(1);
    });

    test("prefetch source: a prefetch reused from another page is decided against the page left", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const cRequests: string[] = [];
      page.on("request", (req) => {
        const u = new URL(req.url());
        if (u.pathname !== "/tx-src/c" || !u.searchParams.has("_rsc_partial"))
          return;
        const source = req.headers()["x-rsc-router-client-path"];
        cRequests.push(source ? new URL(source).pathname : "?");
      });
      const prefetched = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/tx-src/c" &&
          new URL(r.url()).searchParams.has("_rsc_partial"),
        { timeout: 15000 },
      );
      // /tx-src/c is render-prefetched from b, where the when is false.
      await page.goto(f.url("/tx-src/b"));
      await waitForHydration(page);
      await (await prefetched).finished();
      await page.waitForTimeout(300);

      await goTxSrc(page, "tx-src-to-a", "a");
      await goTxSrc(page, "tx-src-to-d", "d");
      await bump(page, 3);
      const m0 = await mounts(page);
      await goTxSrc(page, "tx-src-to-e", "e");

      // Leaving e the when holds, whatever the prefetch's origin said.
      await watchFlash(page, "tx-src-loading");
      await goTxSrc(page, "tx-src-to-c-pf", "c");
      expect(
        cRequests,
        "the navigation reused the prefetch fired from b",
      ).toEqual(["/tx-src/b"]);
      expect(await readFlash(page), "e -> c holds").toBe(false);
      expect(await mounts(page), "e -> c does not remount").toBe(m0);
      expect(await clicks(page)).toBe("clicks:3");
    });
  });
}

regressionTests("dev");
regressionTests("build");
