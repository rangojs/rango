import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";

test.describe.configure({ mode: "serial" });

// rango-state is stored under `rango-state:{routerId}` so sibling apps on
// the same origin don't collide. Find the namespaced key without hard-coding
// the router id.
async function findRangoStateKey(page: Page): Promise<string> {
  return await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === "rango-state" || key?.startsWith("rango-state:")) {
        return key;
      }
    }
    return "rango-state";
  });
}

async function readRangoStateAt(
  page: Page,
  key: string,
): Promise<string | null> {
  return await page.evaluate((k) => localStorage.getItem(k), key);
}

// ----- DEV MODE -----

test.describe("multi-router (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test.describe("site app (localhost)", () => {
    test("should render home page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(testId(page, "site-home-page")).toBeVisible();
      await expect(testId(page, "site-home-title")).toHaveText(
        "Welcome to the Site",
      );
      await expect(testId(page, "site-nav")).toBeVisible();
    });

    test("should navigate to about page via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await using __ = await expectNoReload(page);

      await testId(page, "site-nav-about").click();

      await expect(page).toHaveURL(/\/about/);
      await expect(testId(page, "site-about-page")).toBeVisible();
      await expect(testId(page, "site-about-title")).toHaveText("About");
    });

    test("should render about page on direct visit", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/about"));
      await waitForHydration(page);

      await expect(testId(page, "site-about-page")).toBeVisible();
      await expect(testId(page, "site-about-title")).toHaveText("About");
    });
  });

  test.describe("admin app (admin.localhost)", () => {
    test("should render dashboard page", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await expect(testId(page, "admin-dashboard-page")).toBeVisible();
      await expect(testId(page, "admin-dashboard-title")).toHaveText(
        "Admin Dashboard",
      );
      await expect(testId(page, "admin-nav")).toBeVisible();
    });

    test("should navigate to users page via link", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await using __ = await expectNoReload(page);

      await testId(page, "admin-nav-users").click();

      await expect(page).toHaveURL(/\/users/);
      await expect(testId(page, "admin-users-page")).toBeVisible();
      await expect(testId(page, "admin-users-title")).toHaveText("Users");
    });

    test("should render users page on direct visit", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/users").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await expect(testId(page, "admin-users-page")).toBeVisible();
      await expect(testId(page, "admin-users-title")).toHaveText("Users");
    });
  });

  test.describe("manifest isolation", () => {
    test("/users on site domain should 404", async ({ page }) => {
      const response = await page.goto(f.url("/users"));

      // /users belongs to admin app, should 404 on site domain.
      expect(response!.status()).toBe(404);
    });

    test("/about on admin domain should 404", async ({ page }) => {
      const adminUrl = f.url("/about").replace("localhost", "admin.localhost");
      const response = await page.goto(adminUrl);

      // /about belongs to site app, should 404 on admin domain.
      expect(response!.status()).toBe(404);
    });

    // Regression: both site and admin have routeKey "home" at "/" with
    // mountIndex 0. Without routerId in the manifest cache key, the first
    // app's EntryData tree poisons the second app's cache, causing each
    // router to execute the other's components (500 error).
    test("site and admin both render their own home page (no manifest cache collision)", async ({
      page,
    }) => {
      // Visit site "/" first — populates the manifest cache for routeKey "home"
      const siteResponse = await page.goto(f.url("/"));
      expect(siteResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "site-home-page")).toBeVisible();

      // Now visit admin "/" — must NOT reuse site's cached manifest
      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      const adminResponse = await page.goto(adminUrl);
      expect(adminResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "admin-dashboard-page")).toBeVisible();
    });

    // Regression: nested lazy includes (via include()) create RouteEntry
    // objects in lazy-includes.ts. Both apps include("/api", ...) with a
    // route named "status" — these nested lazy entries must also carry
    // routerId to avoid manifest cache collisions.
    test("nested lazy includes render their own content per router (no cross-router cache collision)", async ({
      page,
    }) => {
      // Visit site /api/status first — populates manifest cache for the lazy entry
      const siteResponse = await page.goto(f.url("/api/status"));
      expect(siteResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "site-api-status")).toBeVisible();
      await expect(testId(page, "site-api-status-text")).toHaveText("site-ok");

      // Now visit admin /api/status — must NOT reuse site's cached manifest
      const adminUrl = f
        .url("/api/status")
        .replace("localhost", "admin.localhost");
      const adminResponse = await page.goto(adminUrl);
      expect(adminResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "admin-api-status")).toBeVisible();
      await expect(testId(page, "admin-api-status-text")).toHaveText(
        "admin-ok",
      );
    });
  });

  test.describe("routerId isolation", () => {
    test("site SPA navigation sends _rsc_rid", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await testId(page, "site-nav-about").click();
      await expect(testId(page, "site-about-page")).toBeVisible();

      expect(rscRequests.length).toBeGreaterThanOrEqual(1);
      const url = new URL(rscRequests[0]);
      expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
    });

    test("admin SPA navigation sends _rsc_rid", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await testId(page, "admin-nav-users").click();
      await expect(testId(page, "admin-users-page")).toBeVisible();

      expect(rscRequests.length).toBeGreaterThanOrEqual(1);
      const url = new URL(rscRequests[0]);
      expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
    });

    test("site and admin have different routerIds", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Capture site routerId from SPA navigation
      const siteRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          siteRequests.push(req.url());
        }
      });

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await testId(page, "site-nav-about").click();
      await expect(testId(page, "site-about-page")).toBeVisible();

      expect(siteRequests.length).toBeGreaterThanOrEqual(1);
      const siteRid = new URL(siteRequests[0]).searchParams.get("_rsc_rid");

      // Navigate to admin (full page load — different subdomain)
      const adminRequests: string[] = [];
      page.removeAllListeners("request");
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          adminRequests.push(req.url());
        }
      });

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);
      await testId(page, "admin-nav-users").click();
      await expect(testId(page, "admin-users-page")).toBeVisible();

      expect(adminRequests.length).toBeGreaterThanOrEqual(1);
      const adminRid = new URL(adminRequests[0]).searchParams.get("_rsc_rid");

      // Different routers — different IDs
      expect(siteRid).toBeTruthy();
      expect(adminRid).toBeTruthy();
      expect(siteRid).not.toBe(adminRid);
    });
  });

  test.describe("path-mounted apps", () => {
    test("app-a renders on /app-a", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await expect(testId(page, "app-a-home")).toBeVisible();
      await expect(testId(page, "app-a-home-title")).toHaveText("App A Home");
    });

    test("app-b renders on /app-b", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-b"));
      await waitForHydration(page);

      await expect(testId(page, "app-b-home")).toBeVisible();
      await expect(testId(page, "app-b-home-title")).toHaveText("App B Home");
    });

    test("SPA navigation within app-a sends _rsc_rid", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await testId(page, "app-a-nav-page").click();
      await expect(testId(page, "app-a-page")).toBeVisible();

      expect(rscRequests.length).toBeGreaterThanOrEqual(1);
      const url = new URL(rscRequests[0]);
      expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
    });

    test("cross-app SPA navigation from app-a to app-b renders app-b", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      // Click link to app-b — this is a same-origin SPA navigation
      // that crosses router boundaries
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "app-b-home-title")).toHaveText("App B Home");
    });

    test("cross-app navigation uses different routerIds", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      // Intra-app navigation
      await testId(page, "app-a-nav-page").click();
      await expect(testId(page, "app-a-page")).toBeVisible();

      const appARid = new URL(rscRequests[0]).searchParams.get("_rsc_rid");

      // Cross-app navigation to app-b
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      // The cross-app request should still carry app-a's rid
      // (the server detects the mismatch and returns a full response)
      const crossAppReq = rscRequests.find((r) => r.includes("/app-b"));
      expect(crossAppReq).toBeTruthy();
      const crossAppRid = new URL(crossAppReq!).searchParams.get("_rsc_rid");
      expect(crossAppRid).toBe(appARid); // client still thinks it's app-a
    });

    test("cross-app SPA navigation swaps rootLayout without full reload", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      // Baseline: app-a's Document-rendered shell marker is present.
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "a",
      );

      await using __ = await expectNoReload(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      // After app switch, the Document (rootLayout) must be app-b's, not
      // app-a's closure-captured one.
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "b",
      );
    });

    test("back navigation across apps restores previous rootLayout", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "b",
      );

      await page.goBack();
      await expect(testId(page, "app-a-home")).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "a",
      );
    });

    test("cross-tab app isolation: tab2 invalidating A does not clobber tab1's B state", async ({
      context,
    }) => {
      // Two tabs in the same origin share localStorage. Tab 1 smooth-
      // switches A → B; tab 2 stays in A and simulates a server action
      // invalidation (writes a rotated A token to app A's namespaced key).
      // The storage event fires in tab 1, but tab 1 is listening on app B's
      // key, so its in-memory state must not be overwritten — and its next
      // SPA request must send B's token, not the rotated A token.
      const tab1 = await context.newPage();
      const tab2 = await context.newPage();
      try {
        await tab1.goto(f.url("/app-a"));
        await waitForHydration(tab1);
        await tab2.goto(f.url("/app-a"));
        await waitForHydration(tab2);

        const appAKey = await findRangoStateKey(tab2);
        expect(appAKey).toMatch(/^rango-state:/);
        const appAInitial = await readRangoStateAt(tab2, appAKey);
        expect(appAInitial).toBeTruthy();

        // Tab 1: smooth cross-app switch A → B
        await testId(tab1, "app-a-nav-app-b").click();
        await expect(testId(tab1, "app-b-home")).toBeVisible({
          timeout: 10000,
        });
        await expect(testId(tab1, "app-shell-marker")).toHaveAttribute(
          "data-app-shell",
          "b",
        );

        // Smooth switch does NOT write localStorage (by design), so we can't
        // observe tab 1's new namespace via `findRangoStateKey` — localStorage
        // still holds only app A's key. The behavior we really care about is
        // that tab 1's in-memory state is isolated from tab 2's writes; that
        // is asserted below via the sent X-Rango-State header.

        const tab1HeaderPromise = new Promise<string | null>((resolve) => {
          tab1.on("request", (req) => {
            const header = req.headerValue("x-rango-state");
            if (req.url().includes("_rsc_partial") && header) {
              resolve(header);
            }
          });
        });

        // Tab 2 (still in A) writes a rotated A token — simulating a
        // server action invalidation. This fires a `storage` event in tab 1,
        // but the key is app A's namespace, which tab 1 ignores.
        const rotatedAState = `${appAInitial!.split(":")[0]}:${Date.now() + 999999}`;
        await tab2.evaluate(
          ([key, val]) => localStorage.setItem(key, val),
          [appAKey, rotatedAState],
        );
        await tab1.waitForTimeout(150);

        // Tab 1's next SPA navigation must use its own B token, not the
        // rotated A token. The version prefix MAY match (shared build), so
        // we compare the full string — only a key-namespace leak would
        // cause `rotatedAState` to appear here.
        await testId(tab1, "app-b-nav-page").click();
        await expect(testId(tab1, "app-b-page")).toBeVisible({
          timeout: 10000,
        });

        const sent = await tab1HeaderPromise;
        expect(sent).not.toBe(rotatedAState);
      } finally {
        await tab1.close();
        await tab2.close();
      }
    });
  });
});

// ----- PRODUCTION MODE -----

test.describe("multi-router (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test.describe("site app (localhost)", () => {
    test("should render home page", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(testId(page, "site-home-page")).toBeVisible();
      await expect(testId(page, "site-home-title")).toHaveText(
        "Welcome to the Site",
      );
    });

    test("should render about page on direct visit", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/about"));
      await waitForHydration(page);

      await expect(testId(page, "site-about-page")).toBeVisible();
    });
  });

  test.describe("admin app (admin.localhost)", () => {
    test("should render dashboard page", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await expect(testId(page, "admin-dashboard-page")).toBeVisible();
      await expect(testId(page, "admin-dashboard-title")).toHaveText(
        "Admin Dashboard",
      );
    });

    test("should render users page on direct visit", async ({ page }) => {
      using _ = expectNoPageError(page);

      const adminUrl = f.url("/users").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await expect(testId(page, "admin-users-page")).toBeVisible();
    });
  });

  test.describe("manifest isolation", () => {
    test("/users on site domain should 404", async ({ page }) => {
      const response = await page.goto(f.url("/users"));
      expect(response!.status()).toBe(404);
    });

    test("/about on admin domain should 404", async ({ page }) => {
      const adminUrl = f.url("/about").replace("localhost", "admin.localhost");
      const response = await page.goto(adminUrl);
      expect(response!.status()).toBe(404);
    });

    // Regression: both site and admin have routeKey "home" at "/" with
    // mountIndex 0. Without routerId in the manifest cache key, the first
    // app's EntryData tree poisons the second app's cache, causing each
    // router to execute the other's components (500 error).
    test("site and admin both render their own home page (no manifest cache collision)", async ({
      page,
    }) => {
      // Visit site "/" first — populates the manifest cache for routeKey "home"
      const siteResponse = await page.goto(f.url("/"));
      expect(siteResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "site-home-page")).toBeVisible();

      // Now visit admin "/" — must NOT reuse site's cached manifest
      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      const adminResponse = await page.goto(adminUrl);
      expect(adminResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "admin-dashboard-page")).toBeVisible();
    });

    test("nested lazy includes render their own content per router (no cross-router cache collision)", async ({
      page,
    }) => {
      const siteResponse = await page.goto(f.url("/api/status"));
      expect(siteResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "site-api-status")).toBeVisible();
      await expect(testId(page, "site-api-status-text")).toHaveText("site-ok");

      const adminUrl = f
        .url("/api/status")
        .replace("localhost", "admin.localhost");
      const adminResponse = await page.goto(adminUrl);
      expect(adminResponse!.status()).toBe(200);
      await waitForHydration(page);
      await expect(testId(page, "admin-api-status")).toBeVisible();
      await expect(testId(page, "admin-api-status-text")).toHaveText(
        "admin-ok",
      );
    });
  });

  test.describe("routerId isolation", () => {
    test("site SPA navigation sends _rsc_rid", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await testId(page, "site-nav-about").click();
      await expect(testId(page, "site-about-page")).toBeVisible();

      expect(rscRequests.length).toBeGreaterThanOrEqual(1);
      const url = new URL(rscRequests[0]);
      expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
    });

    test("admin SPA navigation sends _rsc_rid", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);

      await testId(page, "admin-nav-users").click();
      await expect(testId(page, "admin-users-page")).toBeVisible();

      expect(rscRequests.length).toBeGreaterThanOrEqual(1);
      const url = new URL(rscRequests[0]);
      expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
    });

    test("site and admin have different routerIds", async ({ page }) => {
      using _ = expectNoPageError(page);

      const siteRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          siteRequests.push(req.url());
        }
      });

      await page.goto(f.url("/"));
      await waitForHydration(page);
      await testId(page, "site-nav-about").click();
      await expect(testId(page, "site-about-page")).toBeVisible();

      expect(siteRequests.length).toBeGreaterThanOrEqual(1);
      const siteRid = new URL(siteRequests[0]).searchParams.get("_rsc_rid");

      const adminRequests: string[] = [];
      page.removeAllListeners("request");
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          adminRequests.push(req.url());
        }
      });

      const adminUrl = f.url("/").replace("localhost", "admin.localhost");
      await page.goto(adminUrl);
      await waitForHydration(page);
      await testId(page, "admin-nav-users").click();
      await expect(testId(page, "admin-users-page")).toBeVisible();

      expect(adminRequests.length).toBeGreaterThanOrEqual(1);
      const adminRid = new URL(adminRequests[0]).searchParams.get("_rsc_rid");

      expect(siteRid).toBeTruthy();
      expect(adminRid).toBeTruthy();
      expect(siteRid).not.toBe(adminRid);
    });
  });

  test.describe("path-mounted apps", () => {
    test("app-a renders on /app-a", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await expect(testId(page, "app-a-home")).toBeVisible();
      await expect(testId(page, "app-a-home-title")).toHaveText("App A Home");
    });

    test("app-b renders on /app-b", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-b"));
      await waitForHydration(page);

      await expect(testId(page, "app-b-home")).toBeVisible();
      await expect(testId(page, "app-b-home-title")).toHaveText("App B Home");
    });

    test("SPA navigation within app-a sends _rsc_rid", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await testId(page, "app-a-nav-page").click();
      await expect(testId(page, "app-a-page")).toBeVisible();

      expect(rscRequests.length).toBeGreaterThanOrEqual(1);
      const url = new URL(rscRequests[0]);
      expect(url.searchParams.get("_rsc_rid")).toBeTruthy();
    });

    test("cross-app SPA navigation from app-a to app-b renders app-b", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "app-b-home-title")).toHaveText("App B Home");
    });

    test("cross-app navigation uses different routerIds", async ({ page }) => {
      using _ = expectNoPageError(page);

      const rscRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("_rsc_partial")) {
          rscRequests.push(req.url());
        }
      });

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      // Intra-app navigation
      await testId(page, "app-a-nav-page").click();
      await expect(testId(page, "app-a-page")).toBeVisible();

      const appARid = new URL(rscRequests[0]).searchParams.get("_rsc_rid");

      // Cross-app navigation to app-b
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      const crossAppReq = rscRequests.find((r) => r.includes("/app-b"));
      expect(crossAppReq).toBeTruthy();
      const crossAppRid = new URL(crossAppReq!).searchParams.get("_rsc_rid");
      expect(crossAppRid).toBe(appARid);
    });

    test("cross-app SPA navigation swaps rootLayout without full reload", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "a",
      );

      await using __ = await expectNoReload(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "b",
      );
    });

    test("back navigation across apps restores previous rootLayout", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "b",
      );

      await page.goBack();
      await expect(testId(page, "app-a-home")).toBeVisible({ timeout: 10000 });
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "a",
      );
    });

    test("cross-tab app isolation: tab2 invalidating A does not clobber tab1's B state", async ({
      context,
    }) => {
      const tab1 = await context.newPage();
      const tab2 = await context.newPage();
      try {
        await tab1.goto(f.url("/app-a"));
        await waitForHydration(tab1);
        await tab2.goto(f.url("/app-a"));
        await waitForHydration(tab2);

        const appAKey = await findRangoStateKey(tab2);
        expect(appAKey).toMatch(/^rango-state:/);
        const appAInitial = await readRangoStateAt(tab2, appAKey);
        expect(appAInitial).toBeTruthy();

        await testId(tab1, "app-a-nav-app-b").click();
        await expect(testId(tab1, "app-b-home")).toBeVisible({
          timeout: 10000,
        });
        await expect(testId(tab1, "app-shell-marker")).toHaveAttribute(
          "data-app-shell",
          "b",
        );

        // Smooth switch does NOT write localStorage (by design), so we can't
        // observe tab 1's new namespace via `findRangoStateKey` — localStorage
        // still holds only app A's key. The behavior we really care about is
        // that tab 1's in-memory state is isolated from tab 2's writes; that
        // is asserted below via the sent X-Rango-State header.

        const tab1HeaderPromise = new Promise<string | null>((resolve) => {
          tab1.on("request", (req) => {
            const header = req.headerValue("x-rango-state");
            if (req.url().includes("_rsc_partial") && header) {
              resolve(header);
            }
          });
        });

        const rotatedAState = `${appAInitial!.split(":")[0]}:${Date.now() + 999999}`;
        await tab2.evaluate(
          ([key, val]) => localStorage.setItem(key, val),
          [appAKey, rotatedAState],
        );
        await tab1.waitForTimeout(150);

        await testId(tab1, "app-b-nav-page").click();
        await expect(testId(tab1, "app-b-page")).toBeVisible({
          timeout: 10000,
        });

        const sent = await tab1HeaderPromise;
        expect(sent).not.toBe(rotatedAState);
      } finally {
        await tab1.close();
        await tab2.close();
      }
    });
  });
});
