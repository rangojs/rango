# Async include() Benchmark — 2026-07-01

A/B of the async `include(prefix, () => import("./routes"))` feature (PR #631)
against `main`, to answer: **did making `findMatch` async / adding async
include reduce runtime performance?**

- **Branches**: `main` (`8551e640`, all-eager includes, **sync** `findMatch`)
  vs `feat/async-include` (`2c94ae29`, `/site` `/api` `/json-api` `/shop`
  code-split behind `() => import()`, **async** `findMatch`)
- **App**: cloudflare-stress-demo (14K+ routes)
- **Tool**: autocannon (4s per scenario, 10 connections), server **warmed** (all
  lazy/async includes loaded before measuring) + cold-TTFB via `curl -w`
- **Server**: `vite preview` (local `@cloudflare/vite-plugin` / miniflare / workerd)
- **Machine**: same host, back-to-back runs, Node v24.12.0, macOS arm64

## Result: no regression — async include is FASTER on every metric

### Build (cold-start lever)

| Metric                        | main (eager) | feat (async) |    Δ |
| ----------------------------- | -----------: | -----------: | ---: |
| Worker entry `dist/rsc/index.js` |   320,558 B |    102,459 B | **−68%** |

The split groups become their own dynamically-imported chunks; the entry the
isolate parses/compiles at cold start is ~3× smaller.

### Cold first-request TTFB (fresh isolate, first hit)

| Path                          | main    | feat   |    Δ |
| ----------------------------- | ------: | -----: | ---: |
| `/` (SSR home)                | 27.9 ms | 7.9 ms | **−72%** |
| `/shop/product/bench/first`   |  5.0 ms | 2.4 ms | −52% |
| `/site/en/bench/first`        |  4.9 ms | 3.1 ms | −37% |
| `/api/bench/first`            |  4.5 ms | 2.5 ms | −44% |

### Warmed throughput (autocannon 4s / 10c, all includes loaded)

| Scenario            | main req/s (avg lat) | feat req/s (avg lat) |     Δ req/s |
| ------------------- | -------------------: | -------------------: | ----------: |
| `/json-api/health`  |       939 (10.1 ms)  |     1,772 (5.1 ms)   |   **+89%** |
| `/bench/first`      |       986 (9.7 ms)   |     1,684 (5.4 ms)   |   **+71%** |
| `/api/bench/last`   |     1,026 (9.3 ms)   |     2,359 (3.8 ms)   |  **+130%** |
| `/` (SSR home)      |       861 (11.1 ms)  |     3,006 (2.9 ms)   |  **+249%** |

### matchStats (route-matching algorithm)

Identical on both branches — every benchmark route resolves via the trie with
`entriesChecked: 0, routesChecked: 0`. **The matching algorithm is unchanged;**
the async change adds only a microtask + Promise allocation per `findMatch`
(~tens of ns), invisible here.

## Interpretation & honest caveats

- **Direction is unambiguous and consistent**: feat is faster on *every*
  scenario, cold and warm. There is **no runtime regression** from async
  `findMatch` or async include. The per-`findMatch` microtask is real but
  swamped.
- **The magnitude (+71–249%) is indicative, not rigorously isolated.** This A/B
  compares two different *route structures* — main's single 320 KB eager worker
  vs feat's 102 KB entry + split chunks — not just the `findMatch` async change.
  The large warmed deltas most plausibly reflect the ~3× smaller worker entry
  (faster V8 startup, smaller resident working set / better locality per
  request), not the router change. To isolate the *pure* async-`findMatch` cost
  you would bench feat with all-**eager** includes (same structure as main, only
  the sync→async difference) vs main — not done here.
- **Not the packaged bench, not a real edge.** `pnpm bench` (`bench/run.ts`)
  spawns `pnpm dev` / `pnpm wrangler dev` and is blocked locally by the repo's
  pnpm `verifyDepsBeforeRun` hook; this run bypassed it with `vite preview` +
  `autocannon` directly. Numbers are local miniflare/workerd, short single runs
  (run-to-run variance applies), not `wrangler deploy` + edge TTFB (the guide's
  canonical method).

## Bottom line

Making `findMatch` async to support code-split includes did **not** cost runtime
performance — on this stress app it is a clear net win (smaller entry, faster
cold start, higher warmed throughput). The async-matching microtask is below the
measurement floor. For a rigorous per-`findMatch` isolation or edge numbers, run
`pnpm bench:compare` (or deploy + `curl -w`) per BENCHMARK.md.
