import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * React Performance Tracks — verifies inline timing data in RSC streams.
 *
 * Dev-only: React writes D{"time":...} rows directly into the RSC stream
 * when no debugChannel is passed to renderToReadableStream. The client
 * reads them via createFromReadableStream/createFromFetch, and Chrome
 * DevTools displays them in the Server Components performance track.
 *
 * Production builds strip debug data, so these tests are dev-only by design.
 */
test.describe("performance-tracks (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("SSR flight data should contain inline timing D rows", async ({
    request,
  }) => {
    const response = await request.get(f.url("/"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);

    const html = await response.text();

    // React writes D{"time":...} rows into the RSC flight data which is
    // embedded in the HTML via __FLIGHT_DATA__ script chunks. The escaped
    // form in HTML is :D{\"time\": or :D{\\"time\\":
    const hasTimingData =
      html.includes(':D{\\"time\\":') || html.includes(':D{"time":');
    expect(hasTimingData).toBe(true);
  });

  test("RSC partial response should contain inline timing D rows", async ({
    request,
  }) => {
    // Fetch a partial RSC response (simulates SPA navigation)
    const response = await request.get(
      f.url("/?_rsc_partial=true&_rsc_segments=M0L0,M0L0R0"),
    );
    expect(response.status()).toBe(200);

    const body = await response.text();

    // Partial responses also include inline timing data
    expect(body).toContain(':D{"time":');
  });
});

// Production: React strips debug data, so no timing rows should be present.
test.describe("performance-tracks (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("production SSR should NOT contain timing D rows", async ({
    request,
  }) => {
    const response = await request.get(f.url("/"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);

    const html = await response.text();

    // Production builds strip debug data — no D{"time":...} rows
    expect(html).not.toContain(':D{"time":');
    expect(html).not.toContain(':D{\\"time\\":');
  });

  test("production partial should NOT contain timing D rows", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/?_rsc_partial=true&_rsc_segments=M0L0,M0L0R0"),
    );
    expect(response.status()).toBe(200);

    const body = await response.text();

    expect(body).not.toContain(':D{"time":');
  });
});
