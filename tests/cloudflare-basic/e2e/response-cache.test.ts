import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Tests response route caching via cache() boundaries with CFCacheStore.
 *
 * Strategy: every handler embeds Date.now() in the response. Two separate
 * handler invocations always produce different timestamps (>= 1ms apart).
 * If the timestamp is identical across requests, the response was served
 * from cache. A non-cached control route proves the handler *does*
 * re-execute without cache() wrapping.
 */

test.describe("response-cache (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("control: uncached route returns different timestamps", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/uncached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(typeof ts1).toBe("number");

    await new Promise((r) => setTimeout(r, 50));

    const res2 = await request.get(f.url("/test/uncached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBeGreaterThan(ts1);
  });

  test("path.json() with cache() returns identical timestamp on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-json"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/json");
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(typeof ts1).toBe("number");

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/cached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(ts1);
  });

  test("path.text() with cache() returns identical body on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-text"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/plain");
    const body1 = await res1.text();
    expect(body1).toMatch(/^text:\d+$/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/cached-text"));
    expect(res2.status()).toBe(200);

    expect(await res2.text()).toBe(body1);
  });

  test("path.xml() with cache() returns identical body on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-xml"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/xml");
    const body1 = await res1.text();
    expect(body1).toMatch(/<ts>\d+<\/ts>/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/cached-xml"));
    expect(res2.status()).toBe(200);

    expect(await res2.text()).toBe(body1);
  });

  test("path.html() with cache() returns identical body on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-html"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/html");
    const body1 = await res1.text();
    expect(body1).toMatch(/data-ts="\d+"/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/cached-html"));
    expect(res2.status()).toBe(200);

    expect(await res2.text()).toBe(body1);
  });
});

test.describe("response-cache (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("path.json() with cache() returns identical timestamp on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-json"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/json");
    const body1 = await res1.json();
    const ts1 = body1.data.ts;
    expect(typeof ts1).toBe("number");

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/cached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(ts1);
  });

  test("path.text() with cache() returns identical body on cache hit in production", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-text"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/plain");
    const body1 = await res1.text();
    expect(body1).toMatch(/^text:\d+$/);

    await new Promise((r) => setTimeout(r, 500));

    const res2 = await request.get(f.url("/test/cached-text"));
    expect(res2.status()).toBe(200);

    expect(await res2.text()).toBe(body1);
  });
});
