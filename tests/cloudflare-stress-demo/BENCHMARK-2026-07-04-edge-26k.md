# Edge baseline at 26k routes — new harness, first deployed run

- **Date**: 2026-07-04
- **Commit**: `bfe7158b` + uncommitted stress-setup overhaul (harness rewrite,
  /app group, hub/mega/overlap groups, 26,363 routes)
- **Deployed Version**: `8961012c-7dac-4616-be46-29cd65068684`
- **Upload**: 8,392 KiB raw / 966 KiB gzip; CF-reported worker startup 78 ms

## Problem statement

First run of the overhauled harness (`bench/run.ts --url`) against the real
edge. Local runs had flagged three traps — 404-fallback cost under big
prefixes, cache() hit no faster than miss for cheap pages, huge local
run-to-run variance — and could not answer cold-start or absolute-latency
questions at all.

## Methodology

`npx wrangler deploy && npx tsx bench/run.ts --url https://cloudflare-stress-demo.devcorner.workers.dev --runs 3 --duration 3`
immediately after deploy: one sequential first-hit pass per include prefix
(n=1, genuinely cold), then validation, warmup, 3 interleaved autocannon
rounds x 16 scenarios, Server-Timing collection. Client-observed latency;
RTT floor from this host ~20-25 ms. A local run (`npx tsx bench/run.ts
--runs 3 --duration 4 --cold-runs 3`, wrangler dev/workerd on an M4) ran the
same day; its key tables are inlined below because `bench/results/` is
git-ignored.

## Results — cold (n=1, post-deploy first hits)

| Path                                            | Pays                                           |    ms |
| ----------------------------------------------- | ---------------------------------------------- | ----: |
| `/bench/first`                                  | isolate cold start + 5.7 MB manifest parse     |   646 |
| `/mega/l2/l3/p1/x`                              | 3-level async chain (3 sequential imports)     |   464 |
| `/site/en/bench/first`                          | /site chunk (~9k routes) first-hit             |   188 |
| `/api/bench/first`                              | /api chunk (~5k routes) first-hit              |   137 |
| `/g/g001/bench/first`                           | hub + 50 spliced entries + one 240-route group |    76 |
| `/shop`, `/json-api`, `/app`, `/dup` first-hits | small chunks                                   | 66-82 |
| `/` after all includes warm                     | SSR document                                   |   102 |

Chunk first-hit cost scales with routes-per-chunk: 9k-route chunk 188 ms,
5k-route 137 ms, 240-route ~75 ms (~RTT + eval). Prefer more, smaller
groups; keep async-include chains shallow — each level multiplies first-hit.

## Results — warm throughput (median of 3 runs, 10 connections)

| Scenario                            |   req/s | p50 ms | vs floor                     |
| ----------------------------------- | ------: | -----: | ---------------------------- |
| json-health (floor)                 |     385 |     23 | —                            |
| json-items-unique (real matching)   |     370 |     23 | matching invisible under RTT |
| miss-root-probe (404, prefix skip)  |     359 |     25 | ~floor                       |
| api/site unique (RSC render)        | 243-275 |  33-38 | +10-15 ms render             |
| app-dashboard (3 parallel loaders)  |     258 |     34 | loaders overlap              |
| action-post (action + PE re-render) |     253 |     34 | ≈ SSR cost                   |
| cached-miss-unique                  |     254 |     35 | —                            |
| cached-hit                          |     235 |     36 | hit NOT faster than miss     |
| miss-under-site (404 fallback scan) |     230 |     35 | +10-12 ms CPU, p99 389 ms    |

IQRs on the edge are tight (e.g. 353-407) — far more stable than local
workerd (190-830 the same day). Edge runs are the better regression signal.

## Results — local reference run (same day, wrangler dev / workerd, M4)

Cold start, median of 3 fresh server restarts (TCP-only readiness):

| Path                   | Pays                                 | median ms |
| ---------------------- | ------------------------------------ | --------: |
| `/bench/first`         | first request (manifest parse)       |      46.7 |
| `/mega/l2/l3/p1/x`     | 3-level async chain                  |      30.5 |
| `/api/bench/first`     | /api chunk first-hit                 |      20.8 |
| `/site/en/bench/first` | /site chunk first-hit                |      19.6 |
| `/app/dashboard/main`  | /app first-hit (layout + loaders)    |      17.6 |
| `/g/g001/bench/first`  | hub + 50 spliced entries + one group |      13.5 |
| `/dup/shoes/cat-page1` | both dup chunks                      |      12.7 |

Warm throughput (median of 3 runs x 4s x 10 connections — note the wide
IQRs; treat local numbers as comparative only):

| Scenario                       | req/s | IQR     | p50 ms |
| ------------------------------ | ----: | ------- | -----: |
| json-health (floor)            |   420 | 190-830 |     19 |
| json-items-unique              |   245 | 100-637 |     31 |
| ssr-home                       |   138 | 35-264  |     56 |
| site-l4-unique (deep tree)     |   103 | 32-202  |     68 |
| app-dashboard-unique           |   126 | 26-169  |     69 |
| rsc-nav-unique (Flight)        |   185 | 50-268  |     48 |
| cached-hit                     |   100 | 41-202  |     72 |
| cached-miss-unique             |   116 | 43-210  |     65 |
| hub-mixed-unique               |   175 | 74-279  |     43 |
| miss-under-site (404 fallback) |    97 | 68-172  |    105 |
| miss-root-probe (404, skip)    |   185 | 166-366 |     45 |
| action-post                    |   134 | 94-202  |     62 |

Local-only signals: Server-Timing shows the dashboard's three loaders
(4+6+3 ms simulated IO) totalling 6-7 ms — overlapped, not serialized.
Memory under load peaked at 1.9 GB workerd RSS (toolchain-labelled; NOT
comparable to production isolate limits). Local exaggerates the 404-fallback
and deep-tree gaps relative to the edge (CPU contention with the load
generator); the edge tables above are the numbers to quote.

## Findings

1. **Cold first request is the 26k-route bill: ~646 ms.** Warm floor is
   23 ms. The cost concentrates in isolate start + manifest parse, exactly
   as designed (worker startup itself is 78 ms per CF).
2. **Deep async-include chains are expensive cold on real infra**: 464 ms
   for 3 levels vs ~30 ms locally. Chain depth multiplies first-hit latency.
3. **cache() hit ≈ miss for cheap pages, confirmed on real Cache API.**
   Segment caching pays proportional to what the cached render costs.
4. **The 404 fallback scan under a big prefix costs ~10-12 ms CPU per
   request in production** (plus a long tail), while prefix-skipped root
   404s ride the floor. Matched-route latency is flat across all shapes.
5. **Server-Timing reads ~0 on deployed CF** (timers frozen during request
   execution) — the worker-side breakdown is a local-only tool; edge analysis
   must use client-observed timing. (Methodology note added to BENCHMARK.md.)

## Test commands

See Quick Start in BENCHMARK.md (`--url` mode). Rerun cold numbers only via
a fresh `wrangler deploy` first — isolates stay warm once touched.
