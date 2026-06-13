# Testing cache / SWR / prerender — assertCacheStatus

**Layer:** e2e + signal · **Import:** the cache-status helpers (`assertCacheStatus`/`parseCacheHeader`/`createCacheSink`/`filterCacheDecisions`) are re-exported from BOTH entries — use `@rangojs/router/testing` from a Vitest unit/integration test, and `@rangojs/router/testing/e2e` from a plain Playwright runner (the e2e barrel avoids the Vite-only virtuals the main barrel pulls in). · **DSL it tests:** `cache()` / `"use cache"` / loader cache / `Prerender(...)` (see `/caching`, `/prerender`, `/use-cache`)

The router's REAL cache pipeline runs (runtime cache, SWR revalidation, prerender lookup); you SEED nothing — you drive a request through the real fetch path and read the resulting cache decision. The decision surfaces two ways: the `X-Rango-Cache` response header (a debug gate) or a captured `cache.decision` telemetry event.

## API

### Options — `assertCacheStatus(target, segment, expected)`

| Field      | Type                                                                                                          | Meaning                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`   | `Response \| { headers: Headers }` (`CacheStatusTarget`)                                                      | The thing carrying the `X-Rango-Cache` header: a `Response` from `router.fetch(...)`, or any `{ headers: Headers }`. A Playwright `APIResponse` exposes headers as a method, so wrap it: `{ headers: new Headers(res.headers()) }`. |
| `segment`  | `string`                                                                                                      | The route NAME (e.g. `product.detail`), the same id the header carries — NOT the URL pattern (`/products/:id`).                                                                                                                     |
| `expected` | `"hit" \| "miss" \| "stale" \| "prerendered" \| "passthrough"` (`ExpectedCacheStatus` = `CacheSegmentStatus`) | The cache status you assert for that route.                                                                                                                                                                                         |

### Context — what your code under test emits

The header / event is produced by the router's RSC render pipeline from `ctx.routeKey`. Your code does not call these helpers — it just runs under a router with the gate (or telemetry sink) wired. The helpers READ the emitted signal.

| Field                                 | Type                    | Meaning                                                                                    |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `CacheSegmentSignal.id`               | `string`                | Segment id. v1: the route key, since status is route-level.                                |
| `CacheSegmentSignal.type`             | `string`                | Segment type. v1: `"route"` for the coarse route-level entry.                              |
| `CacheSegmentSignal.cacheStatus`      | `CacheSegmentStatus`    | Resolved status (`hit`/`miss`/`stale`/`prerendered`/`passthrough`).                        |
| `CacheSegmentSignal.shouldRevalidate` | `boolean?`              | Whether stale-while-revalidate was triggered for this segment.                             |
| `CacheDecisionEvent.segments`         | `CacheSegmentSignal[]?` | The coarse route-level signal array (present only when telemetry or the debug gate is on). |

### Returns

```ts
// assertCacheStatus throws on mismatch / missing header / unknown segment; returns void.
assertCacheStatus(target, segment, expected): void

// parseCacheHeader -> the raw { routeKey: status } map. "a=hit, b=stale" -> { a: "hit", b: "stale" }.
parseCacheHeader(headerValue: string | null | undefined): Record<string, string>

// createCacheSink -> a sink to wire via createRouter({ telemetry: sink }), plus the array it records into.
createCacheSink(): { sink: TelemetrySink; events: TelemetryEvent[] }

// filterCacheDecisions -> narrow captured events to cache.decision events.
filterCacheDecisions(events: readonly TelemetryEvent[]): CacheDecisionEvent[]
```

## Recipe

```ts
// In a Playwright e2e, import the cache-status helpers from the e2e entry —
// the @rangojs/router/testing barrel pulls a build-only virtual that does not
// resolve in a plain Playwright runner.
import { assertCacheStatus } from "@rangojs/router/testing/e2e";

parityDescribe("product page caches", (f) => {
  test("second request is a hit", async ({ page }) => {
    // The key is the route NAME (the X-Rango-Cache id), NOT the URL pattern.
    // Playwright APIResponse.headers() is a method returning a plain record, so
    // wrap it in a Headers to match CacheStatusTarget (`{ headers: Headers }`).
    const first = await page.request.get(f.url("/products/1"));
    assertCacheStatus(
      { headers: new Headers(first.headers()) },
      "product.detail",
      "miss",
    );
    const second = await page.request.get(f.url("/products/1"));
    assertCacheStatus(
      { headers: new Headers(second.headers()) },
      "product.detail",
      "hit",
    );
  });
});
```

Zero-prod-surface alternative — the telemetry sink. No header at all; you inspect captured `cache.decision` events:

```ts
import { createCacheSink, filterCacheDecisions } from "@rangojs/router/testing";

const { sink, events } = createCacheSink();
const router = createRouter({ telemetry: sink }).routes(urlpatterns);
// ...drive a request through the router's RSC fetch path...
const decision = filterCacheDecisions(events)[0];
expect(decision.segments?.[0].cacheStatus).toBe("stale");
expect(decision.segments?.[0].shouldRevalidate).toBe(true);
```

## Caveats

- The `X-Rango-Cache` header is emitted ONLY when the gate is on: `createRouter({ debugCacheSignal: true })` or `process.env.RANGO_TEST_SIGNALS === "1"`. Off by default — zero production surface. With the gate off, `assertCacheStatus` throws a clear "header missing" error.
- v1 is COARSE: route-level, keyed by the route NAME (e.g. `product.detail`), NOT the URL pattern (`/products/:id`); not per-individual-segment. The signal is built from `ctx.routeKey`, so a pattern-shaped key never matches. (`parseCacheHeader` exposes the raw `{ routeKey: status }` map if you need it.)
- Prerender is indistinguishable from a cache hit by design — no static `.html`/`.rsc` files, the worker handles every request and looks up a stored Flight payload; the browser cannot tell. Do not assert "prerendered" from the DOM. Assert via the signal (`assertCacheStatus(res, seg, "prerendered")`) and run prerender assertions in PRODUCTION mode (the build-time artifacts only exist after `pnpm build`).
- In a Playwright e2e import the cache-status helpers from the `/e2e` entry — the `@rangojs/router/testing` barrel is Vitest-only (it pulls a build-only virtual that does not resolve in a plain Playwright runner). Zero-prod-surface alternative: the telemetry sink (`createCacheSink`/`filterCacheDecisions`), no header at all. Note: the non-RSC `dispatch()` primitive never emits this header — get the Response from the router's real RSC fetch path.

## See also

- `/caching`, `/prerender`, `/use-cache` — the DSL this tests
- Siblings: [`./e2e-parity.md`](./e2e-parity.md), [`./response-routes.md`](./response-routes.md)
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "Cache, SWR, and prerender"
