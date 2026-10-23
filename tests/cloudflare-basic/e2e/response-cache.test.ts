import {
  type APIRequestContext,
  type APIResponse,
  expect,
  test,
} from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * Tests response route caching via cache() boundaries with CFCacheStore.
 *
 * Strategy: every handler embeds Date.now() in the response. Two separate
 * handler invocations always produce different timestamps (>= 1ms apart).
 * If the timestamp is identical across requests, the response was served
 * from cache. A non-cached control route proves the handler *does*
 * re-execute without cache() wrapping.
 */

/**
 * Polls GET `url` until `read` returns `expected`. A miss writes the cache in
 * waitUntil, after its response, so the next GET can still miss.
 */
async function expectCacheHit<T>(
  request: APIRequestContext,
  url: string,
  read: (res: APIResponse) => Promise<T>,
  expected: T,
): Promise<void> {
  await expect(async () => {
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(await read(res)).toBe(expected);
  }).toPass({ timeout: 10_000 });
}

const readTs = async (res: APIResponse): Promise<number> =>
  (await res.json()).ts;
const readText = (res: APIResponse): Promise<string> => res.text();

function responseCacheSuite(f: Fixture) {
  test("control: uncached route returns different timestamps", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/uncached-json"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const ts1 = body1.ts;
    expect(typeof ts1).toBe("number");

    await new Promise((r) => setTimeout(r, 50));

    const res2 = await request.get(f.url("/test/uncached-json"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.ts).toBeGreaterThan(ts1);
  });

  test("path.json() with cache() returns identical timestamp on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-json"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/json");
    const body1 = await res1.json();
    const ts1 = body1.ts;
    expect(typeof ts1).toBe("number");

    await expectCacheHit(request, f.url("/test/cached-json"), readTs, ts1);
  });

  test("path.text() with cache() returns identical body on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-text"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/plain");
    const body1 = await res1.text();
    expect(body1).toMatch(/^text:\d+$/);

    await expectCacheHit(request, f.url("/test/cached-text"), readText, body1);
  });

  test("path.xml() with cache() returns identical body on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-xml"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("application/xml");
    const body1 = await res1.text();
    expect(body1).toMatch(/<ts>\d+<\/ts>/);

    await expectCacheHit(request, f.url("/test/cached-xml"), readText, body1);
  });

  test("path.html() with cache() returns identical body on cache hit", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/test/cached-html"));
    expect(res1.status()).toBe(200);
    expect(res1.headers()["content-type"]).toContain("text/html");
    const body1 = await res1.text();
    expect(body1).toMatch(/data-ts="\d+"/);

    await expectCacheHit(request, f.url("/test/cached-html"), readText, body1);
  });

  test("POST does not write or hit the response-route cache", async ({
    request,
  }) => {
    const url = f.url("/test/cached-json");
    const res1 = await request.post(url);
    expect(res1.status()).toBe(200);
    const ts1 = (await res1.json()).ts;
    await new Promise((r) => setTimeout(r, 50));
    const res2 = await request.post(url);
    expect(res2.status()).toBe(200);
    expect((await res2.json()).ts).toBeGreaterThan(ts1);
  });

  test("HEAD does not poison a subsequent GET cache entry", async ({
    request,
  }) => {
    // Per-run key: a retry or a reused server starts cold, so the HEAD runs
    // before any GET of this entry.
    const url = f.url(
      `/test/cached-json-query?q=head-isolate-${crypto.randomUUID()}`,
    );
    const head = await request.fetch(url, { method: "HEAD" });
    expect(head.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const get1 = await request.get(url);
    const ts1 = (await get1.json()).ts;
    await expectCacheHit(request, url, readTs, ts1);
  });

  test("Set-Cookie response is live but not shared on a later GET", async ({
    request,
  }) => {
    const url = f.url("/test/cached-cookie");
    const res1 = await request.get(url);
    expect(res1.status()).toBe(200);
    expect(
      res1
        .headersArray()
        .some(
          (h) =>
            h.name.toLowerCase() === "set-cookie" &&
            h.value.startsWith("session=tok"),
        ),
    ).toBe(true);
    const ts1 = (await res1.json()).ts;
    await new Promise((r) => setTimeout(r, 200));
    const res2 = await request.get(url);
    expect((await res2.json()).ts).toBeGreaterThan(ts1);
  });
}

test.describe("response-cache (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  responseCacheSuite(f);
});

test.describe("response-cache (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  responseCacheSuite(f);
});
