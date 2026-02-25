# Route Matching Benchmark Results

Benchmark of @rangojs/router with 14,000+ routes on Cloudflare Workers.

- **Date**: 2026-02-04
- **Commit**: `ea2cfc7c8ad5e346f053d2feab21bfa66ee28077`

## Test Setup

- **Routes**: ~14,000 total
  - 1,000 param routes (`/:locale/user{n}/:id`)
  - 1,000 optional param routes (`/:locale/post{n}/:id?`)
  - 1,000 multi-param routes (`/:locale/org{n}/:orgId/repo/:repoId`)
  - 2,000 flat routes (`/:locale/flat/{n}`)
  - 4,000 nested layout routes (4 levels × 1,000 each)
  - 5,000 API routes via include()

- **Environment**: Cloudflare Workers

## Results

### Route Matching Time (TTFB)

| Route Position                  | TTFB (warm)   | Notes                       |
| ------------------------------- | ------------- | --------------------------- |
| First route (`/en/bench/first`) | ~50ms         | Route near beginning        |
| Last route (`/en/bench/last`)   | ~150ms        | Route after 9,000+ patterns |
| **Difference**                  | **~68-100ms** | Actual route matching cost  |

### Cold Boot

| Metric                          | Time      |
| ------------------------------- | --------- |
| Worker Startup Time             | 98ms      |
| Cold boot (manifest not loaded) | ~500ms    |
| Warm request                    | ~50-150ms |

### Per-Route Cost

- **~5-7 microseconds per route** for matching
- Scales linearly with route count

## Key Findings

1. **Cloudflare time freezing**: `Date.now()` and `performance.now()` return frozen values within a request. Only TTFB (Time To First Byte) shows real timing.

2. **Route position matters**: Routes defined later in the pattern list take longer to match.

3. **Cold boot is significant**: First request after deployment takes ~500ms due to manifest loading.

4. **RSC serialization adds overhead**: The route map (14,000 entries) adds ~40ms to RSC responses.

## Test URLs

```
# Benchmark routes (raw JSON response, no RSC)
https://cloudflare-stress-demo.devcorner.workers.dev/en/bench/first
https://cloudflare-stress-demo.devcorner.workers.dev/en/bench/last

# RSC routes
https://cloudflare-stress-demo.devcorner.workers.dev/en/user1/test
https://cloudflare-stress-demo.devcorner.workers.dev/en/l4/1000/type/123
```

## Recommendations

1. For apps with 1,000-5,000 routes: expect 20-50ms matching overhead
2. For apps with 10,000+ routes: expect 70-150ms matching overhead
3. Consider route organization - frequently accessed routes should be defined first
4. Cold boot can be mitigated with keep-alive pings or Cloudflare's smart placement

## Running the Benchmark

```bash
# Deploy and test
cd examples/cloudflare-stress-demo
pnpm build && pnpm deploy

# Test TTFB
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.devcorner.workers.dev/en/bench/first

curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.devcorner.workers.dev/en/bench/last
```
