import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Auth boundary tests.
 *
 * Proves the core security contract:
 *   1. Route middleware guards renders, NOT server actions.
 *   2. Global middleware guards both actions and renders.
 *   3. JS and PE unauthorized flows behave the same.
 *   4. Response routes respect middleware auth.
 *   5. Auth rejection preserves status, redirect target, and cookies.
 */

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------

test.describe("auth-boundary (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("route middleware rejects unauthenticated document request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/auth-boundary/route-protected"));
    await waitForHydration(page);

    await expect(page).toHaveURL(/\/auth-boundary\?rejected=route-mw/);
    await expect(testId(page, "auth-index-title")).toHaveText(
      "Auth Boundary Test",
    );

    const cookies = await page.context().cookies();
    const rejectedBy = cookies.find(
      (c) => c.name === "auth-boundary-rejected-by",
    );
    expect(rejectedBy?.value).toBe("route-mw");
  });

  test("route middleware allows authenticated document request", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/auth-boundary/route-protected"));
    await waitForHydration(page);

    await expect(testId(page, "route-protected-title")).toHaveText(
      "Route-MW Protected",
    );

    const response = await page.goto(f.url("/auth-boundary/route-protected"));
    expect(response?.headers()["x-auth-route-mw"]).toBe("passed");
  });

  test("route middleware does NOT guard action: action executes without auth", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/auth-boundary/route-protected"));
    await waitForHydration(page);

    await context.clearCookies({ name: "auth-boundary-token" });

    // Route middleware does NOT guard actions. After the action runs,
    // route MW wraps the revalidation render and redirects.
    await testId(page, "route-protected-action-btn").click();

    // The redirect replaces the page content with the auth-rejection page.
    await expect(testId(page, "auth-index-title")).toHaveText(
      "Auth Boundary Test",
      { timeout: 10000 },
    );

    // The action DID execute (set marker cookie) despite lack of auth.
    const cookies = await context.cookies();
    const actionRan = cookies.find(
      (c) => c.name === "auth-boundary-action-ran",
    );
    expect(actionRan?.value).toBe("true");
  });

  test("global middleware rejects unauthenticated document request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/auth-boundary/global-protected"));
    await waitForHydration(page);

    await expect(page).toHaveURL(/\/auth-boundary\?rejected=global-mw/);

    const cookies = await page.context().cookies();
    const rejectedBy = cookies.find(
      (c) => c.name === "auth-boundary-rejected-by",
    );
    expect(rejectedBy?.value).toBe("global-mw");
  });

  test("global middleware rejects unauthenticated action request", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/auth-boundary/global-protected"));
    await waitForHydration(page);

    await context.clearCookies({ name: "auth-boundary-token" });

    // Global middleware guards actions. The action request is rejected
    // before the action function executes.
    await testId(page, "global-protected-action-btn").click();

    await expect(testId(page, "auth-index-title")).toHaveText(
      "Auth Boundary Test",
      { timeout: 10000 },
    );

    // Action should NOT have executed (no marker cookie).
    const cookies = await context.cookies();
    const actionRan = cookies.find(
      (c) => c.name === "auth-boundary-action-ran",
    );
    expect(actionRan).toBeUndefined();
  });

  test("response route auth failure returns 401, not protected data", async ({
    page,
  }) => {
    const response = await page.goto(f.url("/auth-boundary/api/protected"));
    expect(response?.status()).toBe(401);

    const body = await response?.json();
    expect(body.error).toBe("unauthorized");
    expect(body.data).toBeUndefined();
  });

  test("response route returns data when authenticated", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    const response = await page.goto(f.url("/auth-boundary/api/protected"));
    expect(response?.status()).toBe(200);

    const body = await response?.json();
    expect(body.secret).toBe("classified-data");
  });

  test.describe("progressive enhancement (no JS)", () => {
    test.use({ javaScriptEnabled: false });

    test("PE form on route-protected page: action executes without auth", async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: "auth-boundary-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/auth-boundary/route-protected"));
      await expect(testId(page, "route-protected-title")).toHaveText(
        "Route-MW Protected",
      );

      await context.clearCookies({ name: "auth-boundary-token" });

      await testId(page, "route-protected-action-btn").click();
      await page.waitForLoadState("domcontentloaded");

      // Action ran (cookie set) then route MW redirected the re-render
      const cookies = await context.cookies();
      const actionRan = cookies.find(
        (c) => c.name === "auth-boundary-action-ran",
      );
      expect(actionRan?.value).toBe("true");
      expect(page.url()).toMatch(/\/auth-boundary\?rejected=route-mw/);
    });

    test("PE form on global-protected page: action blocked by global MW", async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: "auth-boundary-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/auth-boundary/global-protected"));
      await expect(testId(page, "global-protected-title")).toHaveText(
        "Global-MW Protected",
      );

      await context.clearCookies({ name: "auth-boundary-token" });

      await testId(page, "global-protected-action-btn").click();
      await page.waitForLoadState("domcontentloaded");

      const cookies = await context.cookies();
      const actionRan = cookies.find(
        (c) => c.name === "auth-boundary-action-ran",
      );
      expect(actionRan).toBeUndefined();
      expect(page.url()).toMatch(/\/auth-boundary\?rejected=global-mw/);
    });
  });
});

// ---------------------------------------------------------------------------
// Production mode
// ---------------------------------------------------------------------------

test.describe("auth-boundary (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("route middleware rejects unauthenticated document request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/auth-boundary/route-protected"));
    await waitForHydration(page);

    await expect(page).toHaveURL(/\/auth-boundary\?rejected=route-mw/);

    const cookies = await page.context().cookies();
    const rejectedBy = cookies.find(
      (c) => c.name === "auth-boundary-rejected-by",
    );
    expect(rejectedBy?.value).toBe("route-mw");
  });

  test("route middleware does NOT guard action: action executes without auth", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/auth-boundary/route-protected"));
    await waitForHydration(page);

    await context.clearCookies({ name: "auth-boundary-token" });

    await testId(page, "route-protected-action-btn").click();

    await expect(testId(page, "auth-index-title")).toHaveText(
      "Auth Boundary Test",
      { timeout: 10000 },
    );

    const cookies = await context.cookies();
    const actionRan = cookies.find(
      (c) => c.name === "auth-boundary-action-ran",
    );
    expect(actionRan?.value).toBe("true");
  });

  test("global middleware rejects unauthenticated document request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/auth-boundary/global-protected"));
    await waitForHydration(page);

    await expect(page).toHaveURL(/\/auth-boundary\?rejected=global-mw/);

    const cookies = await page.context().cookies();
    const rejectedBy = cookies.find(
      (c) => c.name === "auth-boundary-rejected-by",
    );
    expect(rejectedBy?.value).toBe("global-mw");
  });

  test("global middleware rejects unauthenticated action request", async ({
    page,
    context,
  }) => {
    using _ = expectNoPageError(page);

    // Clear any leftover action marker from previous tests
    await context.clearCookies({ name: "auth-boundary-action-ran" });

    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto(f.url("/auth-boundary/global-protected"));
    await waitForHydration(page);

    await context.clearCookies({ name: "auth-boundary-token" });

    // Global middleware guards actions. The action request is rejected
    // before the action function executes.
    await testId(page, "global-protected-action-btn").click();

    await expect(testId(page, "auth-index-title")).toHaveText(
      "Auth Boundary Test",
      { timeout: 10000 },
    );

    // Action should NOT have executed (no marker cookie).
    const cookies = await context.cookies();
    const actionRan = cookies.find(
      (c) => c.name === "auth-boundary-action-ran",
    );
    expect(actionRan).toBeUndefined();
  });

  test("response route auth failure returns 401, not protected data", async ({
    page,
  }) => {
    const response = await page.goto(f.url("/auth-boundary/api/protected"));
    expect(response?.status()).toBe(401);

    const body = await response?.json();
    expect(body.error).toBe("unauthorized");
    expect(body.data).toBeUndefined();
  });

  test("response route returns data when authenticated", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "auth-boundary-token",
        value: "valid",
        domain: "localhost",
        path: "/",
      },
    ]);

    const response = await page.goto(f.url("/auth-boundary/api/protected"));
    expect(response?.status()).toBe(200);

    const body = await response?.json();
    expect(body.secret).toBe("classified-data");
  });

  test.describe("progressive enhancement (no JS)", () => {
    test.use({ javaScriptEnabled: false });

    test("PE form on route-protected page: action executes without auth", async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: "auth-boundary-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/auth-boundary/route-protected"));
      await expect(testId(page, "route-protected-title")).toHaveText(
        "Route-MW Protected",
      );

      await context.clearCookies({ name: "auth-boundary-token" });

      await testId(page, "route-protected-action-btn").click();
      await page.waitForLoadState("domcontentloaded");

      const cookies = await context.cookies();
      const actionRan = cookies.find(
        (c) => c.name === "auth-boundary-action-ran",
      );
      expect(actionRan?.value).toBe("true");
      expect(page.url()).toMatch(/\/auth-boundary\?rejected=route-mw/);
    });

    test("PE form on global-protected page: action blocked by global MW", async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: "auth-boundary-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      await page.goto(f.url("/auth-boundary/global-protected"));
      await expect(testId(page, "global-protected-title")).toHaveText(
        "Global-MW Protected",
      );

      await context.clearCookies({ name: "auth-boundary-token" });

      await testId(page, "global-protected-action-btn").click();
      await page.waitForLoadState("domcontentloaded");

      const cookies = await context.cookies();
      const actionRan = cookies.find(
        (c) => c.name === "auth-boundary-action-ran",
      );
      expect(actionRan).toBeUndefined();
      expect(page.url()).toMatch(/\/auth-boundary\?rejected=global-mw/);
    });
  });
});
