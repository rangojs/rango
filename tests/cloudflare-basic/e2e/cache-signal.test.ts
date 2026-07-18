import { expect, test, type APIResponse } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
// Import from the e2e entry, NOT the `@rangojs/router/testing` barrel: the
// barrel transitively pulls the build-only `@rangojs/router:version` virtual,
// which does not resolve in a plain Playwright (Node) runner. The e2e entry
// re-exports these pure helpers and is Playwright-safe.
import {
  assertCacheStatus,
  parseCacheHeader,
} from "@rangojs/router/testing/e2e";

// Dogfood the consumer cache-status primitives against a REAL X-Rango-Cache
// response. This closes the gap that let the docs ship a wrong, URL-pattern
// shaped key: the signal is keyed by the route NAME (slowCache), not the
// pattern (/slow-cache). The app under test enables `debugCacheSignal` so the
// header is present (see src/router.tsx).
//
// /slow-cache is a single component route wrapped in cache({ ttl: 2, swr: 300 }),
// so its segment cache status appears in X-Rango-Cache. A unique query forces a
// cold cache key per invocation (retry-safe), so the first request is a
// guaranteed miss and the second, within the TTL, a hit.

const CACHED_ROUTE = "/slow-cache";
const ROUTE_NAME = "slowCache";

// assertCacheStatus accepts a Response or `{ headers: Headers }`; Playwright's
// APIResponse exposes headers as a plain record, so wrap it in a Headers
// (case-insensitive, so the helper's `.get("X-Rango-Cache")` resolves it).
function target(res: APIResponse): { headers: Headers } {
  return { headers: new Headers(res.headers()) };
}

async function generation(res: APIResponse): Promise<number> {
  const match = /cache-generation:(\d+)/u.exec(await res.text());
  expect(match, "Flight response contains the cache generation").toBeTruthy();
  return Number(match![1]);
}

function runCacheSignalSpec(f: Fixture): void {
  test("assertCacheStatus validates a real X-Rango-Cache response (route-name key, miss -> hit)", async ({
    page,
  }) => {
    // The miss -> hit signal is a flight-transport contract: HTML document
    // requests re-render (miss) on every fetch regardless of the store. */*
    // used to negotiate to flight implicitly; flight is now explicit opt-in,
    // so pin the transport with the wire-format Accept.
    const flightHeaders = { Accept: "text/x-component" };
    let probe = "";
    let url = "";
    let res1!: APIResponse;
    let res2!: APIResponse;
    await expect(async () => {
      // Abandon a probe if its asynchronous first write has not landed yet.
      // Retrying the same cold key would start another render and make the
      // generation count measure test retries instead of SWR ownership.
      probe = `sig-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      url = f.url(`${CACHED_ROUTE}?probe=${probe}`);
      res1 = await page.request.get(url, { headers: flightHeaders });
      res2 = await page.request.get(url, { headers: flightHeaders });
      assertCacheStatus(target(res2), ROUTE_NAME, "hit");
    }).toPass({ timeout: 15_000 });

    const h1 = res1.headers()["x-rango-cache"];
    const h2 = res2.headers()["x-rango-cache"];
    console.log(`X-Rango-Cache #1: ${h1}`);
    console.log(`X-Rango-Cache #2: ${h2}`);

    // The gate must be enabled for the header to exist at all.
    expect(
      h1,
      "X-Rango-Cache missing — is debugCacheSignal enabled on the router?",
    ).toBeTruthy();

    // The key is the route NAME, not the URL pattern — the contract the docs fixed.
    const parsed = parseCacheHeader(h1);
    expect(parsed).toHaveProperty(ROUTE_NAME);
    expect(parsed).not.toHaveProperty(CACHED_ROUTE);

    // The full contract: a cold key misses, the repeat hits.
    assertCacheStatus(target(res1), ROUTE_NAME, "miss");
    const initialGeneration = await generation(res2);

    // Every reader sees stale freshness. Ownership is separate: only one
    // background render may produce the next generation.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const [staleOwner, guardedStaleReader] = await Promise.all([
      page.request.get(url, { headers: flightHeaders }),
      page.request.get(url, { headers: flightHeaders }),
    ]);
    assertCacheStatus(target(staleOwner), ROUTE_NAME, "stale");
    assertCacheStatus(target(guardedStaleReader), ROUTE_NAME, "stale");
    expect(await generation(staleOwner)).toBe(initialGeneration);
    expect(await generation(guardedStaleReader)).toBe(initialGeneration);

    const probeStatus = async () => {
      const response = await page.request.get(
        f.url(`/__test/slow-cache/${probe}`),
      );
      return (await response.json()) as {
        generation: number;
      };
    };
    await expect
      .poll(async () => (await probeStatus()).generation - initialGeneration, {
        timeout: 15_000,
      })
      .toBe(1);
    await expect
      .poll(
        async () => {
          const refreshed = await page.request.get(url, {
            headers: flightHeaders,
          });
          return generation(refreshed);
        },
        { timeout: 15_000 },
      )
      .toBe(initialGeneration + 1);
    expect((await probeStatus()).generation - initialGeneration).toBe(1);

    // The wrong (pattern-shaped) key must NOT resolve — so a consumer copying
    // the URL pattern gets a clear failure, not a silent miss.
    expect(() => assertCacheStatus(target(res2), CACHED_ROUTE, "hit")).toThrow(
      /not found/,
    );
  });
}

test.describe("cache-signal / assertCacheStatus (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runCacheSignalSpec(f);
});

test.describe("cache-signal / assertCacheStatus (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runCacheSignalSpec(f);
});
