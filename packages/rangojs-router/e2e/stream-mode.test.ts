import test, { expect } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * SSR stream-mode e2e tests.
 *
 * The test-app router configures ssr.resolveStreaming to return "allReady"
 * when the User-Agent contains "StreamBot", and "stream" otherwise.
 *
 * /stream-mode-test has a 300ms delayed loader with a loading() fallback.
 * - In "stream" mode: response arrives quickly (shell flushed before delay).
 * - In "allReady" mode: response waits for all Suspense boundaries (~300ms+).
 *
 * RSC (__rsc) requests are NOT affected by resolveStreaming.
 */

const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

test.describe("ssr-stream-mode", () => {
  test("stream mode: response contains loading fallback and resolved content", async ({
    request,
  }) => {
    const res = await request.get(f.url("/stream-mode-test"), {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 TestBrowser",
      },
    });
    expect(res.status()).toBe(200);
    const html = await res.text();
    // Loading fallback should be present in the HTML (flushed as part of Suspense)
    expect(html).toContain("stream-mode-loading-fallback");
    // Resolved content should also be present (streamed in after delay)
    expect(html).toContain("delayed-content-resolved");
  });

  test("allReady mode: response contains loading fallback and resolved content", async ({
    request,
  }) => {
    const start = Date.now();
    const res = await request.get(f.url("/stream-mode-test"), {
      headers: {
        Accept: "text/html",
        // StreamBot triggers allReady mode
        "User-Agent": "StreamBot/1.0",
      },
    });
    const elapsed = Date.now() - start;
    expect(res.status()).toBe(200);
    const html = await res.text();
    // Both fallback and resolved content should be present
    expect(html).toContain("delayed-content-resolved");
    // Response should have waited for the delayed content (~300ms loader)
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  test("RSC request is unaffected by resolveStreaming (bot UA still gets RSC)", async ({
    request,
  }) => {
    const res = await request.get(
      f.url("/stream-mode-test?_rsc_partial=true&_rsc_segments=root"),
      {
        headers: {
          Accept: "text/x-component",
          "User-Agent": "StreamBot/1.0",
        },
      },
    );
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    // RSC response should NOT be text/html
    expect(contentType).not.toContain("text/html");
  });
});

// Production tests
const fProd = useFixture({ root: "./e2e/test-app", mode: "build" });

test.describe("ssr-stream-mode (production)", () => {
  test("stream mode: response contains loading fallback and resolved content", async ({
    request,
  }) => {
    const res = await request.get(fProd.url("/stream-mode-test"), {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 TestBrowser",
      },
    });
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("stream-mode-loading-fallback");
    expect(html).toContain("delayed-content-resolved");
  });

  test("allReady mode: response waits for all content before flushing", async ({
    request,
  }) => {
    const start = Date.now();
    const res = await request.get(fProd.url("/stream-mode-test"), {
      headers: {
        Accept: "text/html",
        "User-Agent": "StreamBot/1.0",
      },
    });
    const elapsed = Date.now() - start;
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("delayed-content-resolved");
    // Response should have waited for the delayed content (~300ms loader)
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  test("RSC request is unaffected by resolveStreaming (bot UA still gets RSC)", async ({
    request,
  }) => {
    const res = await request.get(
      fProd.url("/stream-mode-test?_rsc_partial=true&_rsc_segments=root"),
      {
        headers: {
          Accept: "text/x-component",
          "User-Agent": "StreamBot/1.0",
        },
      },
    );
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).not.toContain("text/html");
  });
});
