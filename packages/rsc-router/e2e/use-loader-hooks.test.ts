import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

/**
 * Tests for useLoader and useFetchLoader hooks:
 *
 * Feature Map:
 * ============================================================================
 * | Feature                        | useLoader         | useFetchLoader     |
 * |--------------------------------|-------------------|-------------------|
 * | Data type                      | T (required)      | T | undefined     |
 * | Throws if missing from context | Yes               | No                |
 * | Gets data from loader()        | Yes               | Yes               |
 * | Can fetch on-demand via load() | Only if fetchable | Only if fetchable |
 * | Data updates on navigation     | Yes               | Yes               |
 * | isLoading state                | Yes               | Yes               |
 * | error state                    | Yes               | Yes               |
 * ============================================================================
 */

test.describe("useLoader hook", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("should have data immediately from pre-loaded loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // useLoader should have data immediately - it's pre-loaded via loader()
    await expect(testId(page, "use-loader-test")).toBeVisible();
    await expect(testId(page, "use-loader-data")).toBeVisible();

    // Verify data values are present (not undefined)
    await expect(testId(page, "use-loader-route-id")).toContainText(
      "Route ID:"
    );
    await expect(testId(page, "use-loader-count")).toContainText("Count:");
    await expect(testId(page, "use-loader-source")).toContainText(
      "Source: server"
    );
    await expect(testId(page, "use-loader-timestamp")).toContainText(
      "Timestamp:"
    );

    // Loading should NOT be visible initially (not fetching)
    await expect(testId(page, "use-loader-loading")).not.toBeVisible();
  });
});

test.describe("useFetchLoader hook - with pre-loaded data", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("should have data from context when loader is registered on route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // useFetchLoader should also have data from context (loader is registered)
    await expect(testId(page, "use-fetch-loader-preloaded-test")).toBeVisible();
    await expect(
      testId(page, "use-fetch-loader-preloaded-data")
    ).toBeVisible();

    // Verify data values are present
    await expect(
      testId(page, "use-fetch-loader-preloaded-route-id")
    ).toContainText("Route ID:");
    await expect(
      testId(page, "use-fetch-loader-preloaded-source")
    ).toContainText("Source: server");

    // "No data" should NOT be visible (we have context data)
    await expect(
      testId(page, "use-fetch-loader-preloaded-no-data")
    ).not.toBeVisible();
  });
});

test.describe("useFetchLoader hook - without pre-loaded data", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("should have undefined data when loader is NOT registered on route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // UnregisteredLoader is NOT registered on route-a, so data should be undefined
    await expect(
      testId(page, "use-fetch-loader-unregistered-test")
    ).toBeVisible();
    await expect(
      testId(page, "use-fetch-loader-unregistered-no-data")
    ).toBeVisible();

    // Data container should NOT be visible
    await expect(
      testId(page, "use-fetch-loader-unregistered-data")
    ).not.toBeVisible();
  });

  test("should fetch data on-demand when triggered", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Initially no data
    await expect(
      testId(page, "use-fetch-loader-unregistered-no-data")
    ).toBeVisible();

    // Click fetch button
    await testId(page, "use-fetch-loader-unregistered-fetch-btn").click();

    // Should show loading
    await expect(
      testId(page, "use-fetch-loader-unregistered-loading")
    ).toBeVisible({ timeout: 1000 });

    // Wait for data to appear
    await expect(
      testId(page, "use-fetch-loader-unregistered-data")
    ).toBeVisible({ timeout: 5000 });

    // "No data" should disappear
    await expect(
      testId(page, "use-fetch-loader-unregistered-no-data")
    ).not.toBeVisible();

    // Verify fetched data
    await expect(
      testId(page, "use-fetch-loader-unregistered-message")
    ).toContainText("Fetched from unregistered loader");
  });
});

test.describe("Navigation updates loader data", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("useLoader data updates when navigating to different route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Verify we're on route A with HookTestLoader data
    await expect(testId(page, "use-loader-source")).toContainText(
      "Source: server"
    );

    // Navigate to route B
    await testId(page, "navigate-to-b-link").click();

    // Wait for route B page to appear
    await expect(testId(page, "route-b-title")).toBeVisible({ timeout: 5000 });

    // useLoaderB should have different data (source is "server-b")
    await expect(testId(page, "use-loader-source-b")).toContainText(
      "Source: server-b"
    );
  });

  test("useFetchLoader data updates when navigating to different route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Verify we're on route A
    await expect(
      testId(page, "use-fetch-loader-preloaded-source")
    ).toContainText("Source: server");

    // Navigate to route B
    await testId(page, "navigate-to-b-link").click();

    // Wait for route B page
    await expect(testId(page, "route-b-title")).toBeVisible({ timeout: 5000 });

    // useFetchLoaderB should have different data
    await expect(testId(page, "use-fetch-loader-source-b")).toContainText(
      "Source: server-b"
    );
  });
});

test.describe("SSR behavior", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("useLoader data is available on initial SSR load (no flash)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to route A (SSR)
    await page.goto(f.url("/hook-tests/route-a"));

    // Data should be visible immediately without waiting for hydration
    // This tests that the SSR rendered the data correctly
    await expect(testId(page, "use-loader-data")).toBeVisible({ timeout: 500 });
    await expect(testId(page, "use-loader-source")).toContainText(
      "Source: server"
    );

    // Now wait for hydration and verify no errors
    await waitForHydration(page);
  });

  test("useFetchLoader preloaded data is available on SSR", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));

    // Preloaded data should be visible immediately
    await expect(
      testId(page, "use-fetch-loader-preloaded-data")
    ).toBeVisible({ timeout: 500 });

    await waitForHydration(page);
  });

  test("useFetchLoader unregistered shows no data on SSR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));

    // Unregistered loader should show "no data" message on SSR
    await expect(
      testId(page, "use-fetch-loader-unregistered-no-data")
    ).toBeVisible({ timeout: 500 });

    await waitForHydration(page);
  });
});

test.describe("Refetch via load() for registered loaders", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("useLoader can refetch data via load() button", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Get initial count
    const initialCount = await testId(page, "use-loader-count").textContent();

    // Click refetch button
    await testId(page, "use-loader-refetch-btn").click();

    // Wait for count to change (loader counter increases on each call)
    await expect(async () => {
      const newCount = await testId(page, "use-loader-count").textContent();
      expect(newCount).not.toEqual(initialCount);
    }).toPass({ timeout: 5000 });
  });

  test("useFetchLoader preloaded can refetch data via load() button", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Get initial count
    const initialCount = await testId(
      page,
      "use-fetch-loader-preloaded-count"
    ).textContent();

    // Click refetch button
    await testId(page, "use-fetch-loader-preloaded-refetch-btn").click();

    // Wait for count to change (loader is fast, so we poll for the update)
    await expect(async () => {
      const newCount = await testId(
        page,
        "use-fetch-loader-preloaded-count"
      ).textContent();
      expect(newCount).not.toEqual(initialCount);
    }).toPass({ timeout: 5000 });
  });
});

test.describe("Custom params via load()", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("useLoader can fetch with custom params via load()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Click fetch custom button which passes { routeId: "custom-via-load" }
    await testId(page, "use-loader-fetch-custom-btn").click();

    // Wait for loading to finish
    await expect(testId(page, "use-loader-loading")).not.toBeVisible({
      timeout: 5000,
    });

    // Route ID should reflect the custom param
    await expect(testId(page, "use-loader-route-id")).toContainText(
      "custom-via-load"
    );
  });

  test("useFetchLoader preloaded can fetch with custom params via load()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Click fetch custom button which passes { routeId: "custom-fetched" }
    await testId(page, "use-fetch-loader-preloaded-fetch-custom-btn").click();

    // Wait for loading to finish
    await expect(
      testId(page, "use-fetch-loader-preloaded-loading")
    ).not.toBeVisible({ timeout: 5000 });

    // Route ID should reflect the custom param
    await expect(
      testId(page, "use-fetch-loader-preloaded-route-id")
    ).toContainText("custom-fetched");
  });
});

test.describe("Error handling - throwOnError: false", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("should capture error in state when throwOnError is false", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Initially no error
    await expect(testId(page, "error-loader-error")).not.toBeVisible();

    // Trigger error
    await testId(page, "error-loader-trigger-error-btn").click();

    // Wait for loading to complete
    await expect(testId(page, "error-loader-loading")).not.toBeVisible({
      timeout: 5000,
    });

    // Error should be captured in state (not thrown)
    await expect(testId(page, "error-loader-error")).toBeVisible();
    await expect(testId(page, "error-loader-error")).toContainText(
      "Intentional loader error"
    );
  });

  test("should recover from error on successful fetch", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Trigger error first
    await testId(page, "error-loader-trigger-error-btn").click();
    await expect(testId(page, "error-loader-error")).toBeVisible({
      timeout: 5000,
    });

    // Now fetch success
    await testId(page, "error-loader-success-btn").click();

    // Wait for loading
    await expect(testId(page, "error-loader-loading")).not.toBeVisible({
      timeout: 5000,
    });

    // Error should be cleared, data should be visible
    await expect(testId(page, "error-loader-error")).not.toBeVisible();
    await expect(testId(page, "error-loader-data")).toBeVisible();
    await expect(testId(page, "error-loader-message")).toContainText(
      "Success - error was bypassed"
    );
  });
});

test.describe("Error handling - throwOnError: true (default)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("should propagate error to ErrorBoundary when throwOnError is true", async ({
    page,
  }) => {
    // When throwOnError: true (default), errors are thrown during render
    // so ErrorBoundaries can catch them

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Initially shows the inner component with no data
    await expect(
      testId(page, "unhandled-error-loader-inner")
    ).toBeVisible();
    await expect(
      testId(page, "unhandled-error-error-boundary")
    ).not.toBeVisible();

    // Trigger error
    await testId(page, "unhandled-error-trigger-btn").click();

    // ErrorBoundary should catch the error (thrown during render)
    await expect(
      testId(page, "unhandled-error-error-boundary")
    ).toBeVisible({ timeout: 5000 });
    await expect(
      testId(page, "unhandled-error-error-message")
    ).toContainText("Intentional loader error");

    // Inner component should be replaced by error boundary fallback
    await expect(
      testId(page, "unhandled-error-loader-inner")
    ).not.toBeVisible();
  });
});

test.describe("Middleware security for fetchable loaders", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("middleware rejects unauthorized requests (no auth token)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Initially no data or error
    await expect(testId(page, "protected-loader-no-data")).toBeVisible();

    // Try to fetch without auth token
    await testId(page, "protected-loader-unauthorized-btn").click();

    // Wait for loading to complete
    await expect(testId(page, "protected-loader-loading")).not.toBeVisible({
      timeout: 5000,
    });

    // Should show error (unauthorized)
    await expect(testId(page, "protected-loader-error")).toBeVisible();
    await expect(testId(page, "protected-loader-error")).toContainText(
      "Unauthorized"
    );

    // Data should NOT be visible
    await expect(testId(page, "protected-loader-data")).not.toBeVisible();
  });

  test("middleware rejects invalid auth token", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Try to fetch with invalid token
    await testId(page, "protected-loader-invalid-token-btn").click();

    // Wait for loading to complete
    await expect(testId(page, "protected-loader-loading")).not.toBeVisible({
      timeout: 5000,
    });

    // Should show error
    await expect(testId(page, "protected-loader-error")).toBeVisible();
    await expect(testId(page, "protected-loader-error")).toContainText(
      "Unauthorized"
    );
  });

  test("middleware allows valid auth token", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Fetch with valid token
    await testId(page, "protected-loader-authorized-btn").click();

    // Wait for loading to complete
    await expect(testId(page, "protected-loader-loading")).not.toBeVisible({
      timeout: 5000,
    });

    // Should show data (protected content)
    await expect(testId(page, "protected-loader-data")).toBeVisible();
    await expect(testId(page, "protected-loader-secret")).toContainText(
      "This is protected data"
    );
    await expect(testId(page, "protected-loader-user-id")).toContainText(
      "User ID: user1"
    );

    // Error should NOT be visible
    await expect(testId(page, "protected-loader-error")).not.toBeVisible();
  });
});

test.describe("Fetched data resets on navigation", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("useFetchLoader data from load() is replaced by context on navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/route-a"));
    await waitForHydration(page);

    // Fetch with custom params to get custom data
    await testId(page, "use-fetch-loader-preloaded-fetch-custom-btn").click();
    await expect(
      testId(page, "use-fetch-loader-preloaded-loading")
    ).not.toBeVisible({ timeout: 5000 });

    // Verify custom data was fetched
    await expect(
      testId(page, "use-fetch-loader-preloaded-route-id")
    ).toContainText("custom-fetched");

    // Navigate to route B
    await testId(page, "navigate-to-b-link").click();
    await expect(testId(page, "route-b-title")).toBeVisible({ timeout: 5000 });

    // Navigate back to route A
    await testId(page, "navigate-to-a-link").click();
    await expect(testId(page, "route-a-title")).toBeVisible({ timeout: 5000 });

    // Data should be from context (server SSR), not the previously fetched custom data
    // The route ID should be "default" or similar, NOT "custom-fetched"
    await expect(
      testId(page, "use-fetch-loader-preloaded-route-id")
    ).not.toContainText("custom-fetched");
    await expect(
      testId(page, "use-fetch-loader-preloaded-source")
    ).toContainText("Source: server");
  });
});

test.describe("useLoader throws when data missing", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("useLoader throws error when loader is NOT registered on route", async ({
    page,
  }) => {
    // This route does NOT have HookTestLoader registered via loader()
    // So useLoader should throw immediately during render

    await page.goto(f.url("/hook-tests/no-loader"));
    await waitForHydration(page);

    // ErrorBoundary should catch the throw
    await expect(
      testId(page, "use-loader-throws-error-boundary")
    ).toBeVisible();

    // Error message should indicate data not found in context
    await expect(
      testId(page, "use-loader-throws-error-message")
    ).toContainText("data not found in context");

    // The actual data should NOT be visible (component threw before rendering)
    await expect(testId(page, "use-loader-throws-data")).not.toBeVisible();
  });
});

test.describe("isLoading state verification", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("isLoading is false initially, true during fetch, false after", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/form-action"));
    await waitForHydration(page);

    // Initially isLoading should be false
    await expect(testId(page, "is-loading-status")).toContainText(
      "isLoading: false"
    );

    // Click fetch button
    await testId(page, "is-loading-fetch-btn").click();

    // isLoading should become true
    await expect(testId(page, "is-loading-status")).toContainText(
      "isLoading: true"
    );

    // Wait for fetch to complete
    await expect(testId(page, "is-loading-data")).toBeVisible({ timeout: 5000 });

    // isLoading should be false again
    await expect(testId(page, "is-loading-status")).toContainText(
      "isLoading: false"
    );
  });
});

test.describe("Form action support", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  test("form action triggers loader fetch on submit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/form-action"));
    await waitForHydration(page);

    // Initially no data
    await expect(testId(page, "form-action-no-data")).toBeVisible();

    // Submit the form
    await testId(page, "form-action-submit-btn").click();

    // Wait for data to appear
    await expect(testId(page, "form-action-data")).toBeVisible({
      timeout: 5000,
    });

    // Verify data was fetched
    await expect(testId(page, "form-action-message")).toContainText(
      "Fetched from unregistered loader"
    );
  });

  test("form uses correct server action markup for progressive enhancement", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/form-action"));
    await waitForHydration(page);

    // Verify the progressive enhancement form has correct server action markup
    // This form uses useActionState with loader.action directly
    const formHtml = await testId(
      page,
      "form-action-progressive-form"
    ).evaluate((el) => el.outerHTML);

    // Should have method="POST" and enctype for server actions
    expect(formHtml).toContain('method="POST"');
    expect(formHtml).toContain('enctype="multipart/form-data"');

    // Should have server action reference hidden inputs
    expect(formHtml).toContain('name="$ACTION_REF_');
    expect(formHtml).toContain('name="$ACTION_KEY"');

    // Should NOT have the javascript: trap (that indicates a client-only action)
    expect(formHtml).not.toContain("javascript:throw");
  });

  // This test is expected to fail until the framework supports returning HTML
  // instead of RSC payload for no-JS clients
  test.fail(
    "form action works without JavaScript (progressive enhancement)",
    async ({ browser }) => {
      // Create a new context with JavaScript disabled
      const context = await browser.newContext({
        javaScriptEnabled: false,
      });
      const page = await context.newPage();

      try {
        await page.goto(f.url("/hook-tests/form-action"));

        // The progressive enhancement form should render with no data
        await expect(
          testId(page, "form-action-progressive-no-data")
        ).toBeVisible();

        // Submit the form - native POST submission
        await testId(page, "form-action-progressive-submit-btn").click();

        // Wait for navigation to complete
        await page.waitForLoadState("networkidle");

        // EXPECTED TO FAIL: Server returns RSC payload (text/x-component)
        // instead of HTML, so without JS the result can't be displayed.
        // When framework adds HTML fallback support, this test should pass.
        await expect(
          testId(page, "form-action-progressive-data")
        ).toBeVisible({ timeout: 5000 });

        await expect(
          testId(page, "form-action-progressive-message")
        ).toContainText("Fetched from unregistered loader");
      } finally {
        await context.close();
      }
    }
  );
});

// TODO: Error sanitization in production test requires preview script in test-app
// test.describe("Error sanitization in production", () => {
//   const f = useFixture({
//     root: "./e2e/test-app",
//     mode: "build",
//   });
//
//   test.setTimeout(60000);
//
//   test("loader errors are sanitized in production (no detailed message)", async ({
//     page,
//   }) => {
//     await page.goto(f.url("/hook-tests/route-a"));
//     await waitForHydration(page);
//     await testId(page, "protected-loader-unauthorized-btn").click();
//     await expect(testId(page, "protected-loader-error")).toBeVisible({
//       timeout: 5000,
//     });
//     await expect(testId(page, "protected-loader-error")).toContainText(
//       "An error occurred"
//     );
//     await expect(testId(page, "protected-loader-error")).not.toContainText(
//       "Unauthorized"
//     );
//   });
// });
