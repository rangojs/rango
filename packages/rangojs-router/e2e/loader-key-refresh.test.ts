import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Client refresh `key` on useLoader / useFetchLoader.
 *
 * The `key` option partitions the shared client refresh store so that only
 * hooks sharing a key refresh together when one calls load(). It works for
 * loaders that are NOT route-registered (keyed useFetchLoader), letting
 * unrelated components opt into sharing, and for registered loaders (keyed
 * readers share while a no-key reader keeps the seeded value).
 *
 * Covered scenarios (see e2e/test-app/src/urls/key-refresh.tsx):
 *   - shared key            -> a load() refreshes the whole keyed group
 *   - distinct keys         -> independent
 *   - no key                -> unregistered loads stay local (unchanged)
 *   - keyed throwOnError    -> only the originator throws; sibling exposes error
 *   - registered + key      -> keyed readers share; no-key reader keeps seed
 *   - lifecycle persistent  -> keyed reader in a layout survives navigation
 *   - lifecycle route-scoped-> keyed reader resets when it unmounts
 *   - cross-loader group    -> useRefreshLoaders() refreshes tagged loaders
 *   - multi-tag groups      -> a read tagged into several groups; a fine tag
 *                              refreshes a subset, the coarse tag or a union
 *                              argument refreshes the whole set
 */

function describeKeyRefresh(label: string, mode: "dev" | "build") {
  test.describe(`key-refresh (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: mode === "dev" ? true : undefined,
    });

    test.setTimeout(30000);

    test("shared key: one load() refreshes the whole keyed group", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-shared"));
      await waitForHydration(page);

      // Unregistered loader: no route context to seed from yet.
      await expect(testId(page, "key-refresh-A-value")).toHaveText("—");
      await expect(testId(page, "key-refresh-B-value")).toHaveText("—");

      // A loads; both A and the keyless-button sibling B (same key) converge.
      await testId(page, "key-refresh-A-load-btn").click();
      await expect(testId(page, "key-refresh-A-value")).not.toHaveText("—");
      const v1 = (await testId(page, "key-refresh-A-value").textContent())!;
      await expect(testId(page, "key-refresh-B-value")).toHaveText(v1);

      // A second load() must move BOTH reads to the new value.
      await testId(page, "key-refresh-A-load-btn").click();
      await expect(testId(page, "key-refresh-A-value")).not.toHaveText(v1);
      const v2 = (await testId(page, "key-refresh-A-value").textContent())!;
      await expect(testId(page, "key-refresh-B-value")).toHaveText(v2);
    });

    test("distinct keys: a load() stays within its own key", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-distinct"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-A-value")).toHaveText("—");
      await expect(testId(page, "key-refresh-B-value")).toHaveText("—");

      // A (key "a") loads; B (key "b") must NOT absorb it.
      await testId(page, "key-refresh-A-load-btn").click();
      await expect(testId(page, "key-refresh-A-value")).not.toHaveText("—");
      await expect(testId(page, "key-refresh-B-value")).toHaveText("—");
    });

    test("no key: unregistered loads stay local to the caller", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-nokey"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-A-value")).toHaveText("—");
      await expect(testId(page, "key-refresh-B-value")).toHaveText("—");

      // No key + unregistered loader: A's load() is local; B does not see it.
      await testId(page, "key-refresh-A-load-btn").click();
      await expect(testId(page, "key-refresh-A-value")).not.toHaveText("—");
      await expect(testId(page, "key-refresh-B-value")).toHaveText("—");
    });

    test("keyed error: only the originator throws, sibling exposes the error", async ({
      page,
    }) => {
      // Page-error guard intentionally omitted — a thrown render is expected
      // from the originator and would trip the assertion.

      await page.goto(f.url("/key-refresh-error"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-error-page")).toBeVisible();
      await expect(testId(page, "key-refresh-err-A-error")).toHaveText("—");
      await expect(testId(page, "key-refresh-err-B-error")).toHaveText("—");

      // A triggers a failing keyed load(); A's render throws into its boundary.
      await testId(page, "key-refresh-err-A-load-btn").click();
      await expect(testId(page, "key-refresh-err-A-fallback")).toBeVisible();

      // B shares the key and so sees the same error, but it did not originate
      // the request — it must NOT throw, only expose the error.
      await expect(testId(page, "key-refresh-err-B-fallback")).toHaveCount(0);
      await expect(testId(page, "key-refresh-err-B")).toBeVisible();
      await expect(testId(page, "key-refresh-err-B-error")).not.toHaveText("—");
    });

    test("registered + key: keyed readers share, no-key reader keeps seed", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-registered"));
      await waitForHydration(page);

      // All three readers seed from the same SSR-provided context value.
      const seed = (await testId(
        page,
        "key-refresh-reg-A-value",
      ).textContent())!;
      expect(seed).not.toBe("—");
      await expect(testId(page, "key-refresh-reg-B-value")).toHaveText(seed);
      await expect(testId(page, "key-refresh-reg-C-value")).toHaveText(seed);

      // A (key "reg") refetches: A and B (same key) move; C (no key) holds.
      await testId(page, "key-refresh-reg-A-load-btn").click();
      await expect(testId(page, "key-refresh-reg-A-value")).not.toHaveText(
        seed,
      );
      const after = (await testId(
        page,
        "key-refresh-reg-A-value",
      ).textContent())!;
      await expect(testId(page, "key-refresh-reg-B-value")).toHaveText(after);
      await expect(testId(page, "key-refresh-reg-C-value")).toHaveText(seed);
    });

    test("lifecycle: a persistent keyed reader survives navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-life/a"));
      await waitForHydration(page);

      // The "persist" reader lives in the layout, outside the outlet.
      await expect(testId(page, "key-refresh-persist-value")).toHaveText("—");
      await testId(page, "key-refresh-persist-load-btn").click();
      await expect(testId(page, "key-refresh-persist-value")).not.toHaveText(
        "—",
      );
      const pv = (await testId(
        page,
        "key-refresh-persist-value",
      ).textContent())!;

      // Navigate to the sibling child. The layout (and persist reader) stay
      // mounted, so the ephemeral keyed bucket must NOT blank out.
      await testId(page, "key-refresh-life-link-b").click();
      await expect(testId(page, "key-refresh-life-b")).toBeVisible();
      await expect(testId(page, "key-refresh-persist-value")).toHaveText(pv);
    });

    test("lifecycle: a route-scoped keyed reader resets on remount", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-life/a"));
      await waitForHydration(page);

      // The "scoped" reader lives inside the /a child route.
      await expect(testId(page, "key-refresh-scoped-value")).toHaveText("—");
      await testId(page, "key-refresh-scoped-load-btn").click();
      await expect(testId(page, "key-refresh-scoped-value")).not.toHaveText(
        "—",
      );

      // Navigate away (scoped reader unmounts) then back. Its ephemeral bucket
      // was reclaimed by refcount, so the value resets to the placeholder.
      await testId(page, "key-refresh-life-link-b").click();
      await expect(testId(page, "key-refresh-life-b")).toBeVisible();
      await testId(page, "key-refresh-life-link-a").click();
      await expect(testId(page, "key-refresh-life-a")).toBeVisible();
      await expect(testId(page, "key-refresh-scoped-value")).toHaveText("—");
    });

    test("cross-loader group: useRefreshLoaders refreshes every member", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-group"));
      await waitForHydration(page);

      // Two different loaders, both tagged with refreshGroup "account".
      await expect(testId(page, "key-refresh-group-A-value")).toHaveText("—");
      await expect(testId(page, "key-refresh-group-B-value")).toHaveText("—");

      // One refreshAccount() call re-runs BOTH members.
      await testId(page, "key-refresh-group-refresh-btn").click();
      await expect(testId(page, "key-refresh-group-A-value")).not.toHaveText(
        "—",
      );
      await expect(testId(page, "key-refresh-group-B-value")).not.toHaveText(
        "—",
      );
      const a1 = (await testId(
        page,
        "key-refresh-group-A-value",
      ).textContent())!;
      const b1 = (await testId(
        page,
        "key-refresh-group-B-value",
      ).textContent())!;

      // A second group refresh must advance BOTH again (proves both refetch,
      // not just a one-time seed).
      await testId(page, "key-refresh-group-refresh-btn").click();
      await expect(testId(page, "key-refresh-group-A-value")).not.toHaveText(
        a1,
      );
      await expect(testId(page, "key-refresh-group-B-value")).not.toHaveText(
        b1,
      );
    });

    test("group with a failing member: no render-throw, error surfaces, healthy member advances", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-group-error"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-errgroup-ok-value")).toHaveText(
        "—",
      );
      await expect(testId(page, "key-refresh-errgroup-fail-error")).toHaveText(
        "—",
      );

      // One group refresh runs both members. The failing one rejects, the
      // healthy one resolves; the rejection must NOT trip an error boundary.
      await testId(page, "key-refresh-errgroup-refresh-btn").click();

      // Failing member surfaces its error via `error` (not a render-throw).
      await expect(
        testId(page, "key-refresh-errgroup-fail-error"),
      ).not.toHaveText("—");
      // Healthy member still advances despite the sibling failure.
      await expect(
        testId(page, "key-refresh-errgroup-ok-value"),
      ).not.toHaveText("—");
      const ok1 = (await testId(
        page,
        "key-refresh-errgroup-ok-value",
      ).textContent())!;

      // A second refresh still advances the healthy member (it keeps refetching
      // even though its group sibling keeps failing).
      await testId(page, "key-refresh-errgroup-refresh-btn").click();
      await expect(
        testId(page, "key-refresh-errgroup-ok-value"),
      ).not.toHaveText(ok1);
    });

    test("multi-tag groups: fine tags refresh a subset, coarse/union refresh the set", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-multitag"));
      await waitForHydration(page);

      const a = testId(page, "key-refresh-mt-A-value");
      const b = testId(page, "key-refresh-mt-B-value");

      // A is tagged ["all", "left"], B is tagged ["all", "right"]; both empty.
      await expect(a).toHaveText("—");
      await expect(b).toHaveText("—");

      // Fine tag "left" hits only A.
      await testId(page, "key-refresh-group-btn-left").click();
      await expect(a).not.toHaveText("—");
      await expect(b).toHaveText("—");
      const a1 = (await a.textContent())!;

      // Fine tag "right" hits only B; A is untouched (its value holds).
      await testId(page, "key-refresh-group-btn-right").click();
      await expect(b).not.toHaveText("—");
      await expect(a).toHaveText(a1);
      const b1 = (await b.textContent())!;

      // Coarse tag "all" refreshes the whole set — BOTH advance.
      await testId(page, "key-refresh-group-btn-all").click();
      await expect(a).not.toHaveText(a1);
      await expect(b).not.toHaveText(b1);
      const a2 = (await a.textContent())!;
      const b2 = (await b.textContent())!;

      // Union argument ["left", "right"] also refreshes both (each member's
      // bucket is fetched once even though A and B sit in different fine tags).
      await testId(page, "key-refresh-group-btn-both").click();
      await expect(a).not.toHaveText(a2);
      await expect(b).not.toHaveText(b2);
    });

    test("grouped no-key reader: a group refresh updates a value it loaded itself", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-group-load"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-GL-value")).toHaveText("—");

      // A direct load() on a grouped no-key reader must land in its (private)
      // bucket, not local state...
      await testId(page, "key-refresh-GL-load-btn").click();
      await expect(testId(page, "key-refresh-GL-value")).not.toHaveText("—");
      const v1 = (await testId(page, "key-refresh-GL-value").textContent())!;

      // ...so a subsequent group refresh moves it. (Regression: local state
      // used to shadow the bucket, making the group refresh invisible.)
      await testId(page, "key-refresh-group-btn-g2").click();
      await expect(testId(page, "key-refresh-GL-value")).not.toHaveText(v1);
    });

    test("keyed parameterized GET shares within the key", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-params"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-param-A-tag")).toHaveText("—");
      await expect(testId(page, "key-refresh-param-B-tag")).toHaveText("—");

      // A's keyed load({ params: { tag } }) broadcasts to the same-key sibling B
      // — the widened behavior: parameterized GETs share when keyed.
      await testId(page, "key-refresh-param-A-load-btn").click();
      await expect(testId(page, "key-refresh-param-A-tag")).toHaveText("alpha");
      await expect(testId(page, "key-refresh-param-B-tag")).toHaveText("alpha");
    });

    test("keyed mutation (POST/body) stays local even with a key", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-mutation"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-param-A-tag")).toHaveText("—");
      await expect(testId(page, "key-refresh-param-B-tag")).toHaveText("—");

      // A's load({ method: "POST", body }) is a mutation — it stays local even
      // though A and B share a key. B must NOT absorb A's result.
      await testId(page, "key-refresh-param-A-load-btn").click();
      await expect(testId(page, "key-refresh-param-A-tag")).toHaveText(
        "posted",
      );
      await expect(testId(page, "key-refresh-param-B-tag")).toHaveText("—");
    });

    test("grouped no-key reader does not leak a group refresh to unrelated readers", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/key-refresh-group-private"));
      await waitForHydration(page);

      await expect(testId(page, "key-refresh-G-value")).toHaveText("—");
      await expect(testId(page, "key-refresh-U-value")).toHaveText("—");

      // Refresh the group. G (grouped, no key) updates; U (unrelated, no key,
      // no group) must stay put — the grouped reader has a private bucket, so
      // the refresh can't leak into the bare loader-id bucket U reads.
      await testId(page, "key-refresh-group-btn-priv").click();
      await expect(testId(page, "key-refresh-G-value")).not.toHaveText("—");
      await expect(testId(page, "key-refresh-U-value")).toHaveText("—");
    });
  });
}

describeKeyRefresh("dev", "dev");
describeKeyRefresh("production", "build");
