import {
  expect,
  test,
  type Page,
  type Request as PWRequest,
} from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  isPrefetchRequest,
  blockPrefetch,
} from "./helper";

/**
 * routerId signal tests
 *
 * Verifies that the server includes routerId in RSC partial responses
 * and the client sends _rsc_rid on subsequent requests. This is the
 * foundation for cross-app navigation detection when multiple routers
 * are mounted via the host router.
 */

// The click-driven NAVIGATION request must stay live and observable under
// default-on prefetch: a completed viewport prefetch of the bare
// search-home-link target would be adopted by the click (zero navigation
// requests), and an inflight one defers the live fetch past the click's
// resolution — so blockPrefetch keeps the cache virgin and waitForRequest
// (not a post-click array read) collects the fetch race-free. Blocked
// prefetches still emit request events, hence the predicate filter.
function nextNavRequest(page: Page): Promise<PWRequest> {
  return page.waitForRequest(
    (req) => req.url().includes("_rsc_partial") && !isPrefetchRequest(req),
  );
}

function routerIdTests(f: ReturnType<typeof useFixture>) {
  test("client sends _rsc_rid on SPA navigation (seeded from SSR)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await blockPrefetch(page);

    await page.goto(f.url("/search"));
    await waitForHydration(page);

    // SPA navigation — routerId seeded from SSR initial payload
    const navRequest = nextNavRequest(page);
    await page.getByTestId("search-home-link").click();
    await expect(page.getByTestId("app-root")).toBeVisible();

    const url = new URL((await navRequest).url());
    expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
  });

  test("_rsc_rid is stable across navigations within same router", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await blockPrefetch(page);

    await page.goto(f.url("/search"));
    await waitForHydration(page);

    // First nav
    const firstNavRequest = nextNavRequest(page);
    await page.getByTestId("search-home-link").click();
    await expect(page.getByTestId("app-root")).toBeVisible();
    const rid1 = new URL((await firstNavRequest).url()).searchParams.get(
      "_rsc_rid",
    );

    // Second nav — back to search
    await page.goto(f.url("/search"));
    await waitForHydration(page);
    const secondNavRequest = nextNavRequest(page);
    await page.getByTestId("search-home-link").click();
    await expect(page.getByTestId("app-root")).toBeVisible();
    const rid2 = new URL((await secondNavRequest).url()).searchParams.get(
      "_rsc_rid",
    );

    expect(rid1).toBeTruthy();
    expect(rid2).toBe(rid1);
  });
}

test.describe("router-id-signal", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  routerIdTests(f);
});

test.describe("router-id-signal (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  routerIdTests(f);
});
