import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

/**
 * Pre-render handler tests in dev mode.
 * Verifies that prerender handlers using node:fs work correctly in Cloudflare
 * dev where the RSC environment runs in workerd. The handler reads
 * content/releases.json via node:fs — this works because the cache-lookup
 * middleware fetches pre-rendered data from the Vite dev server's
 * /__rsc_prerender endpoint (Node.js) instead of running the handler in workerd.
 */
test.describe("prerender (dev mode)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should render releases page with node:fs handler on direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Releases");

    // Verify at least one release entry rendered from content/releases.json
    await expect(testId(page, "release-2.0.0")).toBeVisible();
    await expect(testId(page, "release-1.0.0")).toBeVisible();
  });

  test("should render releases page on subsequent direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Second direct visit should also work (prerender store is already initialized)
    await page.goto(f.url("/releases"));
    await waitForHydration(page);

    await expect(testId(page, "releases-page")).toBeVisible();
    await expect(testId(page, "release-2.0.0")).toBeVisible();
  });

  test("dev endpoint memoizes between edits on the workerd path: MISS then HIT, identical body", async ({
    request,
  }) => {
    // #654: the temp Node runner's render result is cached keyed by
    // router-instance identity. Omitting routeName keeps this key private to
    // the test (the runtime dev store always sends routeName), so the first
    // request is deterministically a MISS even on a shared dev server — a
    // concurrent identity churn still has no cached body for a fresh key.
    const url = f.url("/__rsc_prerender?pathname=/releases");

    const first = await request.get(url);
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-prerender-cache"]).toBe("MISS");
    const firstBody = await first.text();

    const parsed = JSON.parse(firstBody);
    expect(Array.isArray(parsed.segments)).toBe(true);
    expect(parsed.segments.length).toBeGreaterThan(0);

    // HIT via paired poll: a legitimate identity churn between the pair
    // (dep-optimizer re-optimization on the shared server) retries; a broken
    // cache never returns HIT and the poll times out. File-editing suites
    // cannot interfere here by construction — hmr* files run in a separate
    // project ordered after dev (dependencies: ["dev", "production"]).
    await expect
      .poll(
        async () => {
          const a = await request.get(url);
          const aBody = await a.text();
          const b = await request.get(url);
          const bBody = await b.text();
          return b.headers()["x-rango-prerender-cache"] === "HIT" &&
            bBody === aBody
            ? "HIT-identical"
            : `retry(${b.headers()["x-rango-prerender-cache"]})`;
        },
        { timeout: 15000 },
      )
      .toBe("HIT-identical");
  });
});
