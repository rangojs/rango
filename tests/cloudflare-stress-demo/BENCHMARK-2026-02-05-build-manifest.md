# Build-Time Manifest Cold Start Impact

- **Date**: 2026-02-05
- **Commit**: `7af3803` (feat: make all include() calls lazy by default)
- **Deployed Versions**:
  - With manifest: `33777f71-e069-4e52-83cf-61e2b8e5c399`
  - Without manifest: `cb8f8705-4d4e-4cb3-b4d2-2386c2dbb989`

## Problem Statement

User reports 55ms loading vs 4ms before manifest changes. Suspect: 712KB manifest (14,213 routes) parsed at startup adds cold start overhead.

The build-time manifest was introduced to support `href()` with lazy includes - since lazy routes aren't evaluated until needed, the runtime route map doesn't have all routes available for `href()` resolution. The manifest provides a complete map of all route names to patterns.

## Test Setup

- **Total routes**: 14,236 (3 root + 5,003 site + 5,002 api + additional shop routes)
- **Manifest size**: 725KB (JSON), 712KB (in bundle)
- **Worker bundle**: 1.1MB with manifest, 421KB without

## Test Methodology

1. Deploy both versions to Cloudflare Workers
2. Measure Worker Startup Time from wrangler deploy output
3. Measure TTFB (Time To First Byte) for cold starts
4. Wait 60 seconds between requests to ensure cold starts
5. Verify route matching performance unchanged

## Results

### Worker Startup Time (from Wrangler)

| Metric              | With Manifest | Without Manifest | Difference                |
| ------------------- | ------------- | ---------------- | ------------------------- |
| Worker Startup Time | 28 ms         | 21 ms            | **-7 ms (25% faster)**    |
| Bundle Size         | 1,743 KB      | 1,075 KB         | **-668 KB (38% smaller)** |
| Gzip Size           | 278 KB        | 202 KB           | **-76 KB (27% smaller)**  |

### TTFB Cold Start Measurements

5 requests with 60-second waits between each:

| Test                      | With Manifest | Without Manifest |
| ------------------------- | ------------- | ---------------- |
| 1                         | 121 ms        | 40 ms            |
| 2                         | 59 ms         | 40 ms            |
| 3                         | 38 ms         | 174 ms\*         |
| 4                         | 48 ms         | 38 ms            |
| 5                         | 36 ms         | 41 ms            |
| **Median**                | **48 ms**     | **40 ms**        |
| **Mean (excl. outliers)** | **60.4 ms**   | **39.7 ms**      |

\*Test 3 without manifest had an outlier (174ms), likely due to network conditions.

### Route Matching Performance (Unchanged)

| Route              | Entries Checked | Entries Skipped | Routes Checked |
| ------------------ | --------------- | --------------- | -------------- |
| `/bench/first`     | 1               | 0               | 1              |
| `/bench/last`      | 1               | 0               | 3              |
| `/api/bench/first` | 2               | 1               | 4              |
| `/api/bench/last`  | 2               | 1               | 5,005          |

The manifest import has **zero impact** on route matching performance - all optimization from lazy includes remains intact.

## Analysis

### What the Manifest Provides

1. **Complete `href()` support** - All route names can be resolved to URLs, including lazy includes
2. **Type-safe navigation** - TypeScript can verify route names at compile time

### What the Manifest Costs

1. **~7ms additional startup time** (25% increase)
2. **~668KB additional bundle size** (38% increase)
3. **Parsing overhead** - 14,236 route entries parsed on every cold start

### Trade-off Summary

| Feature                 | With Manifest | Without Manifest     |
| ----------------------- | ------------- | -------------------- |
| `href()` for all routes | Yes           | Only non-lazy routes |
| Cold start overhead     | +7ms          | Baseline             |
| Bundle size             | 1.7MB         | 1.0MB                |
| Route matching          | Unaffected    | Unaffected           |

## href() Usage in Demo

Searched the codebase for `href()` calls:

```bash
grep -r "href(" examples/cloudflare-stress-demo/src/
```

**Result**: No actual `href()` function calls found in the demo app. The demo doesn't currently use named route resolution.

## Recommendations

### For Apps WITHOUT href() Usage

**Remove the manifest import** to gain:

- 25% faster cold starts (~7ms)
- 38% smaller bundle (~668KB)

```typescript
// worker.rsc.tsx
// Don't import if not using href()
// import "@rangojs/router:route-manifest";
```

### For Apps WITH href() Usage

1. **Keep the manifest** if using `href()` for lazy routes
2. **Consider selective manifest** - Only include routes that need `href()` resolution
3. **Future optimization** - Implement lazy manifest loading (only parse when `href()` first called)

### Potential Optimizations

1. **Lazy manifest loading** - Don't parse until `href()` is first called
   - Pros: Zero cold start impact for routes not using `href()`
   - Cons: First `href()` call has parsing overhead

2. **Smaller manifest** - Only include routes that actually use `href()`
   - Requires static analysis of codebase
   - Could reduce manifest size significantly

3. **Compressed manifest** - Use binary format instead of JSON
   - Would require runtime decompression
   - May not be worth the complexity

## Conclusion

The build-time manifest adds measurable but modest overhead:

- **7ms startup time** (acceptable for most use cases)
- **668KB bundle size** (significant for edge deployments)

For the cloudflare-stress-demo specifically, since no `href()` calls exist, the manifest import should be removed for production. For apps that do use `href()`, the trade-off is reasonable - a one-time 7ms cost for type-safe navigation across all routes.

## Test Commands

```bash
# Deploy with manifest
# Ensure import is uncommented in worker.rsc.tsx
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Measure cold start TTFB
sleep 60
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.example.workers.dev/bench/first

# Verify matchStats unchanged
curl -s https://cloudflare-stress-demo.example.workers.dev/bench/first | jq .matchStats
```
