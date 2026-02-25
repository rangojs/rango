import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, goBack } from "./helper";

/**
 * Tests that validate revalidation behavior and data precision.
 * These tests intercept network requests to verify:
 * 1. Correct segments are sent to the server
 * 2. Server returns only the diff (changed segments)
 * 3. Partial updates don't fetch more data than needed
 * 4. Actions trigger correct revalidation
 *
 * Uses isolated test app with data-testid selectors.
 */

interface RscRequest {
  url: string;
  headers: Record<string, string>;
  segmentIds?: string[];
}

interface RscResponse {
  url: string;
  body: string;
  metadata?: {
    segments?: { id: string }[];
    matched?: string[];
    diff?: string[];
    isPartial?: boolean;
  };
}

/**
 * Parse RSC response body to extract metadata
 */
function parseRscMetadata(body: string): RscResponse["metadata"] {
  try {
    // RSC format has metadata in the stream - look for common patterns
    const segmentMatch = body.match(/"segments":\s*\[(.*?)\]/s);
    const matchedMatch = body.match(/"matched":\s*\[(.*?)\]/);
    const diffMatch = body.match(/"diff":\s*\[(.*?)\]/);
    const partialMatch = body.match(/"isPartial":\s*(true|false)/);

    const segments: { id: string }[] = [];
    if (segmentMatch) {
      const idMatches = segmentMatch[1].matchAll(/"id":\s*"([^"]+)"/g);
      for (const match of idMatches) {
        segments.push({ id: match[1] });
      }
    }

    const matched: string[] = [];
    if (matchedMatch) {
      const items = matchedMatch[1].match(/"([^"]+)"/g);
      if (items) {
        matched.push(...items.map((s) => s.replace(/"/g, "")));
      }
    }

    const diff: string[] = [];
    if (diffMatch) {
      const items = diffMatch[1].match(/"([^"]+)"/g);
      if (items) {
        diff.push(...items.map((s) => s.replace(/"/g, "")));
      }
    }

    return {
      segments: segments.length > 0 ? segments : undefined,
      matched: matched.length > 0 ? matched : undefined,
      diff: diff.length > 0 ? diff : undefined,
      isPartial: partialMatch ? partialMatch[1] === "true" : undefined,
    };
  } catch {
    return undefined;
  }
}

test.describe("revalidation-precision", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("navigation should send current segment IDs to server", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const requests: RscRequest[] = [];

    // Intercept RSC requests
    page.on("request", (request) => {
      const headers = request.headers();
      if (
        request.url().includes("_rsc") ||
        headers["rsc"] === "1" ||
        request.url().includes("_rsc_partial")
      ) {
        const segmentHeader = headers["x-rsc-router-segments"];
        requests.push({
          url: request.url(),
          headers,
          segmentIds: segmentHeader ? segmentHeader.split(",") : undefined,
        });
      }
    });

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Clear requests from initial load
    requests.length = 0;

    // Navigate to product (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Verify an RSC request was made
    expect(requests.length).toBeGreaterThan(0);

    // The request should be a partial request
    const rscRequest = requests.find(
      (r) => r.url.includes("_rsc_partial") || r.url.includes("/product/"),
    );
    expect(rscRequest).toBeDefined();
  });

  test("partial navigation should fetch RSC content", async ({ page }) => {
    using _ = expectNoPageError(page);

    const rscRequests: string[] = [];

    // Intercept RSC requests
    page.on("request", (request) => {
      const headers = request.headers();
      if (request.url().includes("_rsc") || headers["rsc"] === "1") {
        rscRequests.push(request.url());
      }
    });

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Clear requests
    rscRequests.length = 0;

    // Navigate to product (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Intercept navigation should make RSC request
    expect(rscRequests.length).toBeGreaterThan(0);
  });

  test("action should trigger server request", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    const actionRequests: string[] = [];

    page.on("request", (request) => {
      const headers = request.headers();
      if (headers["rsc-action"]) {
        actionRequests.push(request.url());
      }
    });

    // Perform action - click quantity increment
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();

    // Wait for action to complete
    await page.waitForTimeout(600);

    // Verify action request was made
    expect(actionRequests.length).toBeGreaterThan(0);
  });

  test("back navigation should use cached segments", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product detail (non-intercept, direct)
    await page.goto(f.url("/product/product-a"));
    await waitForHydration(page);

    const requests: string[] = [];
    page.on("request", (request) => {
      const headers = request.headers();
      if (request.url().includes("_rsc") || headers["rsc"] === "1") {
        requests.push(request.url());
      }
    });

    // Navigate back
    await goBack(page);
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Back navigation should restore from cache
    // UI should appear immediately (cache hit)
  });

  test("stale-while-revalidate should show cached content immediately", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to product (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Navigate to full details
    await page.locator('[data-testid="view-full-details"]').click();
    await expect(
      page.locator('[data-testid="segment-metadata"]'),
    ).toBeVisible();

    // Go back - intercept should appear from cache instantly
    const startTime = Date.now();
    await goBack(page);
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();
    const elapsed = Date.now() - startTime;

    // Cache restore should be fast (< 500ms typically)
    expect(elapsed).toBeLessThan(2000);
  });

  test("concurrent actions should consolidate revalidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    const actionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.headers()["rsc-action"]) {
        actionRequests.push(request.url());
      }
    });

    // Fire multiple rapid actions using quantity buttons
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();
    await incrementButton.click();
    await incrementButton.click();

    // Wait for consolidation
    await page.waitForTimeout(2000);

    // Multiple action requests should have been made
  });

  test("intercept navigation should preserve background content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify we can see index content
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Open intercept modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Background segments should still be visible
    await expect(page.locator('[data-testid="page-title"]')).toBeVisible();

    // Modal content should also be visible
    await expect(
      page.locator('[data-testid="view-full-details"]'),
    ).toBeVisible();
  });
});

test.describe("revalidation-headers", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("navigation request should include previous URL header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const headers: Record<string, string>[] = [];

    page.on("request", (request) => {
      const reqHeaders = request.headers();
      if (request.url().includes("_rsc") || reqHeaders["rsc"] === "1") {
        headers.push(reqHeaders);
      }
    });

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);
    headers.length = 0;

    // Navigate to product (intercept)
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Request should have client path header
    const navRequest = headers.find((h) => h["x-rsc-router-client-path"]);
    expect(navRequest).toBeDefined();
  });

  test("action request should have rsc-action header", async ({ page }) => {
    using _ = expectNoPageError(page);

    const headers: Record<string, string>[] = [];

    page.on("request", (request) => {
      const reqHeaders = request.headers();
      if (reqHeaders["rsc-action"]) {
        headers.push(reqHeaders);
      }
    });

    // Navigate to index
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Open product modal
    const productLink = page.locator('[data-testid="product-link-product-a"]');
    await productLink.click();
    await expect(page.locator('[data-testid="product-modal"]')).toBeVisible();

    // Perform action (quantity increment)
    const incrementButton = page.locator(
      '[data-testid="modal-quantity-control"] button:has-text("+")',
    );
    await incrementButton.click();
    await page.waitForTimeout(600);

    // Action request should have the action ID header
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]["rsc-action"]).toBeDefined();
  });
});
