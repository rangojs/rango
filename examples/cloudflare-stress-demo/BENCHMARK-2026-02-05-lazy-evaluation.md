# Lazy Include Evaluation

- **Date**: 2026-02-05
- **Branch**: `feat/lazy-include-evaluation`
- **Deployed Version**: `b247bd6c-57c5-490b-9198-3ae214c19f46`

## Problem Statement

With 10,000+ routes, even with prefix-based short-circuit optimization, cold start performance was impacted because all route patterns were evaluated at router creation time. This affected:

1. Cold start latency (all patterns parsed upfront)
2. Memory usage (all route definitions in memory)
3. Requests to root routes still had to check include entries

## Solution

Make all `include()` calls lazy by default. Patterns inside an include are NOT evaluated until a request matches that prefix.

Key changes:
1. Remove `lazy` option from `include()` - all includes are now always lazy
2. Lazy includes store patterns and context, evaluated on first matching request
3. Remove top-level manifest cache (incompatible with lazy evaluation)
4. Build-time manifest generation for `href()` support (via virtual module)

## Architecture

1. **Build-time manifest** (`generateManifest()`):
   - `routeManifest`: Complete route names → patterns for `href()`
   - `prefixTree`: Nested include structure for routing optimization

2. **Runtime**:
   - Lazy include evaluation (only when prefix matches)
   - No top-level caching (cache would be incomplete)

3. **Virtual module** (`virtual:rangojs-route-manifest`):
   - Exports build-time manifest for apps

## Results

### Root Routes (Skip ALL includes - lazy not evaluated)

| Route | Entries Checked | Entries Skipped | Routes Checked |
|-------|-----------------|-----------------|----------------|
| `/bench/first` | 1 | 0 | 1 |
| `/bench/last` | 1 | 0 | 3 |

**Key insight**: Root routes only check 1-3 routes. All lazy includes (`/api`, `/site`, `/shop`) are completely skipped because their patterns are never evaluated.

### API Routes (Evaluates /api include only)

| Route | Entries Checked | Entries Skipped | Routes Checked |
|-------|-----------------|-----------------|----------------|
| `/api/bench/first` | 2 | 1 | 4 |
| `/api/bench/last` | 2 | 1 | 5005 |

**Key insight**: Only `/api` include is evaluated. `/site` include is skipped (1 entry skipped).

### Site Routes (Evaluates /site include)

| Route | Entries Checked | Entries Skipped | Routes Checked |
|-------|-----------------|-----------------|----------------|
| `/site/en/bench/first` | 2 | 0 | 5 |
| `/site/en/bench/last` | 2 | 0 | 9006 |

## Comparison with Previous Benchmarks

| Scenario | Before (Eager) | After (Lazy) | Improvement |
|----------|---------------|--------------|-------------|
| `/bench/last` routes checked | ~10,008 | 3 | **99.97%** |
| `/api/bench/first` routes checked | ~5,008 | 4 | **99.92%** |

## Files Changed

- `packages/rangojs-router/src/urls.ts` - Remove `lazy` option, all includes lazy
- `packages/rangojs-router/src/router/manifest.ts` - Remove top-level cache
- `packages/rangojs-router/src/__tests__/urls.test.tsx` - Update tests for lazy behavior
- `examples/cloudflare-stress-demo/src/urls.tsx` - Remove explicit `lazy` option

## Test Commands

```bash
# Deploy
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Test root routes (should skip all includes)
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .matchStats
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/last | jq .matchStats

# Test API routes (only evaluates /api include)
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first | jq .matchStats
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last | jq .matchStats
```
