# Baseline Benchmark — 2026-03-17

- **Commit**: `5244f5dc`
- **Tool**: autocannon (10s per scenario, 10 connections, 50 warmup requests)
- **App**: cloudflare-stress-demo (14K+ routes)
- **CPU**: Apple M4 (10 cores)
- **RAM**: 24 GB
- **OS**: macOS darwin arm64
- **Node**: v24.12.0

## Dev Mode (Vite dev server with CF plugin)

### Throughput

| Scenario                      | req/s | p50 ms | p95 ms | p99 ms |
| ----------------------------- | ----- | ------ | ------ | ------ |
| json-health                   | 695   | 11     | 39     | 54     |
| json-items-param              | 938   | 9      | 23     | 34     |
| bench-first (best-case match) | 1,836 | 4      | 10     | 12     |
| bench-last (3 routes checked) | 894   | 10     | 24     | 47     |
| bench-api-first (prefix skip) | 713   | 12     | 30     | 51     |
| bench-api-last (5005 routes)  | 1,348 | 4      | 16     | 23     |
| ssr-home (full SSR)           | 408   | 4      | 122    | 135    |

### Server Timing (single request, no load)

| Path             | Total | route-matching | handler-total | render-total | ssr-render-html |
| ---------------- | ----- | -------------- | ------------- | ------------ | --------------- |
| /bench/first     | 1ms   | 0ms            | 0ms           | -            | -               |
| /bench/last      | 0ms   | 0ms            | 0ms           | -            | -               |
| /api/bench/first | 0ms   | 0ms            | 0ms           | -            | -               |
| /api/bench/last  | 0ms   | 0ms            | 0ms           | -            | -               |
| / (SSR home)     | 9ms   | 0ms            | 8ms           | 7ms          | 4ms             |

## Production Mode (wrangler dev / workerd)

### Throughput

| Scenario                      | req/s | p50 ms | p95 ms | p99 ms |
| ----------------------------- | ----- | ------ | ------ | ------ |
| json-health                   | 181   | 40     | 195    | 227    |
| json-items-param              | 183   | 36     | 180    | 243    |
| bench-first (best-case match) | 72    | 121    | 360    | 458    |
| bench-last (3 routes checked) | 58    | 148    | 429    | 480    |
| bench-api-first (prefix skip) | 52    | 167    | 389    | 745    |
| bench-api-last (5005 routes)  | 83    | 95     | 357    | 384    |
| ssr-home (full SSR)           | 47    | 202    | 480    | 552    |

### Server Timing (single request, no load)

| Path             | Total | route-matching | handler-total | render-total | ssr-render-html |
| ---------------- | ----- | -------------- | ------------- | ------------ | --------------- |
| /bench/first     | 3ms   | 0ms            | 1ms           | -            | -               |
| /bench/last      | 2ms   | 0ms            | 1ms           | -            | -               |
| /api/bench/first | 4ms   | 0ms            | 1ms           | -            | -               |
| /api/bench/last  | 1ms   | 0ms            | 0ms           | -            | -               |
| / (SSR home)     | 4ms   | 0ms            | 3ms           | 3ms          | 2ms             |

### Build

| Metric     | Value  |
| ---------- | ------ |
| Build time | 5.3s   |
| Client JS  | 281 KB |
| RSC        | 7.8 MB |
| Total      | 8.1 MB |

## Notes

- **Dev mode** runs on Node.js via the Vite CF plugin — faster for local HTTP but not representative of edge performance.
- **Production mode** runs on local workerd (miniflare) — single-threaded sandbox, slower than actual CF edge. Numbers are useful for relative comparisons, not absolute production expectations.
- **Route matching is sub-millisecond** across all scenarios with 14K routes (trie optimization).
- **SSR home page**: 5-9ms total, dominated by RSC render and HTML streaming.
- **JSON response routes**: 0-3ms server timing — framework overhead is minimal.
- Use `pnpm bench:compare` to diff two result files and track regressions.

## Reproducing

```bash
cd tests/cloudflare-stress-demo

# Dev mode
pnpm bench

# Production mode
pnpm bench:prod

# Compare against baseline
pnpm bench:prod
pnpm bench:compare bench/results/baseline.json bench/results/bench-*.json
```
