# Testing cache / SWR / prerender — assertCacheStatus

**Layer:** e2e + signal · **Import:** the cache-status helpers (`assertCacheStatus`/`parseCacheHeader`/`createCacheSink`/`assertCacheDecision`/`filterCacheDecisions`) are re-exported from BOTH entries — use `@rangojs/router/testing` from a Vitest unit/integration test, and `@rangojs/router/testing/e2e` from a plain Playwright runner (the e2e barrel avoids the Vite-only virtuals the main barrel pulls in). · **DSL it tests:** `cache()` / `"use cache"` / loader cache / `Prerender(...)` (see `/caching`, `/prerender`, `/use-cache`)

The router's REAL cache pipeline runs (runtime cache, SWR revalidation, prerender lookup); you SEED nothing — you drive a request through the real fetch path and read the resulting cache decision. The decision surfaces two ways: the `X-Rango-Cache` response header (a debug gate) or a captured `cache.decision` telemetry event.

## Which path to use

Both report the SAME coarse route-level signal (keyed by the route NAME). Pick by **transport**, not by meaning:

| Path          | Helper                                                                     | Transport                                                                                       | Needs the debug gate?                             | Production surface                | Per-segment `shouldRevalidate`? |
| ------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- | ------------------------------- |
| **Header**    | `assertCacheStatus(res, routeKey, expected)` / `parseCacheHeader`          | the `X-Rango-Cache` response header — the ONLY signal a black-box Playwright `Response` carries | Yes (`debugCacheSignal` / `RANGO_TEST_SIGNALS=1`) | the header (gated off by default) | no                              |
| **Telemetry** | `assertCacheDecision(events, routeKey, expected)` / `filterCacheDecisions` | a captured `cache.decision` event off a `createCacheSink()` sink                                | No                                                | zero                              | yes (the only path exposing it) |

Use the header path when all you have is a black-box `Response` (a Playwright `APIResponse`); use the telemetry path when you can wire `createRouter({ telemetry: sink })` and want zero production surface or per-segment `shouldRevalidate`. `assertCacheDecision` is the one-call counterpart of `assertCacheStatus` (parallel `(…, routeKey, expected)` shape — captured `events` in place of a `Response`); reach for raw `filterCacheDecisions` only when you need the per-segment event fields directly.

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

// assertCacheDecision -> the one-call telemetry assert (counterpart of assertCacheStatus).
// Throws on mismatch / no matching segment / unknown routeKey; returns void.
assertCacheDecision(events: readonly TelemetryEvent[], routeKey: string, expected: ExpectedCacheStatus): void

// filterCacheDecisions -> narrow captured events to cache.decision events (raw form).
filterCacheDecisions(events: readonly TelemetryEvent[]): CacheDecisionEvent[]
```

## Recipe

```ts
// In a Playwright e2e, import from the e2e entry —
// the @rangojs/router/testing barrel pulls a build-only virtual that does not
// resolve in a plain Playwright runner.
import { expect, test } from "@playwright/test";
import { assertCacheStatus, createRangoE2E } from "@rangojs/router/testing/e2e";

const { parityDescribe } = createRangoE2E({ test, expect });

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
import {
  createCacheSink,
  assertCacheDecision,
  filterCacheDecisions,
} from "@rangojs/router/testing";

const { sink, events } = createCacheSink();
const router = createRouter({ telemetry: sink }).routes(urlpatterns);
// ...drive a request through the router's RSC fetch path...

// One-call assert (counterpart of assertCacheStatus), keyed by the route NAME:
assertCacheDecision(events, "product.detail", "stale");

// Or read the raw event when you need per-segment fields (shouldRevalidate):
const decision = filterCacheDecisions(events)[0];
expect(decision.segments?.[0].cacheStatus).toBe("stale");
expect(decision.segments?.[0].shouldRevalidate).toBe(true);
```

`events` accumulates across requests, so the FIRST matching segment for a `routeKey` wins — slice or recreate the sink between requests for the same route.

## PPR shell (`x-rango-shell`)

**DSL:** `ppr: true | PartialPrerenderProps` on a page route (see `/ppr`). **Not** the same header as `X-Rango-Cache` — shell is a second render axis.

| Helper                                    | Import                               | Role                                                                                                   |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `assertShellStatus(res, "HIT" \| "MISS")` | `@rangojs/router/testing` or `…/e2e` | Assert `x-rango-shell` on a **real document** Response                                                 |
| `parseShellStatus(res)`                   | same                                 | `"HIT" \| "MISS" \| null` (null = header absent / unrecognized)                                        |
| `shellCacheKey(url)`                      | same                                 | Production shell store key (`host+pathname+sorted search+:shell`) for `store.getShell` / custom stores |
| `SHELL_STATUS_HEADER`                     | same                                 | `"x-rango-shell"` constant                                                                             |

### What unit can prove vs e2e

| Layer    | What you assert             | How                                                                                                                                                                                              |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unit** | store family + key identity | `MemorySegmentCacheStore` + `shellCacheKey(url)` + `putShell`/`getShell` / tag eviction — dogfood in `e2e/mini/test/shell-store-family.test.ts` and `src/testing/__tests__/shell-status.test.ts` |
| **Unit** | header helper contract      | `assertShellStatus` on a Response that already carries the header (characterizes the helper; **never** invent a HIT to claim capture worked)                                                     |
| **E2E**  | live MISS → capture → HIT   | document GET, poll until `x-rango-shell: HIT` (background capture) — `e2e/shell-cache.test.ts`                                                                                                   |

`dispatch` is RSC-free: it never runs shell serve/capture. `renderHandler` only surfaces `ctx.dynamic()` opt-out, not bake/serve.

### Recipe (e2e)

```ts
import { assertShellStatus, shellCacheKey } from "@rangojs/router/testing/e2e";
// or from @rangojs/router/testing under Vitest

// Document GET (not Accept: text/x-component):
const first = await page.request.get(f.url("/products/1"));
assertShellStatus({ headers: new Headers(first.headers()) }, "MISS");
// After capture flushes (poll — background putShell):
const second = await page.request.get(f.url("/products/1"));
assertShellStatus({ headers: new Headers(second.headers()) }, "HIT");

// Custom store / unit: same key the serve path uses
const key = shellCacheKey(new URL("http://localhost/products/1"));
expect(await store.getShell(key)).not.toBeNull();
```

## Caveats

- The `X-Rango-Cache` header is emitted ONLY when the gate is on: `createRouter({ debugCacheSignal: true })` or `process.env.RANGO_TEST_SIGNALS === "1"`. Off by default — zero production surface. With the gate off, `assertCacheStatus` throws a clear "header missing" error.
- `x-rango-shell` is always set on document GETs the serve path considered for a ppr route (no debug gate). Absent header = axis-1 fall-open or non-ppr.
- v1 is COARSE: route-level, keyed by the route NAME (e.g. `product.detail`), NOT the URL pattern (`/products/:id`); not per-individual-segment. The signal is built from `ctx.routeKey`, so a pattern-shaped key never matches. (`parseCacheHeader` exposes the raw `{ routeKey: status }` map if you need it.)
- Prerender is indistinguishable from a cache hit by design — no static `.html`/`.rsc` files, the worker handles every request and looks up a stored Flight payload; the browser cannot tell. Do not assert "prerendered" from the DOM. Assert via the signal (`assertCacheStatus(res, seg, "prerendered")`) and run prerender assertions in PRODUCTION mode (the build-time artifacts only exist after `pnpm build`).
- In a Playwright e2e import the cache-status / shell-status helpers from the `/e2e` entry — the `@rangojs/router/testing` barrel is Vitest-only (it pulls a build-only virtual that does not resolve in a plain Playwright runner). Zero-prod-surface alternative for segment cache: the telemetry sink (`createCacheSink`/`filterCacheDecisions`), no header at all. Note: the non-RSC `dispatch()` primitive never emits either header — get the Response from the router's real RSC fetch path.
- Never stub a shell HIT Response in unit tests to claim the capture path works.

## See also

- `/caching`, `/prerender`, `/use-cache`, `/ppr` — the DSL this tests
- Siblings: [`./e2e-parity.md`](./e2e-parity.md), [`./response-routes.md`](./response-routes.md)
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "Cache, SWR, and prerender"
