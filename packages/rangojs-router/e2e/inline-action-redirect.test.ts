import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for inline action redirects.
 *
 * When a server action throws redirect(), the server renders the redirect
 * target directly in the action response. The browser applies the segments
 * without making a second request.
 *
 * Key assertions:
 * - Only ONE HTTP request (the action POST) — no subsequent _rsc_partial GET
 * - URL updates to the redirect target
 * - Redirect target content is rendered correctly
 * - Cookies set during the action are visible to loaders on the redirect target
 */

test.describe("inline-action-redirect (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("throw redirect renders target inline — no second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Track network requests
    const rscRequests: { url: string; method: string }[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("_rsc_partial") || url.includes("_rsc_action")) {
        rscRequests.push({ url, method: req.method() });
      }
    });

    // Navigate to location-state page
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Clear tracked requests
    rscRequests.length = 0;

    // Click "Throw simple redirect" button (redirects to /location-state/target)
    await page.locator('[data-testid="throw-simple-redirect-btn"]').click();

    // Wait for the redirect target to appear
    await expect(page.locator('[data-testid="ls-target"]')).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Redirect target");

    // URL should be updated to the redirect target
    expect(page.url()).toContain("/location-state/target");

    // Wait a bit to ensure no late requests
    await page.waitForTimeout(500);

    // Verify: only one POST request, no _rsc_partial GET
    const actionRequests = rscRequests.filter((r) => r.method === "POST");
    const partialGets = rscRequests.filter(
      (r) => r.method === "GET" && r.url.includes("_rsc_partial"),
    );

    expect(actionRequests.length).toBe(1);
    expect(partialGets.length).toBe(0);
  });

  test("redirect with variable — ctx.get() reads action-set variable on target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Track network requests
    const rscRequests: { url: string; method: string }[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("_rsc_partial") || url.includes("_rsc_action")) {
        rscRequests.push({ url, method: req.method() });
      }
    });

    // Navigate to location-state page
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Clear tracked requests
    rscRequests.length = 0;

    // Click "Redirect with variable" button
    await page.locator('[data-testid="throw-redirect-variable-btn"]').click();

    // Wait for the redirect target to appear
    await expect(
      page.locator('[data-testid="inline-redirect-target"]'),
    ).toBeVisible();

    // Verify the variable set by the action is readable on the redirect target
    await expect(page.locator('[data-testid="variable-value"]')).toHaveText(
      "Variable: value-from-action",
    );

    // URL should be updated
    expect(page.url()).toContain("/inline-redirect-target");

    // Wait a bit to ensure no late requests
    await page.waitForTimeout(500);

    // Verify: only one POST, no _rsc_partial GET
    const actionRequests = rscRequests.filter((r) => r.method === "POST");
    const partialGets = rscRequests.filter(
      (r) => r.method === "GET" && r.url.includes("_rsc_partial"),
    );

    expect(actionRequests.length).toBe(1);
    expect(partialGets.length).toBe(0);
  });
});

test.describe("inline-action-redirect (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("throw redirect renders target inline — no second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Track network requests
    const rscRequests: { url: string; method: string }[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("_rsc_partial") || url.includes("_rsc_action")) {
        rscRequests.push({ url, method: req.method() });
      }
    });

    // Navigate to location-state page
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Clear tracked requests
    rscRequests.length = 0;

    // Click "Throw simple redirect" button (redirects to /location-state/target)
    await page.locator('[data-testid="throw-simple-redirect-btn"]').click();

    // Wait for the redirect target to appear
    await expect(page.locator('[data-testid="ls-target"]')).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Redirect target");

    // URL should be updated to the redirect target
    expect(page.url()).toContain("/location-state/target");

    // Wait a bit to ensure no late requests
    await page.waitForTimeout(500);

    // Verify: only one POST request, no _rsc_partial GET
    const actionRequests = rscRequests.filter((r) => r.method === "POST");
    const partialGets = rscRequests.filter(
      (r) => r.method === "GET" && r.url.includes("_rsc_partial"),
    );

    expect(actionRequests.length).toBe(1);
    expect(partialGets.length).toBe(0);
  });

  test("redirect with variable — ctx.get() reads action-set variable on target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Track network requests
    const rscRequests: { url: string; method: string }[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("_rsc_partial") || url.includes("_rsc_action")) {
        rscRequests.push({ url, method: req.method() });
      }
    });

    // Navigate to location-state page
    await page.goto(f.url("/location-state"));
    await waitForHydration(page);

    // Clear tracked requests
    rscRequests.length = 0;

    // Click "Redirect with variable" button
    await page.locator('[data-testid="throw-redirect-variable-btn"]').click();

    // Wait for the redirect target to appear
    await expect(
      page.locator('[data-testid="inline-redirect-target"]'),
    ).toBeVisible();

    // Verify the variable set by the action is readable on the redirect target
    await expect(page.locator('[data-testid="variable-value"]')).toHaveText(
      "Variable: value-from-action",
    );

    // URL should be updated
    expect(page.url()).toContain("/inline-redirect-target");

    // Wait a bit to ensure no late requests
    await page.waitForTimeout(500);

    // Verify: only one POST, no _rsc_partial GET
    const actionRequests = rscRequests.filter((r) => r.method === "POST");
    const partialGets = rscRequests.filter(
      (r) => r.method === "GET" && r.url.includes("_rsc_partial"),
    );

    expect(actionRequests.length).toBe(1);
    expect(partialGets.length).toBe(0);
  });
});
