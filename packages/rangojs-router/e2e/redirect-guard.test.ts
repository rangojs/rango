/**
 * E2E: server-side open-redirect guard (defense-in-depth, #572).
 *
 * The client already blocks cross-origin redirects on the JS/fetch path
 * (validateRedirectOrigin). These tests cover the server half: every
 * browser-followed (document-native) redirect -- a full-page middleware
 * redirect and a no-JS PE form action redirect -- is same-origin guarded before
 * it leaves the handler. A cross-origin Location is neutralized to the app root;
 * redirect(url, { external: true }) opts a single redirect out.
 *
 * The middleware cases assert the raw HTTP `Location` header (maxRedirects: 0),
 * so no browser navigation to an off-host target is needed and the same guard is
 * exercised in both dev and production.
 */
import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { testId } from "./helper";

const EVIL = "https://evil.example/phish";
const EXTERNAL = "https://accounts.example.com/oauth";

// Shared test body. Called inside each (dev / production) describe with that
// suite's fixture, so the describe titles stay literal for the bucketing guard.
function redirectGuardTests(f: Fixture) {
  const goUrl = (to: string, ext = false) => {
    const params = new URLSearchParams({ to });
    if (ext) params.set("ext", "1");
    return f.url(`/redirect-guard/go?${params.toString()}`);
  };

  test("blocks a cross-origin middleware redirect, rewriting Location to root", async ({
    request,
  }) => {
    const res = await request.get(goUrl(EVIL), { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toBe("/");
  });

  test("blocks a protocol-relative cross-origin redirect", async ({
    request,
  }) => {
    const res = await request.get(goUrl("//evil.example/phish"), {
      maxRedirects: 0,
    });
    expect(res.headers()["location"]).toBe("/");
  });

  test("allows a same-origin redirect unchanged", async ({ request }) => {
    const res = await request.get(goUrl("/dashboard"), { maxRedirects: 0 });
    expect(res.headers()["location"]).toBe("/dashboard");
  });

  test("allows a cross-origin redirect opted in with { external: true } and strips the marker", async ({
    request,
  }) => {
    const res = await request.get(goUrl(EXTERNAL, true), { maxRedirects: 0 });
    expect(res.headers()["location"]).toBe(EXTERNAL);
    // The internal opt-in marker must never reach the browser.
    expect(res.headers()["x-rango-redirect-external"]).toBeUndefined();
  });

  // Soft (partial) channel: middleware 3xx becomes 204 + X-RSC-Redirect after
  // server-side origin resolve (interceptRedirectForPartial).
  test("soft partial: same-origin redirect becomes 204 + absolute X-RSC-Redirect", async ({
    request,
  }) => {
    const res = await request.get(goUrl("/dashboard") + "&_rsc_partial=1", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(204);
    const soft = res.headers()["x-rsc-redirect"];
    expect(soft).toBeTruthy();
    expect(new URL(soft!).pathname).toBe("/dashboard");
    expect(res.headers()["location"]).toBeUndefined();
  });

  test("soft partial: cross-origin without external is neutralized to /", async ({
    request,
  }) => {
    const res = await request.get(goUrl(EVIL) + "&_rsc_partial=1", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(204);
    const soft = res.headers()["x-rsc-redirect"];
    expect(soft).toBeTruthy();
    expect(soft).toBe("/");
  });

  test("soft partial: external opt-in returns Flight redirect (not document Location)", async ({
    request,
  }) => {
    // Production routes external soft redirects through createRedirectFlightResponse
    // (200 text/x-component + metadata.redirect.external), not 204 X-RSC-Redirect.
    const res = await request.get(goUrl(EXTERNAL, true) + "&_rsc_partial=1", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("text/x-component");
    expect(res.headers()["location"]).toBeUndefined();
    expect(res.headers()["x-rango-redirect-external"]).toBeUndefined();
    const body = await res.text();
    expect(body).toContain(EXTERNAL);
  });

  // No-JS PE: the browser natively follows the form POST's redirect, so the
  // guard is the only protection. A cross-origin action redirect must land the
  // user on the app root, never on the off-host target.
  test.describe("with JavaScript disabled", () => {
    test.use({ javaScriptEnabled: false });

    test("blocks a no-JS PE form action cross-origin redirect (lands on root)", async ({
      page,
    }) => {
      await page.goto(f.url("/pe-redirect"));
      await expect(testId(page, "pe-redirect-title")).toHaveText(
        "PE Redirect Test",
      );

      await testId(page, "pe-external-redirect-btn").click();
      await page.waitForLoadState("domcontentloaded");

      // Neutralized to same-origin root, NOT evil.example.
      expect(page.url()).not.toContain("evil.example");
      expect(new URL(page.url()).host).toBe(new URL(f.url("/")).host);
      await expect(testId(page, "index-page")).toBeVisible();
    });

    // Regression for the marker-survives-PE-rebuild bug: an off-host redirect
    // WITH { external: true } must be followed even on the no-JS PE channel
    // (the marker has to survive extractRedirectResponse to reach the guard).
    // The off-host navigation is intercepted so the test never leaves for a
    // real host; reaching it at all proves the guard allowed the redirect.
    test("allows a no-JS PE form action external redirect (follows off-host)", async ({
      page,
    }) => {
      // Stub the off-host target so the test never leaves for a real host. The
      // browser issuing a GET to accounts.example.com at all is proof the guard
      // emitted the off-host Location (a root rewrite would never request it).
      await page.route("https://accounts.example.com/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<h1>external landing</h1>",
        }),
      );

      await page.goto(f.url("/pe-redirect"));
      await expect(testId(page, "pe-redirect-title")).toHaveText(
        "PE Redirect Test",
      );

      const [offHostRequest] = await Promise.all([
        page.waitForRequest("https://accounts.example.com/**"),
        testId(page, "pe-external-allowed-btn").click(),
      ]);

      expect(offHostRequest.url()).toContain("accounts.example.com/oauth");
    });
  });
}

// ---------------------------------------------------------------------------
// Dev
// ---------------------------------------------------------------------------
test.describe("redirect guard", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  redirectGuardTests(f);
});

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------
test.describe("redirect guard (production)", () => {
  test.setTimeout(120000);
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  redirectGuardTests(f);
});
