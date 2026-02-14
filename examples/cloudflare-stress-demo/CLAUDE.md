# cloudflare-stress-demo

Stress test app for `@rangojs/router` with 10,000+ routes on Cloudflare Workers.

## Purpose

This app benchmarks route matching performance with large route counts, specifically testing the **prefix-based short-circuit optimization** that skips entire route groups based on URL prefix.

## Route Structure

```
Entry 1: staticPrefix=""      → 3 root routes
Entry 2: staticPrefix="/site" → 5,003 site routes
Entry 3: staticPrefix="/api"  → 5,002 API routes
```

## Key Files

- `src/urls.tsx` - Main URL patterns with `include()` for site and API routes
- `src/localized-patterns.tsx` - 5,003 routes under `/site/:locale/*`
- `src/included-patterns.tsx` - 5,002 routes under `/api/*`
- `src/pages/benchmark.tsx` - Homepage component

## Benchmark Routes

All benchmark routes return JSON with `matchStats`:

```bash
# Root (baseline)
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/last | jq .

# API (skips site routes)
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last | jq .

# Site
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/site/en/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/site/en/bench/last | jq .
```

## Debug Utilities

### Structured debug logging

Enable router debug logs with the `INTERNAL_RANGO_DEBUG` env var:
```bash
INTERNAL_RANGO_DEBUG=1 pnpm dev
```

### Match debug stats

Enable match statistics (entriesChecked, routesChecked) in `src/urls.tsx`:
```typescript
import { enableMatchDebug } from "@rangojs/router";
enableMatchDebug(true);
```

View Cloudflare logs:
```bash
pnpm wrangler tail --format json
```

## Deploy

```bash
pnpm build && pnpm wrangler deploy
```

## Benchmark Documentation

**IMPORTANT**: After making performance changes, always create a benchmark document.

1. Read `BENCHMARK.md` for detailed instructions on:
   - How to test and collect data
   - How to write benchmark documentation
   - Required sections and format
   - Naming convention: `BENCHMARK-{date}-{commit}.md`

2. See `BENCHMARK-*.md` files for examples:
   - `BENCHMARK-2026-02-04-ea2cfc7.md` - Baseline
   - `BENCHMARK-2026-02-05-33ff555.md` - Prefix optimization

3. Always include:
   - Date and commit hash in filename AND content
   - Problem statement and solution
   - Test methodology with commands
   - Results with matchStats tables
   - Files changed
