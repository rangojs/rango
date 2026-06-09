import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
  expectFullReload,
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

    test("cross-app SPA navigation triggers a full document reload", async ({
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

      // Crossing the app boundary is a HARD document navigation, not a soft
      // swap — the server returns X-RSC-Reload for an app switch so the target
      // app's whole document (shell, CSS, theme, warmup, prefetch-TTL) is
      // re-established. See request-classification.ts (mode "app-switch").
      await using __ = await expectFullReload(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      // After the reload, the Document (rootLayout) is app-b's.
      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "b",
      );
    });

    test("cross-app reload re-establishes the target app's document CSS", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      const bodyBg = () =>
        page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      // app-a's document-level stylesheet applies on a direct load.
      expect(await bodyBg()).toBe("rgb(10, 20, 30)");

      // The cross-app navigation is a full document reload, so app-b's document
      // <head> stylesheet applies cleanly — no React resource-dedup drop (the
      // soft-switch bug that motivated forcing the reload).
      await using __ = await expectFullReload(page);
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      await expect.poll(bodyBg, { timeout: 5000 }).toBe("rgb(40, 50, 60)");
    });

    // Regression for the cross-app THEME drop (the other half of the document-
    // fidelity bug). app-b opts into the theme system; app-a does not. Under the
    // old soft switch app-b's segment tree rendered under app-a's (absent) theme
    // runtime, so app-b's <html data-theme> never applied. The full document
    // reload mounts app-b's own theme runtime, so the attribute applies.
    test("cross-app reload re-establishes the target app's theme", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const htmlTheme = () =>
        page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"),
        );

      // app-a does not configure the theme system.
      await page.goto(f.url("/app-a"));
      await waitForHydration(page);
      expect(await htmlTheme()).toBeNull();

      // Cross-app navigation into app-b (theme: data-theme/dark) is a full
      // reload, so app-b's theme runtime mounts and sets the <html> attribute.
      await using __ = await expectFullReload(page);
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      await expect.poll(htmlTheme, { timeout: 5000 }).toBe("dark");
    });

    // Regression for the cross-app shared-stylesheet drop. site (source)
    // renders a SHARED href UNMANAGED (no precedence); app-a (target) renders
    // the SAME href MANAGED (precedence). Under the old SOFT switch, React 19's
    // by-href resource dedup dropped it (removed site's unmanaged link, declined
    // to insert app-a's managed one) and app-a rendered unstyled. Forcing a full
    // document reload on the app switch fixes it: app-a loads fresh and its
    // stylesheet applies regardless of how the source rendered the href.
    test("cross-app reload re-applies a stylesheet shared across apps", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      const bodyBg = () =>
        page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      // The shared stylesheet applies on the source (site) app.
      expect(await bodyBg()).toBe("rgb(10, 20, 30)");

      // Cross-app navigation is a full document reload, so app-a's stylesheet
      // (the same shared href) applies cleanly instead of being dropped.
      await using __ = await expectFullReload(page);
      await testId(page, "site-nav-app-a").click();
      await expect(testId(page, "app-a-home")).toBeVisible({ timeout: 10000 });

      await expect.poll(bodyBg, { timeout: 5000 }).toBe("rgb(10, 20, 30)");
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
      // Two tabs in the same origin share localStorage. Tab 1 navigates A → B
      // (a full document reload across the app boundary); tab 2 stays in A and
      // simulates a server-action invalidation (writes a rotated A token to app
      // A's namespaced key). rango-state keys are namespaced per app, so tab 1
      // (now app B) must ignore tab 2's app-A rotation — its next SPA request
      // must send B's token, not the rotated A token.
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

        // Tab 1: cross-app navigation A → B (a full document reload).
        await testId(tab1, "app-a-nav-app-b").click();
        await expect(testId(tab1, "app-b-home")).toBeVisible({
          timeout: 10000,
        });
        await expect(testId(tab1, "app-shell-marker")).toHaveAttribute(
          "data-app-shell",
          "b",
        );

        // Tab 1 is now fully app B (with its own namespaced rango-state key).
        // The property under test: tab 2's app-A token rotation must not surface
        // in tab 1's app-B requests, asserted below via the X-Rango-State header.

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

  // Regression for #506: a nested lazy-include chain under a dynamic-param
  // prefix (site -> include("/g", group) -> include("/:id/sub", section) ->
  // section's own top-level include -> leaf). The dynamic ":id" collapses every
  // nested staticPrefix to "/g"; the deeply-nested route must still resolve and
  // must not be over-claimed by the "group" parent entry.
  test.describe("nested lazy-include under dynamic param (#506)", () => {
    test("deeply-nested dynamic include route resolves", async ({ page }) => {
      using _ = expectNoPageError(page);
      const res = await page.goto(f.url("/g/x/sub/leaf"));
      expect(res!.status()).toBe(200);
      await expect(testId(page, "ni-leaf-title")).toHaveText("Nested Leaf");
    });

    test("sibling dynamic route still resolves via the parent", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const res = await page.goto(f.url("/g/x"));
      expect(res!.status()).toBe(200);
      await expect(testId(page, "ni-index")).toBeVisible();
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

    test("cross-app SPA navigation triggers a full document reload", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "a",
      );

      // Crossing the app boundary is a HARD document navigation (server returns
      // X-RSC-Reload for an app switch), so the target app's whole document is
      // re-established. See request-classification.ts (mode "app-switch").
      await using __ = await expectFullReload(page);

      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      await expect(testId(page, "app-shell-marker")).toHaveAttribute(
        "data-app-shell",
        "b",
      );
    });

    test("cross-app reload re-establishes the target app's document CSS", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/app-a"));
      await waitForHydration(page);

      const bodyBg = () =>
        page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      // app-a's document-level stylesheet applies on a direct load.
      expect(await bodyBg()).toBe("rgb(10, 20, 30)");

      // The cross-app navigation is a full document reload, so app-b's document
      // <head> stylesheet applies cleanly — no React resource-dedup drop (the
      // soft-switch bug that motivated forcing the reload).
      await using __ = await expectFullReload(page);
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      await expect.poll(bodyBg, { timeout: 5000 }).toBe("rgb(40, 50, 60)");
    });

    // Regression for the cross-app THEME drop (the other half of the document-
    // fidelity bug). app-b opts into the theme system; app-a does not. Under the
    // old soft switch app-b's segment tree rendered under app-a's (absent) theme
    // runtime, so app-b's <html data-theme> never applied. The full document
    // reload mounts app-b's own theme runtime, so the attribute applies.
    test("cross-app reload re-establishes the target app's theme", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const htmlTheme = () =>
        page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"),
        );

      // app-a does not configure the theme system.
      await page.goto(f.url("/app-a"));
      await waitForHydration(page);
      expect(await htmlTheme()).toBeNull();

      // Cross-app navigation into app-b (theme: data-theme/dark) is a full
      // reload, so app-b's theme runtime mounts and sets the <html> attribute.
      await using __ = await expectFullReload(page);
      await testId(page, "app-a-nav-app-b").click();
      await expect(testId(page, "app-b-home")).toBeVisible({ timeout: 10000 });

      await expect.poll(htmlTheme, { timeout: 5000 }).toBe("dark");
    });

    // Regression for the cross-app shared-stylesheet drop. site (source)
    // renders a SHARED href UNMANAGED (no precedence); app-a (target) renders
    // the SAME href MANAGED (precedence). Under the old SOFT switch, React 19's
    // by-href resource dedup dropped it (removed site's unmanaged link, declined
    // to insert app-a's managed one) and app-a rendered unstyled. Forcing a full
    // document reload on the app switch fixes it: app-a loads fresh and its
    // stylesheet applies regardless of how the source rendered the href.
    test("cross-app reload re-applies a stylesheet shared across apps", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      const bodyBg = () =>
        page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      // The shared stylesheet applies on the source (site) app.
      expect(await bodyBg()).toBe("rgb(10, 20, 30)");

      // Cross-app navigation is a full document reload, so app-a's stylesheet
      // (the same shared href) applies cleanly instead of being dropped.
      await using __ = await expectFullReload(page);
      await testId(page, "site-nav-app-a").click();
      await expect(testId(page, "app-a-home")).toBeVisible({ timeout: 10000 });

      await expect.poll(bodyBg, { timeout: 5000 }).toBe("rgb(10, 20, 30)");
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

        // Tab 1 is now fully app B (with its own namespaced rango-state key).
        // The property under test: tab 2's app-A token rotation must not surface
        // in tab 1's app-B requests, asserted below via the X-Rango-State header.

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

  // Regression for #506 (production build path — where the precompute shortcut
  // runs). The deeply-nested dynamic include route 404'd before the fix because
  // its leaf was precomputed under the collapsed "/g" staticPrefix and claimed
  // by the "group" parent entry, which cannot register it.
  test.describe("nested lazy-include under dynamic param (#506)", () => {
    test("deeply-nested dynamic include route resolves", async ({ page }) => {
      using _ = expectNoPageError(page);
      const res = await page.goto(f.url("/g/x/sub/leaf"));
      expect(res!.status()).toBe(200);
      await expect(testId(page, "ni-leaf-title")).toHaveText("Nested Leaf");
    });

    test("sibling dynamic route still resolves via the parent", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const res = await page.goto(f.url("/g/x"));
      expect(res!.status()).toBe(200);
      await expect(testId(page, "ni-index")).toBeVisible();
    });
  });
});
