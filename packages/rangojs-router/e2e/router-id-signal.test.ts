import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * routerId signal tests
 *
 * Verifies that the server includes routerId in RSC partial responses
 * and the client sends _rsc_rid on subsequent requests. This is the
 * foundation for cross-app navigation detection when multiple routers
 * are mounted via the host router.
 */

function routerIdTests(f: ReturnType<typeof useFixture>) {
  test("client sends _rsc_rid on SPA navigation (seeded from SSR)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        rscRequests.push(req.url());
      }
    });

    await page.goto(f.url("/search"));
    await waitForHydration(page);

    // SPA navigation — routerId seeded from SSR initial payload
    await page.getByTestId("search-home-link").click();
    await expect(page.getByTestId("app-root")).toBeVisible();

    expect(rscRequests.length).toBeGreaterThanOrEqual(1);
    const url = new URL(rscRequests[0]);
    expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
  });

  test("_rsc_rid is stable across navigations within same router", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("_rsc_partial")) {
        rscRequests.push(req.url());
      }
    });

    await page.goto(f.url("/search"));
    await waitForHydration(page);

    // First nav
    await page.getByTestId("search-home-link").click();
    await expect(page.getByTestId("app-root")).toBeVisible();

    // Second nav — back to search
    await page.goto(f.url("/search"));
    await waitForHydration(page);
    await page.getByTestId("search-home-link").click();
    await expect(page.getByTestId("app-root")).toBeVisible();

    expect(rscRequests.length).toBeGreaterThanOrEqual(2);
    const rid1 = new URL(rscRequests[0]).searchParams.get("_rsc_rid");
    const rid2 = new URL(rscRequests[1]).searchParams.get("_rsc_rid");
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
