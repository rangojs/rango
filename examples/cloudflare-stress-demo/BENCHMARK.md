# Benchmark Guide

## Quick Start

```bash
# Deploy
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Test endpoints (return JSON with matchStats)
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/last | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/site/en/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/site/en/bench/last | jq .

# Measure TTFB
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last

# Watch worker logs
pnpm wrangler tail --format json
```

## Understanding matchStats

Each benchmark route returns:
```json
{
  "route": "/api/bench/last",
  "matchStats": {
    "entriesChecked": 2,
    "entriesSkipped": 1,
    "routesChecked": 5005
  }
}
```

- `entriesChecked` - Number of RouteEntry objects examined
- `entriesSkipped` - Entries skipped via prefix optimization
- `routesChecked` - Individual routes checked within entries

## Current Route Structure

| Entry | staticPrefix | Routes | Description |
|-------|--------------|--------|-------------|
| 1 | `""` | 3 | Root routes (bench/first, home, bench/last) |
| 2 | `"/site"` | 5,003 | Site routes under `/site/:locale/*` |
| 3 | `"/api"` | 5,002 | API routes under `/api/*` |

## Expected Results

| Route | Entries Skipped | Routes Checked |
|-------|-----------------|----------------|
| `/bench/first` | 0 | 1 |
| `/bench/last` | 0 | 3 |
| `/api/bench/first` | 1 (site) | 4 |
| `/api/bench/last` | 1 (site) | 5,005 |
| `/site/en/bench/first` | 0 | 5 |
| `/site/en/bench/last` | 0 | 5,006 |

## Optimization Impact

- **API routes**: Skip 5,003 site routes (50% savings)
- **404 non-prefixed**: Skip ~10,005 routes (99.97% savings)
- **TTFB improvement**: ~200ms → ~15ms

## Nested Includes

Nested `include()` calls create separate entries, but optimization only works if **static prefixes differ**:

```typescript
// ❌ No benefit - same staticPrefix "/site"
include("/site/:locale", urls(({ include }) => [
  include("/shop", ...),  // staticPrefix = "/site"
  include("/blog", ...),  // staticPrefix = "/site"
]))

// ✅ Optimized - different static prefixes
include("/site", urls(({ include }) => [
  include("/shop/:cat", ...),  // staticPrefix = "/site/shop"
  include("/blog/:cat", ...),  // staticPrefix = "/site/blog"
]))
```

**Rule**: Put static segments BEFORE dynamic params for best optimization.

See `BENCHMARK-2026-02-05-33ff555.md` for full details.

## Benchmark History

- `BENCHMARK-2026-02-04-ea2cfc7.md` - Baseline before optimization
- `BENCHMARK-2026-02-04-39bd422-prefix-optimization.md` - First optimization attempt
- `BENCHMARK-2026-02-05-33ff555.md` - Working prefix optimization
- `BENCHMARK-2026-02-05-lazy-evaluation.md` - Lazy include evaluation
- `BENCHMARK-2026-02-05-build-manifest.md` - Build-time manifest cold start impact (current)

## Writing Benchmark Documentation

**IMPORTANT**: After testing performance changes, always create a benchmark document to track results.

### Step 1: Get Date and Commit

```bash
# Get today's date
date +%Y-%m-%d
# Output: 2026-02-05

# Get current commit hash (short)
git log -1 --format="%h"
# Output: 33ff555

# Get full commit info
git log -1 --format="%H %s"
# Output: 33ff555fdc5f305f507882e5ee9cbc8d5bec3dbf commit message
```

### Step 2: Create Benchmark File

Filename format: `BENCHMARK-{date}-{commit}.md`

Example: `BENCHMARK-2026-02-05-33ff555.md`

### Step 3: Document Required Sections

```markdown
# Title describing the change

- **Date**: YYYY-MM-DD
- **Commit**: `{short_hash}` (or note if uncommitted)
- **Deployed Version**: {cloudflare_version_id from deploy output}

## Problem Statement
What issue were you trying to solve?

## Solution
What approach did you take?

## Implementation Details
Code changes with snippets.

## Test Setup
- Route structure
- Total route counts
- Benchmark handlers used

## Testing Methodology
How did you test? Commands used:
- curl commands
- wrangler tail logs
- TTFB measurements
- DevTools observations

## Results
Tables with:
- matchStats (entriesChecked, entriesSkipped, routesChecked)
- TTFB before/after
- Optimization impact percentages

## Debugging Journey (if applicable)
Issues encountered and how you fixed them.

## Files Changed
List of modified files and what changed.

## Test Commands
Reproducible commands to verify results.
```

### Step 4: Run Tests and Collect Data

```bash
# Deploy first
pnpm build && pnpm wrangler deploy

# Collect matchStats for all benchmark routes
echo "=== /bench/first ===" && curl -s .../bench/first | jq .matchStats
echo "=== /bench/last ===" && curl -s .../bench/last | jq .matchStats
echo "=== /api/bench/first ===" && curl -s .../api/bench/first | jq .matchStats
echo "=== /api/bench/last ===" && curl -s .../api/bench/last | jq .matchStats
echo "=== /site/en/bench/first ===" && curl -s .../site/en/bench/first | jq .matchStats
echo "=== /site/en/bench/last ===" && curl -s .../site/en/bench/last | jq .matchStats

# Measure TTFB (run multiple times for warm results)
for i in {1..5}; do
  curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
    https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last
done

# Check worker logs for debug output
pnpm wrangler tail --format json
```

### Step 5: Compare with Previous Benchmark

Always reference the previous benchmark to show improvement:

| Metric | Before (commit X) | After (commit Y) | Change |
|--------|-------------------|------------------|--------|
| Routes checked | 10,008 | 5,005 | -50% |
| TTFB | 200ms | 15ms | -92% |

## Debug Mode

Enable in `src/urls.tsx`:
```typescript
import { enableMatchDebug } from "@rangojs/router/server";
enableMatchDebug(true);
```

This logs to Cloudflare console:
```
[findMatch] pathname="/api/bench/first", entries=3
  entry: prefix="", staticPrefix="", routes=3
  entry: prefix="", staticPrefix="/site", routes=5003
  entry: prefix="", staticPrefix="/api", routes=5002
  SKIP entry (staticPrefix="/site" doesn't match)
  MATCH: routeKey="api.benchFirst"
  Stats: entriesChecked=2, entriesSkipped=1, routesChecked=4
```
