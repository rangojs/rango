import test, { expect } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * SSR stream-mode e2e tests.
 *
 * The test-app router configures ssr.resolveStreaming to return "allReady"
 * when the User-Agent contains "StreamBot", and "stream" otherwise.
 *
 * /stream-mode-test has a 500ms delayed loader with a loading() fallback.
 * - In "stream" mode: first chunk arrives quickly (shell flushed before delay).
 * - In "allReady" mode: first chunk waits for all Suspense boundaries (~500ms+).
 *
 * We use native fetch with manual chunk reading to measure time-to-first-byte,
 * since Playwright's request API buffers the full response.
 *
 * RSC (__rsc) requests are NOT affected by resolveStreaming.
 */

/**
 * Measure time to first chunk using native fetch + ReadableStream reader.
 */
async function measureFirstChunk(
  url: string,
  ua: string,
): Promise<{ ttfb: number; html: string }> {
  const start = Date.now();
  const res = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": ua,
    },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  const first = await reader.read();
  const ttfb = Date.now() - start;
  if (first.value) chunks.push(decoder.decode(first.value, { stream: true }));

  // Read remaining chunks
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());

  return { ttfb, html: chunks.join("") };
}

const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

test.describe("ssr-stream-mode", () => {
  test("stream mode flushes first chunk before allReady mode", async () => {
    // Stream mode: shell should flush before the 500ms loader completes
    const stream = await measureFirstChunk(
      f.url("/stream-mode-test"),
      "Mozilla/5.0 TestBrowser",
    );

    // allReady mode: first chunk should wait for the 500ms loader
    const allReady = await measureFirstChunk(
      f.url("/stream-mode-test"),
      "StreamBot/1.0",
    );

    // Both should contain the resolved content in the full response
    expect(stream.html).toContain("delayed-content-resolved");
    expect(allReady.html).toContain("delayed-content-resolved");

    // Stream mode should flush the shell (with fallback) before the delay
    expect(stream.html).toContain("stream-mode-loading-fallback");

    // The key assertion: allReady TTFB should be meaningfully slower
    // because it waits for all Suspense boundaries (500ms loader).
    // Stream mode flushes the shell immediately.
    expect(allReady.ttfb).toBeGreaterThanOrEqual(400);
    expect(allReady.ttfb).toBeGreaterThan(stream.ttfb * 2);
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
    expect(contentType).not.toContain("text/html");
  });
});

// Production tests
const fProd = useFixture({ root: "./e2e/test-app", mode: "build" });

test.describe("ssr-stream-mode (production)", () => {
  test("stream mode flushes first chunk before allReady mode", async () => {
    const stream = await measureFirstChunk(
      fProd.url("/stream-mode-test"),
      "Mozilla/5.0 TestBrowser",
    );

    const allReady = await measureFirstChunk(
      fProd.url("/stream-mode-test"),
      "StreamBot/1.0",
    );

    expect(stream.html).toContain("delayed-content-resolved");
    expect(allReady.html).toContain("delayed-content-resolved");
    expect(stream.html).toContain("stream-mode-loading-fallback");

    expect(allReady.ttfb).toBeGreaterThanOrEqual(400);
    expect(allReady.ttfb).toBeGreaterThan(stream.ttfb * 2);
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
