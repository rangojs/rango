/**
 * E2E: Origin guard (CSRF protection).
 *
 * Verifies that cross-origin requests to server actions, loader fetches,
 * and PE form submissions are rejected with 403.
 * Same-origin requests and regular page navigations are unaffected.
 */
import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

// ---------------------------------------------------------------------------
// Helper: build a cross-origin request with a spoofed Origin header
// ---------------------------------------------------------------------------
function crossOriginHeaders(accept = "text/x-component") {
  return {
    Accept: accept,
    Origin: "https://evil.com",
  };
}

// ---------------------------------------------------------------------------
// Dev
// ---------------------------------------------------------------------------
test.describe("origin guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(30000);

  test("cross-origin loader fetch is rejected with 403", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23FetchableTestLoader"),
      { headers: crossOriginHeaders() },
    );

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("same-origin loader fetch is allowed", async ({ request }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23FetchableTestLoader"),
      {
        headers: {
          Accept: "text/x-component",
          // No Origin header = same-origin or non-browser client
        },
      },
    );

    expect(response.status()).toBe(200);
  });

  test("cross-origin action request is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/?_rsc_action=some-action-id"), {
      headers: {
        ...crossOriginHeaders(),
        "rsc-action": "some-action-id",
      },
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("cross-origin POST (PE form) is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/"), {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: "field=value",
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("regular page navigation is not affected", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expect(testId(page, "index-page")).toBeVisible();
  });

  test("same-origin browser interactions work normally", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    // Trigger a loader fetch from same-origin browser context
    await testId(page, "fetch-loader-btn-default").click();
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET",
    );
  });
});

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------
test.describe("origin guard (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  // Discover production hashed loader IDs
  let loaderIds: { fetchable: string };

  test.beforeAll(async ({ request }) => {
    const res = await request.get(f.url("/__test/loader-ids"), {
      headers: { Accept: "application/json" },
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    loaderIds = json;
  });

  test("cross-origin loader fetch is rejected with 403", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.fetchable)}`,
      ),
      { headers: crossOriginHeaders() },
    );

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("same-origin loader fetch is allowed", async ({ request }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.fetchable)}`,
      ),
      {
        headers: {
          Accept: "text/x-component",
        },
      },
    );

    expect(response.status()).toBe(200);
  });

  test("cross-origin action request is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/?_rsc_action=some-action-id"), {
      headers: {
        ...crossOriginHeaders(),
        "rsc-action": "some-action-id",
      },
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("cross-origin POST (PE form) is rejected with 403", async ({
    request,
  }) => {
    const response = await request.post(f.url("/"), {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: "field=value",
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["x-rango-origin-check"]).toBe("failed");
  });

  test("regular page navigation is not affected", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expect(testId(page, "index-page")).toBeVisible();
  });

  test("same-origin browser interactions work normally", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fetch-loader"));
    await waitForHydration(page);

    await testId(page, "fetch-loader-btn-default").click();
    await expect(testId(page, "fetch-loader-data")).toBeVisible({
      timeout: 5000,
    });
    await expect(testId(page, "fetch-loader-message")).toContainText(
      "Fetched via GET",
    );
  });
});
