import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Tests that validate response route caching via cache() boundaries.
 *
 * Strategy: every handler embeds Date.now() in the response. Two separate
 * handler invocations always produce different timestamps (>= 1ms apart).
 * If the timestamp is identical across requests, the response was served
 * from cache. A non-cached control route proves the handler *does*
 * re-execute without cache() wrapping.
 */

test.describe("response-cache (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("control: uncached route returns different timestamps on each request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/uncached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(body1.data.source).toBe("uncached-json");
    expect(typeof ts1).toBe("number");

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await request.get(f.url("/response-cache/uncached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    const ts2 = body2.data.ts;

    // Without caching, each call produces a new timestamp
    expect(ts2).toBeGreaterThan(ts1);
  });

  test("path.json() with cache() returns identical timestamp on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-json"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/json");
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(body1.data.source).toBe("cached-json");
    expect(typeof ts1).toBe("number");

    // Wait for async cache write via waitUntil
    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    // Cached: timestamp must be exactly the same
    expect(body2.data.ts).toBe(ts1);
  });

  test("path.text() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-text"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/plain");
    const body1 = await res1.text();
    // Body contains embedded timestamp
    expect(body1).toMatch(/^text:\d+$/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-text"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    // Cached: exact same body including timestamp
    expect(body2).toBe(body1);
  });

  test("path.xml() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-xml"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/xml");
    const body1 = await res1.text();
    expect(body1).toMatch(/<ts>\d+<\/ts>/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-xml"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("path.html() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-html"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/html");
    const body1 = await res1.text();
    expect(body1).toMatch(/data-ts="\d+"/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-html"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("path.md() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-md"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/markdown");
    const body1 = await res1.text();
    expect(body1).toMatch(/^# ts:\d+$/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-md"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("different query strings produce separate cache entries", async ({
    request,
  }) => {
    const res1 = await request.get(
      f.url("/response-cache/cached-json-query?q=alpha"),
    );
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.source).toBe("cached-json-query");
    expect(body1.data.q).toBe("alpha");
    const ts1 = body1.data.ts;

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(
      f.url("/response-cache/cached-json-query?q=beta"),
    );
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.q).toBe("beta");

    // Different query string must produce a different cache entry
    expect(body2.data.ts).not.toBe(ts1);
  });

  test("pre-handler onResponse callback runs on both miss and hit", async ({
    request,
  }) => {
    // First request (cache miss) — pre-handler callback should set header
    const res1 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res1.status()).toBe(200);
    const preTs1 = res1.headers()["x-pre-handler-ts"];
    expect(preTs1).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));

    // Second request (cache hit) — pre-handler callback should still run
    // with a fresh timestamp (not baked into cache)
    const res2 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res2.status()).toBe(200);
    const preTs2 = res2.headers()["x-pre-handler-ts"];
    expect(preTs2).toBeTruthy();
    expect(Number(preTs2)).toBeGreaterThanOrEqual(Number(preTs1));
  });

  test("route-level onResponse callback is baked into cache, not replayed on hit", async ({
    request,
  }) => {
    // First request (cache miss) — route callback should set header
    const res1 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res1.status()).toBe(200);
    const routeTs1 = res1.headers()["x-route-callback-ts"];
    expect(routeTs1).toBeTruthy();
    const body1 = await res1.json();
    const bodyTs1 = body1.data.ts;

    await new Promise((r) => setTimeout(r, 500));

    // Second request (cache hit) — route callback header should be
    // present with the SAME value (baked into cached response, not re-run)
    const res2 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res2.status()).toBe(200);
    const routeTs2 = res2.headers()["x-route-callback-ts"];
    expect(routeTs2).toBe(routeTs1);

    // Body timestamp should also match (confirming cache hit)
    const body2 = await res2.json();
    expect(body2.data.ts).toBe(bodyTs1);
  });
});

test.describe("response-cache (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("control: uncached route returns different timestamps on each request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/uncached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(body1.data.source).toBe("uncached-json");
    expect(typeof ts1).toBe("number");

    await new Promise((r) => setTimeout(r, 50));

    const res2 = await request.get(f.url("/response-cache/uncached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    const ts2 = body2.data.ts;

    expect(ts2).toBeGreaterThan(ts1);
  });

  test("path.json() with cache() returns identical timestamp on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-json"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/json");
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(body1.data.source).toBe("cached-json");
    expect(typeof ts1).toBe("number");

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(ts1);
  });

  test("path.text() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-text"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/plain");
    const body1 = await res1.text();
    expect(body1).toMatch(/^text:\d+$/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-text"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("path.xml() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-xml"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/xml");
    const body1 = await res1.text();
    expect(body1).toMatch(/<ts>\d+<\/ts>/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-xml"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("path.html() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-html"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/html");
    const body1 = await res1.text();
    expect(body1).toMatch(/data-ts="\d+"/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-html"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("path.md() with cache() returns identical body on second request", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/response-cache/cached-md"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/markdown");
    const body1 = await res1.text();
    expect(body1).toMatch(/^# ts:\d+$/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/response-cache/cached-md"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.text();

    expect(body2).toBe(body1);
  });

  test("different query strings produce separate cache entries", async ({
    request,
  }) => {
    const res1 = await request.get(
      f.url("/response-cache/cached-json-query?q=alpha"),
    );
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.source).toBe("cached-json-query");
    expect(body1.data.q).toBe("alpha");
    const ts1 = body1.data.ts;

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(
      f.url("/response-cache/cached-json-query?q=beta"),
    );
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.q).toBe("beta");

    expect(body2.data.ts).not.toBe(ts1);
  });

  test("pre-handler onResponse callback runs on both miss and hit", async ({
    request,
  }) => {
    const res1 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res1.status()).toBe(200);
    const preTs1 = res1.headers()["x-pre-handler-ts"];
    expect(preTs1).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res2.status()).toBe(200);
    const preTs2 = res2.headers()["x-pre-handler-ts"];
    expect(preTs2).toBeTruthy();
    expect(Number(preTs2)).toBeGreaterThanOrEqual(Number(preTs1));
  });

  test("route-level onResponse callback is baked into cache, not replayed on hit", async ({
    request,
  }) => {
    const res1 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res1.status()).toBe(200);
    const routeTs1 = res1.headers()["x-route-callback-ts"];
    expect(routeTs1).toBeTruthy();
    const body1 = await res1.json();
    const bodyTs1 = body1.data.ts;

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(
      f.url("/response-cache/cb-test/with-route-cb"),
    );
    expect(res2.status()).toBe(200);
    const routeTs2 = res2.headers()["x-route-callback-ts"];
    expect(routeTs2).toBe(routeTs1);

    const body2 = await res2.json();
    expect(body2.data.ts).toBe(bodyTs1);
  });
});
