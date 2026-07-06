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
// /slow-cache is a single component route wrapped in cache({ ttl: 60, swr: 300 }),
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

function runCacheSignalSpec(f: Fixture): void {
  test("assertCacheStatus validates a real X-Rango-Cache response (route-name key, miss -> hit)", async ({
    page,
  }) => {
    const probe = `sig-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const url = f.url(`${CACHED_ROUTE}?probe=${probe}`);

    // The miss -> hit signal is a flight-transport contract: HTML document
    // requests re-render (miss) on every fetch regardless of the store. */*
    // used to negotiate to flight implicitly; flight is now explicit opt-in,
    // so pin the transport with the wire-format Accept.
    const flightHeaders = { Accept: "text/x-component" };
    const res1 = await page.request.get(url, { headers: flightHeaders }); // cold key -> miss (renders)
    const res2 = await page.request.get(url, { headers: flightHeaders }); // same key -> hit (cached)

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
    assertCacheStatus(target(res2), ROUTE_NAME, "hit");

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
