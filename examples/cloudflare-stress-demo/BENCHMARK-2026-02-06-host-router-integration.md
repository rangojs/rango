# Host Router Integration into @rangojs/router

- **Date**: 2026-02-06
- **Commit**: Uncommitted (on `research/pre-rendering`)
- **Published Version**: `@rangojs/router@0.0.0-experimental.8`
- **Deployed Version**: `1f4b56c1-e546-442b-a058-50e944cb6b8d`

## Problem Statement

The build-time router discovery plugin imports the worker entry and reads
`RouterRegistry` to generate route manifests. In apps using `createHostRouter`
from the separate `host-router` package, lazy `.map(() => import(...))` callbacks
never execute during module evaluation, so sub-app `createRouter()` calls never
fire and `RouterRegistry` stays empty. Build fails with no routers found.

## Solution

Moved `host-router` source into `@rangojs/router/host`. Added a
`HostRouterRegistry` that stores lazy handler references. The discovery plugin
checks this registry when `RouterRegistry` is empty, executes lazy handlers to
load sub-app modules (triggering their `createRouter()` calls), then generates
manifests as normal.

Additionally:
- Added `esbuild: { jsx: "automatic" }` to the temp discovery server so
  sub-app `.tsx` files with JSX compile correctly without `import React`.
- Build now throws (instead of warning) when no routers are found, preventing
  silent failures.

### Discovery flow:
1. Plugin imports entry -> `createHostRouter()` registers in `HostRouterRegistry`
2. Plugin checks `RouterRegistry` -> empty
3. Plugin checks `HostRouterRegistry` -> finds routes with lazy handlers
4. Plugin awaits each lazy handler -> loads sub-app module -> `createRouter()` populates `RouterRegistry`
5. Plugin reads `RouterRegistry` -> generates manifests (existing logic)

## Test Setup

- **Total routes**: 14,214 (4 root + 5,003 site + 5,002 api + 4,205 shop)
- **Manifest size**: ~684KB (in worker bundle)
- **Worker bundle**: 1,772 KB total
- **Gzip size**: 285 KB
- **Worker Startup Time**: 15ms

## Results

### Deploy Output

```
Worker Startup Time: 15 ms
Total Upload: 1772.49 KiB / gzip: 285.16 KiB
```

### Route Matching (matchStats)

| Route | Entries Checked | Entries Skipped | Routes Checked |
|-------|-----------------|-----------------|----------------|
| `/bench/first` | 1 | 5 | 1 |
| `/bench/last` | 1 | 5 | 4 |
| `/api/bench/first` | 1 | 1 | 1 |
| `/api/bench/last` | 1 | 1 | 5,002 |
| `/site/en/bench/first` | 1 | 0 | 2 |
| `/site/en/bench/last` | 1 | 0 | 9,003 |

### href() Verification

Root route handler calls `ctx.href("api.benchFirst")` to test cross-include
resolution. Response includes `"testHref": "/api/bench/first"` confirming
the build-time manifest enables `href()` for routes in unevaluated lazy includes.

### TTFB (warm, 5 runs)

| Route | Min | Median | Max |
|-------|-----|--------|-----|
| `/bench/first` | 23ms | 34ms | 39ms |
| `/api/bench/first` | 60ms | 65ms | 103ms |
| `/api/bench/last` | 51ms | 72ms | 177ms |
| `/site/en/bench/first` | 70ms | 92ms | 100ms |
| `/site/en/bench/last` | 92ms | 103ms | 379ms |

## Comparison with Previous Benchmark (build-time-discovery)

| Metric | Previous (discovery only) | Current (host-router integration) |
|--------|--------------------------|-----------------------------------|
| Worker Startup Time | 19ms | 15ms |
| Bundle size | 1,772 KB | 1,772 KB |
| Gzip | 285 KB | 285 KB |
| `/bench/first` TTFB (median) | 36ms | 34ms |
| `/api/bench/first` TTFB (median) | 80ms | 65ms |
| `/api/bench/last` TTFB (median) | 89ms | 72ms |
| `/site/en/bench/first` TTFB (median) | 118ms | 92ms |
| `/site/en/bench/last` TTFB (median) | 139ms | 103ms |

Notes:
- TTFB variance is normal for Cloudflare Workers (cold starts, network jitter).
- matchStats are identical - no routing logic changed.
- Bundle size unchanged - the stress demo doesn't use host-router itself; it
  tests the same `@rangojs/router` core with the discovery plugin improvements.

## Key Changes in @rangojs/router

| File | Change |
|------|--------|
| `src/host/*.ts` (8 files) | New: host-router moved into package |
| `src/host/router.ts` | Added `HostRouterRegistry` global map |
| `src/host/index.ts` | Exports `HostRouterRegistry` |
| `src/vite/index.ts` | Discovery resolves host router lazy handlers |
| `src/vite/index.ts` | Temp server uses `esbuild: { jsx: "automatic" }` |
| `src/vite/index.ts` | Build throws on no routers (instead of warning) |
| `package.json` | Added `./host` and `./host/testing` exports |

## rsc-cloudflare-app Verification

The `rsc-cloudflare-app` (multi-app host router setup) also builds and deploys
successfully with the new `@rangojs/router/host` import:

```
[rsc-router] Found 1 host router(s), resolving lazy handlers...
[rsc-router] Router "router_0" -> 1 routes (1 static, 0 dynamic)
[rsc-router] Router "router_1" -> 6 routes (6 static, 0 dynamic)
Worker Startup Time: 16 ms
```

## Test Commands

```bash
# Build and deploy stress demo
cd examples/cloudflare-stress-demo
pnpm build && CLOUDFLARE_ACCOUNT_ID=cb33eb5e7ce19c6b29f3cd6e66c99c06 npx wrangler deploy

# Verify href() works from build-time manifest
curl -s -H "Accept: application/json" \
  https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .testHref

# Collect matchStats
curl -s -H "Accept: application/json" \
  https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .matchStats
curl -s -H "Accept: application/json" \
  https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last | jq .matchStats

# Measure TTFB (5 runs)
for i in {1..5}; do
  curl -w "%{time_starttransfer}\n" -so /dev/null -H "Accept: application/json" \
    https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last
done
```
