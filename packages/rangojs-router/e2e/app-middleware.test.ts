import crypto from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Assert that a response contains exactly the expected Set-Cookie entries.
 * Uses headersArray() to preserve individual entries (allHeaders flattens them,
 * hiding duplicates). Each entry in `expected` is matched as a substring
 * against exactly one Set-Cookie header — no duplicates allowed.
 */
async function expectSetCookies(
  page: Page,
  url: string,
  expected: string[],
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes(url) && response.status() === 200,
  );

  await page.goto(url);
  const response = await responsePromise;

  const headers = await response.headersArray();
  const setCookies = headers
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);

  for (const fragment of expected) {
    const matches = setCookies.filter((c) => c.includes(fragment));
    expect(
      matches,
      `Expected exactly 1 Set-Cookie matching "${fragment}", got ${matches.length}: ${JSON.stringify(setCookies)}`,
    ).toHaveLength(1);
  }
}

// Mirrors the build-time hashId from expose-id-utils.ts so production loader
// tests stay in sync with the build output without hardcoding hash values.
function productionLoaderId(filePath: string, exportName: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${filePath}#${exportName}`)
    .digest("hex");
  return `${hash.slice(0, 8)}#${exportName}`;
}

/**
 * E2E tests for app-level middleware:
 * 1. Global middleware applies to all routes
 * 2. Pattern-based middleware applies only to matching routes
 * 3. Middleware can set response headers
 * 4. Middleware can read/set cookies
 * 5. Middleware can redirect requests
 * 6. Middleware can catch errors from handlers
 * 7. Middleware can share variables with handlers via ctx.set/get
 * 8. Middleware can extract params from URL patterns
 */

test.describe("app-middleware (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("global-middleware", () => {
    test("should add global headers to all routes", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Intercept the navigation request to check headers
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test"));
      const response = await responsePromise;

      // Global middleware should add these headers
      expect(response.headers()["x-global-middleware"]).toBe("applied");
      expect(response.headers()["x-header-shorthand"]).toBe("works");

      // Timing header should exist (value varies)
      expect(response.headers()["x-request-duration"]).toBeDefined();
      const duration = parseInt(response.headers()["x-request-duration"], 10);
      expect(duration).toBeGreaterThanOrEqual(0);

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="middleware-test-title"]'),
      ).toBeVisible();
    });

    test("global headers should be present on any route", async ({ page }) => {
      using _ = expectNoPageError(page);

      // Test on the index page too
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url() === f.url("/") && response.status() === 200,
      );

      await page.goto(f.url("/"));
      const response = await responsePromise;

      // Global middleware applies to all routes
      expect(response.headers()["x-global-middleware"]).toBe("applied");
      expect(response.headers()["x-header-shorthand"]).toBe("works");

      await waitForHydration(page);
    });
  });

  test.describe("pattern-based-middleware", () => {
    test("pattern middleware should only apply to matching routes", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Non-matching route should not have params header
      const response1Promise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test") &&
          !response.url().includes("/params/") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test"));
      const response1 = await response1Promise;

      // Params middleware should NOT apply here
      expect(response1.headers()["x-middleware-param-id"]).toBeUndefined();

      await waitForHydration(page);
    });

    test("params middleware should extract :id from URL", async ({ page }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/params/test-123") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/params/test-123"));
      const response = await responsePromise;

      // Params middleware should set header with extracted param
      expect(response.headers()["x-middleware-param-id"]).toBe("test-123");

      await waitForHydration(page);

      // Handler should also receive the middleware-set params
      await expect(page.locator('[data-testid="params-title"]')).toBeVisible();
      await expect(
        page.locator('[data-testid="route-param-id"]'),
      ).toContainText("test-123");
      await expect(
        page.locator('[data-testid="middleware-param-id"]'),
      ).toContainText("test-123");
    });

    test("params middleware should work with different param values", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/params/abc-xyz-789") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/params/abc-xyz-789"));
      const response = await responsePromise;

      expect(response.headers()["x-middleware-param-id"]).toBe("abc-xyz-789");

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="middleware-param-id"]'),
      ).toContainText("abc-xyz-789");
    });
  });

  test.describe("auth-redirect-middleware", () => {
    test("protected route should redirect when not authenticated", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Navigate to protected route without auth cookie
      await page.goto(f.url("/middleware-test/protected"));

      // Should redirect to /middleware-test?auth=required
      await expect(page).toHaveURL(/\/middleware-test\?auth=required/);

      await waitForHydration(page);

      // Should show auth required message
      await expect(
        page.locator('[data-testid="auth-required-message"]'),
      ).toBeVisible();
    });

    test("protected dashboard should also redirect when not authenticated", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/middleware-test/protected/dashboard"));

      // Should redirect to /middleware-test?auth=required
      await expect(page).toHaveURL(/\/middleware-test\?auth=required/);

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="auth-required-message"]'),
      ).toBeVisible();
    });

    test("protected route should allow access when authenticated", async ({
      page,
      context,
    }) => {
      using _ = expectNoPageError(page);

      // Set auth cookie before navigating
      await context.addCookies([
        {
          name: "auth-token",
          value: "valid-token",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/middleware-test/protected"));

      // Should NOT redirect
      await expect(page).toHaveURL(/\/middleware-test\/protected$/);

      await waitForHydration(page);

      // Should show user info set by middleware
      await expect(
        page.locator('[data-testid="protected-title"]'),
      ).toBeVisible();
      await expect(page.locator('[data-testid="user-id"]')).toContainText(
        "123",
      );
      await expect(page.locator('[data-testid="user-name"]')).toContainText(
        "TestUser",
      );
    });

    test("protected dashboard should allow access when authenticated", async ({
      page,
      context,
    }) => {
      using _ = expectNoPageError(page);

      await context.addCookies([
        {
          name: "auth-token",
          value: "valid-token",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/middleware-test/protected/dashboard"));

      await expect(page).toHaveURL(/\/middleware-test\/protected\/dashboard$/);

      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="dashboard-title"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="dashboard-user"]'),
      ).toContainText("TestUser");
    });
  });

  test.describe("error-handling-middleware", () => {
    // Note: Errors thrown in React route handlers during RSC rendering are caught by
    // React's error boundary system, not by app-level middleware. This is by design:
    // - Error boundaries handle UI rendering errors (React level)
    // - Middleware handles request/response lifecycle (HTTP level)
    //
    // Middleware CAN catch errors from:
    // - Loaders (when they throw before rendering)
    // - Middleware chain itself
    // - Pre-render logic in route matching
    //
    // For now, we test that the middleware IS applied (global headers present)
    // even when the route throws an error that's caught by error boundaries.
    test("global middleware should still apply even when route has errors", async ({
      page,
    }) => {
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/middleware-test/error-handler/trigger"),
      );

      await page.goto(f.url("/middleware-test/error-handler/trigger"));
      const response = await responsePromise;

      // Global middleware headers should still be present
      // (the response is generated, even if it contains an error boundary fallback)
      expect(response.headers()["x-global-middleware"]).toBe("applied");
      expect(response.headers()["x-header-shorthand"]).toBe("works");
      expect(response.headers()["x-request-duration"]).toBeDefined();
    });
  });

  test.describe("cookie-middleware", () => {
    test("middleware should set visit count cookie", async ({
      page,
      context,
    }) => {
      // First visit - no cookie yet
      const response1Promise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/cookies") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/cookies"));
      const response1 = await response1Promise;

      // Check Set-Cookie header using allHeaders() which handles multiple headers
      const allHeaders1 = await response1.allHeaders();
      const setCookie1 = allHeaders1["set-cookie"];
      expect(setCookie1).toBeDefined();
      expect(setCookie1).toContain("visit-count=1");

      await waitForHydration(page);

      // Handler should receive visit count from middleware
      await expect(page.locator('[data-testid="visit-count"]')).toContainText(
        "1",
      );

      // Second visit - cookie should be incremented
      const response2Promise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/cookies") &&
          response.status() === 200,
      );

      await page.reload();
      const response2 = await response2Promise;

      const allHeaders2 = await response2.allHeaders();
      const setCookie2 = allHeaders2["set-cookie"];
      expect(setCookie2).toContain("visit-count=2");

      await waitForHydration(page);
      await expect(page.locator('[data-testid="visit-count"]')).toContainText(
        "2",
      );
    });

    test("middleware should read existing cookies", async ({
      page,
      context,
    }) => {
      // Pre-set a visit count cookie
      await context.addCookies([
        {
          name: "visit-count",
          value: "42",
          domain: "localhost",
          path: "/",
        },
      ]);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/cookies") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/cookies"));
      const response = await responsePromise;

      // Middleware should increment from 42 to 43
      const allHeaders = await response.allHeaders();
      const setCookie = allHeaders["set-cookie"];
      expect(setCookie).toContain("visit-count=43");

      await waitForHydration(page);
      await expect(page.locator('[data-testid="visit-count"]')).toContainText(
        "43",
      );
    });
  });

  test.describe("shared-variables", () => {
    test("middleware should share variables with handlers via ctx.set/get", async ({
      page,
      context,
    }) => {
      using _ = expectNoPageError(page);

      // Test with protected route - middleware sets "user" variable
      await context.addCookies([
        {
          name: "auth-token",
          value: "valid-token",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/middleware-test/protected"));
      await waitForHydration(page);

      // Handler should receive user variable set by middleware
      await expect(page.locator('[data-testid="user-info"]')).toBeVisible();
      await expect(page.locator('[data-testid="user-id"]')).toContainText(
        "123",
      );
      await expect(page.locator('[data-testid="user-name"]')).toContainText(
        "TestUser",
      );
    });

    test("middleware params should be shared with handlers", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/middleware-test/params/shared-test-value"));
      await waitForHydration(page);

      // Handler should receive middlewareParams variable
      await expect(
        page.locator('[data-testid="middleware-param-id"]'),
      ).toContainText("shared-test-value");
    });
  });

  test.describe("middleware-chaining", () => {
    test("multiple global middlewares should all execute", async ({ page }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test"));
      const response = await responsePromise;

      // All global middlewares should have executed
      expect(response.headers()["x-global-middleware"]).toBe("applied");
      expect(response.headers()["x-header-shorthand"]).toBe("works");
      expect(response.headers()["x-request-duration"]).toBeDefined();

      await waitForHydration(page);
    });

    test("global and pattern middlewares should both execute", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/params/combo-test") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/params/combo-test"));
      const response = await responsePromise;

      // Global middleware headers
      expect(response.headers()["x-global-middleware"]).toBe("applied");
      expect(response.headers()["x-header-shorthand"]).toBe("works");
      expect(response.headers()["x-request-duration"]).toBeDefined();

      // Pattern middleware header
      expect(response.headers()["x-middleware-param-id"]).toBe("combo-test");

      await waitForHydration(page);
    });
  });

  test.describe("route-level-middleware", () => {
    test("route-level middleware should set response header", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/route-level") &&
          !response.url().includes("/middleware-test/route-level/") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/route-level"));
      const response = await responsePromise;

      // Route-level middleware should set this header
      expect(response.headers()["x-route-level-middleware"]).toBe("applied");

      // Global middleware should also apply
      expect(response.headers()["x-global-middleware"]).toBe("applied");

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="route-level-title"]'),
      ).toBeVisible();
    });

    test("route-level middleware should share variables with handler", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/middleware-test/route-level"));
      await waitForHydration(page);

      // Handler should read the variable set by route-level middleware
      await expect(
        page.locator('[data-testid="route-middleware-value"]'),
      ).toContainText("yes");
    });

    test("route-level middleware should have access to ctx.params", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes("/middleware-test/route-level/test-route-123") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/route-level/test-route-123"));
      const response = await responsePromise;

      // Middleware should set header with the param value from ctx.params
      expect(response.headers()["x-middleware-route-id"]).toBe(
        "test-route-123",
      );

      await waitForHydration(page);

      // Both handler and middleware should have access to the same param value
      await expect(
        page.locator('[data-testid="handler-route-id"]'),
      ).toContainText("test-route-123");
      await expect(
        page.locator('[data-testid="middleware-route-id"]'),
      ).toContainText("test-route-123");
      await expect(
        page.locator('[data-testid="params-available"]'),
      ).toContainText("yes");
    });

    test("route-level middleware params should work with different values", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes("/middleware-test/route-level/another-value-xyz") &&
          response.status() === 200,
      );

      await page.goto(f.url("/middleware-test/route-level/another-value-xyz"));
      const response = await responsePromise;

      // Verify different param value works
      expect(response.headers()["x-middleware-route-id"]).toBe(
        "another-value-xyz",
      );

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="middleware-route-id"]'),
      ).toContainText("another-value-xyz");
    });
  });

  test.describe("middleware-shortcircuit-headers", () => {
    test("global middleware short-circuit should preserve stub headers and onResponse callbacks", async ({
      page,
    }) => {
      // Hit protected route without auth cookie — authMiddleware short-circuits
      // with redirect. The upstream middleware set a stub header and registered
      // an onResponse callback; both must survive the short-circuit.
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/protected") &&
          !response.url().includes("auth=required"),
      );

      await page.goto(f.url("/middleware-test/protected"));
      const response = await responsePromise;

      // Stub header set before next() should survive the short-circuit
      expect(response.headers()["x-stub-before-next"]).toBe("applied");
      // onResponse callback should have fired via finalizeResponse()
      expect(response.headers()["x-onresponse-applied"]).toBe("yes");
    });

    test("route middleware short-circuit should preserve onResponse callbacks", async ({
      page,
    }) => {
      // Second route-level middleware short-circuits with 403; first middleware
      // registered an onResponse callback that should still fire.
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes("/middleware-test/route-shortcircuit"),
      );

      await page.goto(f.url("/middleware-test/route-shortcircuit"));
      const response = await responsePromise;

      expect(response.status()).toBe(403);
      // onResponse callback from first middleware should have fired
      expect(response.headers()["x-route-onresponse"]).toBe("applied");
    });
  });

  test.describe("intercept-middleware", () => {
    test("intercept middleware should set header on modal navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // First go to index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click on a slow product to trigger intercept
      // The intercept middleware runs after the loader completes
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/slow-product/") &&
          response.status() === 200,
      );

      await page.click('[data-testid="slow-product-link"]');
      const response = await responsePromise;

      // Intercept middleware should set this header
      expect(response.headers()["x-intercept-middleware"]).toBe("applied");

      // Wait for modal content to fully load (not just skeleton)
      await expect(
        page.locator('[data-testid="slow-modal-product-name"]'),
      ).toBeVisible({ timeout: 10000 });
    });

    test("intercept middleware should set cookie", async ({
      page,
      context,
    }) => {
      using _ = expectNoPageError(page);

      // First go to index
      await page.goto(f.url("/"));
      await waitForHydration(page);

      // Click on a slow product to trigger intercept
      await page.click('[data-testid="slow-product-link"]');

      // Wait for the full modal content to load (after the 2s loader delay)
      // The cookie is set when the middleware runs during the full render
      await expect(
        page.locator('[data-testid="slow-modal-product-name"]'),
      ).toBeVisible({ timeout: 10000 });

      // Check that cookie was set by intercept middleware
      const cookies = await context.cookies();
      const interceptCookie = cookies.find(
        (c) => c.name === "intercept-visited",
      );
      expect(interceptCookie).toBeDefined();
      expect(interceptCookie?.value).toBe("true");
    });
  });

  test.describe("ctx-parity", () => {
    test("ctx.headers sets headers before and after next()", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/ctx-parity") &&
          response.status() === 200,
      );
      await page.goto(f.url("/middleware-test/ctx-parity"));
      const response = await responsePromise;

      expect(response.headers()["x-mw-headers-before"]).toBe("set-before-next");
      expect(response.headers()["x-mw-headers-after"]).toBe("set-after-next");
    });

    test("ctx.var shares variables with handler", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/middleware-test/ctx-parity"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="ctx-parity-var-value"]'),
      ).toContainText("from-ctx-var");
    });

    test("ctx.theme and ctx.setTheme work in middleware", async ({ page }) => {
      using _ = expectNoPageError(page);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/ctx-parity") &&
          response.status() === 200,
      );
      await page.goto(f.url("/middleware-test/ctx-parity"));
      const response = await responsePromise;

      expect(response.headers()["x-mw-theme-before"]).toBe("light");
      expect(response.headers()["x-mw-theme-after"]).toBe("dark");

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="ctx-parity-theme"]'),
      ).toContainText("dark");
    });

    test("ctx.setLocationState does not throw", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/middleware-test/ctx-parity"));
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="ctx-parity-title"]'),
      ).toBeVisible();
    });
  });

  test.describe("loader-middleware", () => {
    test("loader middleware should reject unauthorized requests", async ({
      request,
    }) => {
      // Try to fetch protected loader without auth token
      const response = await request.get(
        f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23ProtectedLoader"),
        {
          headers: { Accept: "text/x-component" },
        },
      );

      // Should fail with unauthorized error
      expect(response.status()).toBe(500);
      const text = await response.text();
      expect(text).toContain("Unauthorized");
    });

    test("loader middleware should allow authorized requests", async ({
      request,
    }) => {
      // Fetch protected loader with valid auth token
      const response = await request.get(
        f.url(
          "/fetch-loader?_rsc_loader=src/loaders.tsx%23ProtectedLoader&_rsc_loader_params=" +
            encodeURIComponent(JSON.stringify({ authToken: "valid-token" })),
        ),
        {
          headers: { Accept: "text/x-component" },
        },
      );

      expect(response.status()).toBe(200);
      const text = await response.text();
      expect(text).toContain("protected");
    });

    test("loader middleware should reject invalid auth token", async ({
      request,
    }) => {
      // Fetch protected loader with invalid auth token
      const response = await request.get(
        f.url(
          "/fetch-loader?_rsc_loader=src/loaders.tsx%23ProtectedLoader&_rsc_loader_params=" +
            encodeURIComponent(JSON.stringify({ authToken: "invalid-token" })),
        ),
        {
          headers: { Accept: "text/x-component" },
        },
      );

      expect(response.status()).toBe(500);
      const text = await response.text();
      expect(text).toContain("Unauthorized");
    });
  });
});

test.describe("cookies-after-next (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("top-level middleware: cookies set after await next() should appear in the response", async ({
    page,
  }) => {
    await expectSetCookies(page, f.url("/middleware-test/cookies-after-next"), [
      "session_id=abc123",
      "HttpOnly",
      "post-next-marker=applied",
    ]);
  });

  test("route-level middleware: cookies set after await next() should appear in the response", async ({
    page,
  }) => {
    await expectSetCookies(
      page,
      f.url("/middleware-test/route-cookies-after-next"),
      ["route_session=xyz789", "HttpOnly", "route-post-next=applied"],
    );
  });
});

test.describe("app-middleware (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("global middleware should work in production mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/middleware-test") &&
        response.status() === 200,
    );

    await page.goto(f.url("/middleware-test"));
    const response = await responsePromise;

    expect(response.headers()["x-global-middleware"]).toBe("applied");
    expect(response.headers()["x-header-shorthand"]).toBe("works");

    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="middleware-test-title"]'),
    ).toBeVisible();
  });

  test("pattern-based middleware should work in production mode", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/middleware-test/params/prod-test") &&
        response.status() === 200,
    );

    await page.goto(f.url("/middleware-test/params/prod-test"));
    const response = await responsePromise;

    expect(response.headers()["x-middleware-param-id"]).toBe("prod-test");

    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="middleware-param-id"]'),
    ).toContainText("prod-test");
  });

  test("auth redirect should work in production mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/middleware-test/protected"));

    await expect(page).toHaveURL(/\/middleware-test\?auth=required/);

    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="auth-required-message"]'),
    ).toBeVisible();
  });

  test("global middleware short-circuit should preserve stub headers and onResponse callbacks in production", async ({
    page,
  }) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/middleware-test/protected") &&
        !response.url().includes("auth=required"),
    );

    await page.goto(f.url("/middleware-test/protected"));
    const response = await responsePromise;

    expect(response.headers()["x-stub-before-next"]).toBe("applied");
    expect(response.headers()["x-onresponse-applied"]).toBe("yes");
  });

  test("route middleware short-circuit should preserve onResponse callbacks in production", async ({
    page,
  }) => {
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes("/middleware-test/route-shortcircuit"),
    );

    await page.goto(f.url("/middleware-test/route-shortcircuit"));
    const response = await responsePromise;

    expect(response.status()).toBe(403);
    expect(response.headers()["x-route-onresponse"]).toBe("applied");
  });

  test("global middleware should still apply even when route has errors in production", async ({
    page,
  }) => {
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes("/middleware-test/error-handler/trigger"),
    );

    await page.goto(f.url("/middleware-test/error-handler/trigger"));
    const response = await responsePromise;

    // Global middleware headers should still be present
    expect(response.headers()["x-global-middleware"]).toBe("applied");
    expect(response.headers()["x-header-shorthand"]).toBe("works");
  });

  test("cookie middleware should set and increment visit count in production", async ({
    page,
  }) => {
    // First visit
    const response1Promise = page.waitForResponse(
      (response) =>
        response.url().includes("/middleware-test/cookies") &&
        response.status() === 200,
    );

    await page.goto(f.url("/middleware-test/cookies"));
    const response1 = await response1Promise;

    const allHeaders1 = await response1.allHeaders();
    const setCookie1 = allHeaders1["set-cookie"];
    expect(setCookie1).toBeDefined();
    expect(setCookie1).toContain("visit-count=1");

    await waitForHydration(page);
    await expect(page.locator('[data-testid="visit-count"]')).toContainText(
      "1",
    );

    // Second visit - cookie should be incremented
    const response2Promise = page.waitForResponse(
      (response) =>
        response.url().includes("/middleware-test/cookies") &&
        response.status() === 200,
    );

    await page.reload();
    const response2 = await response2Promise;

    const allHeaders2 = await response2.allHeaders();
    const setCookie2 = allHeaders2["set-cookie"];
    expect(setCookie2).toContain("visit-count=2");

    await waitForHydration(page);
    await expect(page.locator('[data-testid="visit-count"]')).toContainText(
      "2",
    );
  });

  test("auth middleware should allow access with cookie in production", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "auth-token",
        value: "valid-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/middleware-test/protected"));
    await expect(page).toHaveURL(/\/middleware-test\/protected$/);

    await waitForHydration(page);
    await expect(page.locator('[data-testid="protected-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="user-id"]')).toContainText("123");
    await expect(page.locator('[data-testid="user-name"]')).toContainText(
      "TestUser",
    );
  });

  test.describe("intercept-middleware", () => {
    test("intercept middleware should set header on modal navigation", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/slow-product/") &&
          response.status() === 200,
      );

      await page.click('[data-testid="slow-product-link"]');
      const response = await responsePromise;

      expect(response.headers()["x-intercept-middleware"]).toBe("applied");

      await expect(
        page.locator('[data-testid="slow-modal-product-name"]'),
      ).toBeVisible({ timeout: 10000 });
    });

    test("intercept middleware should set cookie", async ({
      page,
      context,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/"));
      await waitForHydration(page);

      await page.click('[data-testid="slow-product-link"]');

      await expect(
        page.locator('[data-testid="slow-modal-product-name"]'),
      ).toBeVisible({ timeout: 10000 });

      const cookies = await context.cookies();
      const interceptCookie = cookies.find(
        (c) => c.name === "intercept-visited",
      );
      expect(interceptCookie).toBeDefined();
      expect(interceptCookie?.value).toBe("true");
    });
  });

  test.describe("loader-middleware", () => {
    const protectedId = productionLoaderId(
      "src/loaders.tsx",
      "ProtectedLoader",
    );

    test("loader middleware should reject unauthorized requests", async ({
      request,
    }) => {
      const response = await request.get(
        f.url(`/fetch-loader?_rsc_loader=${encodeURIComponent(protectedId)}`),
        {
          headers: { Accept: "text/x-component" },
        },
      );

      expect(response.status()).toBe(500);
      const text = await response.text();
      // Production sanitizes error messages; verify the error structure
      expect(text).toContain("loaderError");
    });

    test("loader middleware should allow authorized requests", async ({
      request,
    }) => {
      const response = await request.get(
        f.url(
          `/fetch-loader?_rsc_loader=${encodeURIComponent(protectedId)}&_rsc_loader_params=` +
            encodeURIComponent(JSON.stringify({ authToken: "valid-token" })),
        ),
        {
          headers: { Accept: "text/x-component" },
        },
      );

      expect(response.status()).toBe(200);
      const text = await response.text();
      expect(text).toContain("protected");
    });

    test("loader middleware should reject invalid auth token", async ({
      request,
    }) => {
      const response = await request.get(
        f.url(
          `/fetch-loader?_rsc_loader=${encodeURIComponent(protectedId)}&_rsc_loader_params=` +
            encodeURIComponent(JSON.stringify({ authToken: "invalid-token" })),
        ),
        {
          headers: { Accept: "text/x-component" },
        },
      );

      expect(response.status()).toBe(500);
      const text = await response.text();
      // Production sanitizes error messages; verify the error structure
      expect(text).toContain("loaderError");
    });
  });

  test("top-level middleware: cookies set after await next() (production)", async ({
    page,
  }) => {
    await expectSetCookies(page, f.url("/middleware-test/cookies-after-next"), [
      "session_id=abc123",
      "HttpOnly",
      "post-next-marker=applied",
    ]);
  });

  test("route-level middleware: cookies set after await next() (production)", async ({
    page,
  }) => {
    await expectSetCookies(
      page,
      f.url("/middleware-test/route-cookies-after-next"),
      ["route_session=xyz789", "HttpOnly", "route-post-next=applied"],
    );
  });

  test.describe("ctx-parity (production)", () => {
    test("ctx.headers sets headers before and after next() in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/ctx-parity") &&
          response.status() === 200,
      );
      await page.goto(f.url("/middleware-test/ctx-parity"));
      const response = await responsePromise;

      expect(response.headers()["x-mw-headers-before"]).toBe("set-before-next");
      expect(response.headers()["x-mw-headers-after"]).toBe("set-after-next");
    });

    test("ctx.var shares variables with handler in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/middleware-test/ctx-parity"));
      await waitForHydration(page);

      await expect(
        page.locator('[data-testid="ctx-parity-var-value"]'),
      ).toContainText("from-ctx-var");
    });

    test("ctx.theme and ctx.setTheme work in middleware in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/middleware-test/ctx-parity") &&
          response.status() === 200,
      );
      await page.goto(f.url("/middleware-test/ctx-parity"));
      const response = await responsePromise;

      expect(response.headers()["x-mw-theme-before"]).toBe("light");
      expect(response.headers()["x-mw-theme-after"]).toBe("dark");

      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="ctx-parity-theme"]'),
      ).toContainText("dark");
    });

    test("ctx.setLocationState does not throw in production", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/middleware-test/ctx-parity"));
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="ctx-parity-title"]'),
      ).toBeVisible();
    });
  });
});
