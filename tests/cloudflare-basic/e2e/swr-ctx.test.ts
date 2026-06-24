import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Regression: a "use cache: swr-ctx" function (ttl=2s) that reads the ambient
// getRequestContext().env inside its body — the reported pattern
// getRequestContext().env.ApiKey used to fetch cached CMS data. On a stale hit
// the function re-executes in a background waitUntil task; on workerd that task
// runs detached from the request's I/O context, so the cache runtime must
// re-establish the request-context ALS. Otherwise getRequestContext() throws
// "called outside of a request context", the background revalidation fails, and
// the cached value freezes (never refreshes from the stale value).
//
// See src/pages/swr-ctx.tsx and the swr-ctx cacheProfile in src/router.tsx.
// Covered in BOTH dev and production (build) modes.
function describeSwrCtx(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`use-cache SWR + getRequestContext (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("background revalidation re-establishes the request context and refreshes the value", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Visit 1: cache miss — the cached function runs and reads
      // getRequestContext().env (has-env proves the ambient context was
      // reachable), then caches its timestamp.
      await page.goto(f.url("/swr-ctx"));
      await waitForHydration(page);
      await expect(testId(page, "swr-ctx-page")).toBeVisible();
      const ts1 = await testId(page, "swr-ctx-ts").textContent();
      await expect(testId(page, "swr-ctx-has-env")).toHaveText("true");
      expect(ts1).toMatch(/^\d+$/);

      // Wait for TTL (2s) to expire — the next read is a stale hit.
      await page.waitForTimeout(3000);

      // Stale hit returns the cached value and triggers background revalidation.
      // The cached function re-runs in the background and calls
      // getRequestContext() again. If that read threw, the revalidation would
      // fail and the value would stay frozen at ts1 — so poll until we see a
      // *different*, freshly-revalidated value whose env is still readable.
      await expect(async () => {
        await page.goto(f.url("/swr-ctx"));
        await waitForHydration(page);
        const ts = await testId(page, "swr-ctx-ts").textContent();
        expect(ts).not.toBe(ts1);
        await expect(testId(page, "swr-ctx-has-env")).toHaveText("true");
      }).toPass({ timeout: 20000 });
    });

    test("foregroundOnAction: a stale entry re-executes in the foreground during an action", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Visit 1: cache miss — the "use cache: swr-action" function (profile
      // foregroundOnAction:true) runs, reads getRequestContext().env, caches.
      await page.goto(f.url("/swr-action"));
      await waitForHydration(page);
      await expect(testId(page, "swr-action-page")).toBeVisible();
      const ts1 = await testId(page, "swr-action-ts").textContent();
      await expect(testId(page, "swr-action-has-env")).toHaveText("true");
      expect(ts1).toMatch(/^\d+$/);

      // Wait for TTL (2s) to expire — the entry is now stale.
      await page.waitForTimeout(3000);

      // Trigger the server action: its revalidation render hits the stale entry.
      // Because the profile opts into foregroundOnAction, the function
      // re-executes in the foreground, so the action response shows a fresh
      // value (not the stale ts1). The page updates in place — no navigation.
      await testId(page, "swr-action-btn").click();

      await expect(async () => {
        const ts = await testId(page, "swr-action-ts").textContent();
        expect(ts).not.toBe(ts1);
      }).toPass({ timeout: 15000 });

      // The foreground re-execution still resolved getRequestContext().env.
      await expect(testId(page, "swr-action-has-env")).toHaveText("true");
    });
  });
}

describeSwrCtx("dev");
describeSwrCtx("build");

// JS/PE parity: a no-JS form action submits a native POST handled by the PE
// path (progressive-enhancement.ts). That re-render must set
// _inActionRevalidation before matching, so a stale foregroundOnAction entry
// foregrounds exactly as the JS action path does — otherwise the PE response
// would show stale data. Covered in BOTH dev and production (build) modes.
function describeSwrActionPe(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`use-cache foregroundOnAction PE (${label})`, () => {
    test.use({ javaScriptEnabled: false });
    const f = useFixture({ root: ".", mode });

    test("no-JS form action foregrounds a stale foregroundOnAction entry", async ({
      page,
    }) => {
      await page.goto(f.url("/swr-action"));
      await expect(testId(page, "swr-action-page")).toBeVisible();
      const ts1 = await testId(page, "swr-action-ts").textContent();
      expect(ts1).toMatch(/^\d+$/);

      // Let the entry go stale (profile ttl=2s).
      await page.waitForTimeout(3000);

      // Native no-JS form POST -> PE re-render. With the PE parity fix this
      // foregrounds the stale entry, so the returned HTML shows a fresh value.
      await testId(page, "swr-action-btn").click();
      await page.waitForLoadState("domcontentloaded");

      await expect(testId(page, "swr-action-page")).toBeVisible();
      const ts2 = await testId(page, "swr-action-ts").textContent();
      expect(ts2).not.toBe(ts1);
      // getRequestContext().env resolved on the foreground re-exec during PE.
      await expect(testId(page, "swr-action-has-env")).toHaveText("true");
    });
  });
}

describeSwrActionPe("dev");
describeSwrActionPe("build");
