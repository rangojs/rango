# Benchmark Guide

## Quick Start

```bash
cd tests/cloudflare-stress-demo

# Full local benchmark: build, cold-start phase (5 fresh server starts),
# validation, warmup, throughput (5 runs x 5s x 10 connections), Server-Timing
npx tsx bench/run.ts

# Compare two result JSONs (IQR-aware significance verdicts)
npx tsx bench/compare.ts bench/results/<before>.json bench/results/<after>.json

# Useful flags
npx tsx bench/run.ts --runs 3 --duration 3      # faster, noisier
npx tsx bench/run.ts --skip-cold                # throughput only
npx tsx bench/run.ts --skip-throughput          # cold start only
npx tsx bench/run.ts --baseline                 # also write baseline.json (clean tree only)
npx tsx bench/run.ts --mode=dev                 # smoke test only, NOT a benchmark

# Deployed edge: the full harness against the live worker. Run it RIGHT
# AFTER deploy — the first-hit pass only sees cold isolates once.
npx wrangler deploy && npx tsx bench/run.ts \
  --url https://cloudflare-stress-demo.devcorner.workers.dev --runs 3 --duration 3

# Manual spot check
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first

# Watch worker logs
pnpm wrangler tail --format json
```

## Reproducing a full measurement (runbook)

The exact sequence behind BENCHMARK-2026-07-04-edge-26k.md — run it from
`tests/cloudflare-stress-demo` on a machine on AC power with nothing heavy
running:

```bash
# 0. Clean tree on the commit under test (dirty runs are tagged -dirty and
#    must not become baselines or comparison sides).
git status

# 1. Local run (comparative numbers, Server-Timing breakdown, memory):
npx tsx bench/run.ts                       # defaults: 5 runs x 5s, 5 cold restarts
# -> bench/results/bench-<date>-<commit>.{json,md}

# 2. Edge run — deploy FIRST, bench IMMEDIATELY (first-hit pass needs cold
#    isolates; once touched they stay warm until the next deploy):
npx wrangler deploy
npx tsx bench/run.ts --url https://cloudflare-stress-demo.devcorner.workers.dev \
  --runs 3 --duration 3
# -> bench/results/bench-<date>-<commit>-edge.{json,md}

# 3. Compare against the previous result (IQR-aware verdicts — do not quote
#    deltas marked "within variance"):
npx tsx bench/compare.ts bench/results/<before>.json bench/results/<after>.json

# 4. On a clean tree, refresh the committed baseline:
npx tsx bench/run.ts --baseline

# 5. Write BENCHMARK-<date>-<slug>.md (format: "Writing Benchmark
#    Documentation" below) with BOTH the local and edge tables.
```

Interpretation rules: cold rows in an edge run are n=1 by nature; local
throughput has large run-to-run variance (edge IQRs are tighter — prefer the
edge run for regression verdicts); Server-Timing is local-only (frozen timers
on deployed CF); `MATCH_DEBUG` stays unset. If a scenario validation fails,
the app changed under the benchmark — fix the scenario or the route before
trusting anything.

## Methodology (what makes a number trustworthy here)

The harness (`bench/run.ts`) enforces these; keep them when measuring by hand:

1. **Multiple runs, median ± IQR.** Every throughput scenario runs `--runs`
   times (default 5), interleaved round-robin so thermal/background drift
   spreads across scenarios. Tables report median with IQR; `bench/compare.ts`
   only calls a delta significant when it clears both sides' variance (3%
   floor). A single local run cannot support a <10% claim.
2. **Unique-path load for matching claims.** The router keeps a single-entry
   pathname cache (`find-match.ts`) and resolves named routes via the trie.
   Hammering one URL measures a string-compare fast path, not matching.
   `unique` scenarios cycle ~400 distinct pre-shuffled paths; only their
   numbers respond to matching changes. 404 scenarios exercise the regex
   fallback scan — the only remaining route-count-proportional path.
3. **Expected responses are enforced.** Each scenario declares `expectStatus`
   (+ body probe); a validation pass runs before load and the status-class
   counters are checked after every run. Errors, timeouts, or unexpected
   statuses FAIL the benchmark — autocannon would otherwise happily report a
   404 storm as high throughput.
4. **Cold start is measured, not erased.** `--cold-runs` fresh server starts
   with TCP-only readiness; the first HTTP request each start is the measured
   one (manifest parse), followed by each include prefix's first hit.
5. **Honest percentiles and labels.** autocannon reports p97_5 (not p95) and
   the harness keeps that name. Memory is toolchain process-group RSS with a
   workerd-only breakdown — it is not isolate heap.
6. **Local numbers are comparative only.** `wrangler dev` is workerd on
   loopback with the load generator sharing the host. Direction and large
   ratios transfer; absolute latency does not. Dev mode (`--mode=dev`)
   measures Vite's dev pipeline and is a smoke test, not a benchmark.
7. **MATCH_DEBUG stays off** during benchmarks (default). The debug path adds
   per-request work in the fallback matcher.
8. **Server-Timing is a LOCAL tool.** On deployed CF, timers are frozen
   during request execution (spectre mitigation), so the worker's own
   Server-Timing durations read as ~0 on the edge — use client-observed
   latency there and the Server-Timing breakdown locally. Edge runs are also
   RTT-dominated (~20-25ms floor from this region): compare scenarios against
   each other, not against local numbers.

## Understanding matchStats

Each benchmark route returns:

```json
{
  "route": "/api/bench/last",
  "matchStats": {
    "entriesChecked": 0,
    "entriesSkipped": 0,
    "routesChecked": 0
  }
}
```

- `entriesChecked` - RouteEntry objects examined by the **regex fallback** matcher
- `entriesSkipped` - Entries the fallback skipped via static-prefix optimization
- `routesChecked` - Individual routes the fallback regex-tested

**All zeros is the expected steady-state result.** Every named route resolves
via the precomputed trie in O(path segments); the regex fallback (the only
code that increments these counters) runs for trie misses — unmatched paths
(404s) and the transient window before a nested lazy include is spliced. To
observe non-zero stats, set the `MATCH_DEBUG=1` binding and request an
unmatched path. matchStats is stored in module-global state: it is a
single-request diagnostic and is NOT reliable under concurrent load.

## Current Route Structure

| staticPrefix    | Routes  | Description                                              |
| --------------- | ------- | -------------------------------------------------------- |
| `""`            | ~7      | Root routes (bench/first, home, dashboard, links, ...)   |
| `"/site"`       | ~9,000  | Localized routes under `/site/:locale/*`                 |
| `"/api"`        | ~5,000  | API routes under `/api/*`                                |
| `"/shop"`       | ~200    | Nested includes (`/shop/product`, `/shop/category`)      |
| `"/json-api"`   | 4       | Typed `path.json` response routes                        |
| `"/app"`        | 3       | App-shaped: loaders, cache() segment, action form        |
| `"/g"`          | ~12,000 | Hub: 50 sibling async includes (generated, mixed shapes) |
| `"/mega"`       | 90      | 3-level async include chain                              |
| `"/site-admin"` | 40      | String-prefix overlap with `/site`                       |
| `"/dup"`        | 10      | `/dup/:cat` + `/dup/:brand` same-staticPrefix pair       |

Each non-root group is an async `include(prefix, () => import(...))` — its own
worker chunk, awaited on the first request to that prefix. Total: 26,363 named
routes (`e2e/named-routes.test.ts` pins the floor).

The `/app` group exists for representative load: a layout loader plus two
parallel route loaders on `/app/dashboard/:section`, a `cache({ ttl: 300 })`
boundary on `/app/cached/:bucket`, and a PE-postable server action on
`/app/feedback`, plus a middleware chain (three global via `router.use`, two
route-level; see `src/middleware.ts`). `e2e/app-load-surface.test.ts` pins
this surface in both dev and production so the bench scenarios cannot
silently measure a broken route.

The `/g` groups come from `node scripts/gen-groups.mjs --groups 50` (output
committed); scale via `--groups` and `src/stress/scale.ts`, then rebuild and
commit the regenerated `*.gen.ts`. Measured at this scale: routes-manifest
chunk 5.7 MB raw, named-routes chunk 1.15 MB, worker entry 108 KB, typecheck
3.6 s / 141k instantiations. The wide `UrlPatterns<any>` annotations in
`src/stress/factory.tsx`, the group modules, and `src/groups/hub.ts` are what
keep typecheck flat (removing them measured 4.05M instantiations / 20 s) —
read the factory comment before changing them.

## What the route count costs (trie era)

Matched-request latency is independent of route count. The 26k routes cost:

- **Cold start / first request**: routes-manifest chunk (~5.7 MB raw)
  `JSON.parse`d once; named-routes chunk (~1.15 MB) parsed at isolate startup
  (statically imported by the worker entry).
- **First request per include prefix**: awaits that group's chunk import.
- **404s**: fall through to the regex scan — the only remaining path where
  static-prefix skipping matters.
- **Memory**: parsed trie + named-routes registry stay resident.

## Nested Includes

Nested `include()` calls create separate entries with their own static
prefixes (`/shop/product` vs `/shop/category`). Distinct prefixes matter for
the regex fallback (404 scans skip non-matching entries) and for lazy loading
granularity — matched requests resolve via the trie regardless.

**Rule**: Put static segments BEFORE dynamic params — a leading param
(`/site/:locale/...`) makes the group's staticPrefix shorter, which weakens
fallback skipping and forces the group chunk to load for more first-hit paths.

Historical (pre-trie) analysis: `BENCHMARK-2026-02-05-33ff555.md`.

## Benchmark History

- `BENCHMARK-2026-02-04-ea2cfc7.md` - Baseline before optimization (pre-trie)
- `BENCHMARK-2026-02-04-39bd422-prefix-optimization.md` - First optimization attempt (pre-trie)
- `BENCHMARK-2026-02-05-33ff555.md` - Working prefix optimization (pre-trie)
- `BENCHMARK-2026-02-05-lazy-evaluation.md` - Lazy include evaluation
- `BENCHMARK-2026-02-05-build-manifest.md` - Build-time manifest cold start impact
- `BENCHMARK-2026-03-17-baseline.md` - Post-trie baseline with bench/ harness
- `BENCHMARK-2026-07-01-async-include.md` - Async include() A/B vs main
- 2026-07-04 - Harness overhaul (unique-path scenarios, cold-start phase,
  response gating, N-run medians) + scale-up to 26k routes. Numbers from
  before this date came from the old single-URL harness: they measured the
  router's pathname-cache fast path, not matching, and are not comparable
  with post-overhaul results.

Pre-trie documents describe the linear-scan matcher; their expected
matchStats numbers no longer apply.

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
# Local harness (writes bench/results/bench-{date}-{commit}[-dirty].{json,md})
npx tsx bench/run.ts

# Deployed-edge spot check (absolute numbers; run >=10 samples, note cold vs warm)
pnpm build && pnpm wrangler deploy
for i in {1..10}; do
  curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
    https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/first
done
```

### Step 5: Compare with Previous Benchmark

Compare against the other side's result JSON — the verdict column accounts for
run-to-run variance:

```bash
npx tsx bench/compare.ts bench/results/bench-<before>.json bench/results/bench-<after>.json
```

Never quote a delta that compare.ts marks "within variance" as a finding, and
never compare against a `-dirty` result or a different machine's numbers.

## Debug Mode

### Structured debug logging

Enable router debug logs with the `INTERNAL_RANGO_DEBUG` env var:

```bash
INTERNAL_RANGO_DEBUG=1 pnpm dev
```

### Match debug stats

Match statistics are gated behind the `MATCH_DEBUG` worker binding (see
`src/worker.rsc.tsx` and `src/env.ts`) so benchmark runs are not polluted by
debug work on the request path:

```bash
# local
wrangler dev --var MATCH_DEBUG:1
# deployed: add {"vars": {"MATCH_DEBUG": "1"}} to wrangler.json before deploy
```

Remember: named routes are trie hits and report zeros; only trie-miss
(404/fallback) requests produce non-zero stats, and only reliably when
requests are sent one at a time.
