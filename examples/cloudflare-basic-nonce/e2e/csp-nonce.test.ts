import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, expectNoCSPViolations, testId } from "./helper";

test.describe("CSP nonce support", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("should include CSP header with nonce on initial page load", async ({ page }) => {
    // Intercept the response to check headers
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(f.url("/")) && response.status() === 200
    );

    await page.goto(f.url("/"));
    const response = await responsePromise;

    // In dev mode (localhost), we use Content-Security-Policy-Report-Only
    // to avoid blocking HMR scripts
    const cspHeader =
      response.headers()["content-security-policy-report-only"] ||
      response.headers()["content-security-policy"];
    expect(cspHeader).toBeDefined();
    expect(cspHeader).toContain("script-src");
    expect(cspHeader).toContain("'nonce-");
    expect(cspHeader).toContain("'strict-dynamic'");
  });

  test("should have unique nonce for each request", async ({ page }) => {
    // Helper to get CSP header (works in both dev and prod mode)
    const getCSPHeader = (response: { headers: () => Record<string, string> }) =>
      response.headers()["content-security-policy-report-only"] ||
      response.headers()["content-security-policy"];

    // Get first response
    const response1Promise = page.waitForResponse((response) =>
      response.url().includes(f.url("/")) && response.status() === 200
    );
    await page.goto(f.url("/"));
    const response1 = await response1Promise;
    const csp1 = getCSPHeader(response1);

    // Extract nonce from CSP header
    const nonceMatch1 = csp1?.match(/'nonce-([^']+)'/);
    expect(nonceMatch1).toBeTruthy();
    const nonce1 = nonceMatch1![1];

    // Get second response (hard navigation)
    const response2Promise = page.waitForResponse((response) =>
      response.url().includes(f.url("/about")) && response.status() === 200
    );
    await page.goto(f.url("/about"));
    const response2 = await response2Promise;
    const csp2 = getCSPHeader(response2);

    // Extract nonce from second CSP header
    const nonceMatch2 = csp2?.match(/'nonce-([^']+)'/);
    expect(nonceMatch2).toBeTruthy();
    const nonce2 = nonceMatch2![1];

    // Nonces should be different for each request
    expect(nonce1).not.toBe(nonce2);
  });

  test("should have nonce attribute on inline scripts in raw HTML", async ({ page }) => {
    // Browsers hide nonce values from JS for security (getAttribute returns "")
    // So we need to check the raw HTML response instead
    const response = await page.goto(f.url("/"));
    const html = await response!.text();

    // Check that inline scripts have nonce attributes in the HTML
    // The RSC payload scripts should have nonce
    const scriptNonceMatches = html.match(/<script[^>]*\snonce="[^"]+"/g);
    expect(scriptNonceMatches).toBeTruthy();
    expect(scriptNonceMatches!.length).toBeGreaterThan(0);

    // Verify scripts can still execute (hydration works)
    await waitForHydration(page);
    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should not have CSP violations during hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // If we get here without the expectNoCSPViolations throwing, we're good
    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should work with client-side navigation (no CSP on RSC responses)", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate via client-side link
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    // Navigate to counter
    await testId(page, "nav-counter").click();
    await expect(testId(page, "counter-page")).toBeVisible();
  });

  test("should work with server actions under CSP", async ({ page }) => {
    using _ = expectNoPageError(page);
    using __ = expectNoCSPViolations(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Get initial count
    const initialText = await testId(page, "counter-value").textContent();
    const initialCount = parseInt(initialText?.match(/\d+/)?.[0] ?? "0", 10);

    // Trigger server action
    await testId(page, "counter-increment").click();
    await expect(testId(page, "counter-pending")).not.toBeVisible({ timeout: 10000 });

    // Verify action worked
    const newText = await testId(page, "counter-value").textContent();
    const newCount = parseInt(newText?.match(/\d+/)?.[0] ?? "0", 10);
    expect(newCount).toBe(initialCount + 1);
  });

  test("should not expose nonce in x-nonce header (internal header removed)", async ({ page }) => {
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(f.url("/")) && response.status() === 200
    );

    await page.goto(f.url("/"));
    const response = await responsePromise;

    // x-nonce header should be removed (it's internal)
    const xNonceHeader = response.headers()["x-nonce"];
    expect(xNonceHeader).toBeUndefined();
  });

  test("should use Report-Only CSP header in dev mode (localhost)", async ({ page }) => {
    // In dev mode, we use Content-Security-Policy-Report-Only
    // so that HMR scripts are not blocked
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(f.url("/")) && response.status() === 200
    );

    await page.goto(f.url("/"));
    const response = await responsePromise;

    // Dev mode should use Report-Only header
    const reportOnlyHeader = response.headers()["content-security-policy-report-only"];
    const enforcingHeader = response.headers()["content-security-policy"];

    // In dev (localhost), we expect Report-Only, not enforcing
    expect(reportOnlyHeader).toBeDefined();
    expect(enforcingHeader).toBeUndefined();
  });
});
