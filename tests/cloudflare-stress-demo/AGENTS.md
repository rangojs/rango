# cloudflare-stress-demo

Stress test app for `@rangojs/router` with 26k+ routes on Cloudflare Workers.

## Purpose

This app measures what a large route table actually costs at runtime and build
time. Since trie matching landed, per-request match cost is O(path segments)
regardless of route count — the old linear-scan / prefix-skip story is dead for
matched routes. What 26k routes cost today:

- **Cold start**: the routes-manifest chunk (~5.7 MB raw at 26k routes, `JSON.parse`d once on
  first request) and the named-routes chunk (~1.15 MB, statically imported by
  the worker entry).
- **Async include first-hit**: each route group is a split chunk awaited on the
  first request to its prefix.
- **Memory**: parsed trie + named-routes registry resident in the isolate.
- **Build time**: discovery awaits every include provider; codegen emits one
  `router.named-routes.gen.ts` line per route.
- **Type-level**: 26k-route registry through `RegisteredRoutes` (see
  `src/router.tsx` type assertions).

The regex matcher with prefix short-circuiting still exists as the fallback for
trie misses — i.e. 404s: an unmatched path falls through to the full scan,
where `staticPrefix` skipping is what saves it from regex-executing every
pattern. That path is only exercised by unmatched-path load, not by any of the
named bench routes below.

## Route Structure

```
staticPrefix=""            → root routes (bench, home, links, dashboard)
staticPrefix="/site"       → ~9,000 localized routes (async include)
staticPrefix="/api"        → ~5,000 API routes (async include)
staticPrefix="/shop"       → ~200 routes, nested includes (async include)
staticPrefix="/json-api"   → typed path.json response routes (async include)
staticPrefix="/app"        → loaders, cache() segment, action form (async include)
staticPrefix="/g"          → hub of 50 sibling async includes, 12,000 generated
                             routes (deep static, 5-param, suffix, catch-all)
staticPrefix="/mega"       → 3-level async include chain (l1 → l2 → l3)
staticPrefix="/site-admin" → string-prefix overlap with /site
staticPrefix="/dup"        → /dup/:cat + /dup/:brand: same-staticPrefix pair
```

Total: 26,363 named routes (`e2e/named-routes.test.ts` pins the floor).

## Key Files

- `src/urls.tsx` - Root URL patterns; each group is `include(prefix, () => import(...))`
- `src/localized-patterns.tsx` - ~9,000 routes under `/site/:locale/*`
- `src/included-patterns.tsx` - ~5,000 routes under `/api/*`
- `src/shop-patterns.tsx` - nested includes under `/shop/*`
- `src/json-api-patterns.tsx` - `path.json` response routes
- `src/app-like-patterns.tsx` - loaders / cache() / action (representative load)
- `src/stress/factory.tsx` + `src/groups/` - generated hub groups
  (`node scripts/gen-groups.mjs --groups 50`, output committed). NOTE: group
  modules and the hub annotate exports as `UrlPatterns<any>` — without the
  wide type the root urls() inference blows up 36x (see factory.tsx).
- `src/route-structure.ts` - home-screen map data; append entries when groups change
- `src/route-classes.ts` - dashboard route-class descriptors
- `src/pages/benchmark.tsx` - Homepage component
- `bench/` - the load-test harness (autocannon; see BENCHMARK.md)

## Benchmark Routes

Bench routes return JSON with timing and `matchStats`:

```bash
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last | jq .
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/site/en/bench/last | jq .
```

**Reading `matchStats`**: all named routes resolve via the trie, so
`entriesChecked: 0, routesChecked: 0` is the expected steady-state result —
the regex scanner (which is what increments those counters) never ran. Non-zero
numbers appear only when the regex fallback executes (unmatched paths, or the
transient window before a nested lazy include is spliced). `matchStats` is a
module-global diagnostic: it is only meaningful for a single request at a time,
not under concurrent load.

## Debug Utilities

### Structured debug logging

Enable router debug logs with the `INTERNAL_RANGO_DEBUG` env var:

```bash
INTERNAL_RANGO_DEBUG=1 pnpm dev
```

### Match debug stats

`enableMatchDebug` (from `@rangojs/router/__internal`) populates `matchStats`.
It is gated in `src/urls.tsx` — do not leave it unconditionally enabled: it
adds work on the request path and pollutes benchmark numbers.

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

1. Read `BENCHMARK.md` for the harness (`bench/run.ts`), methodology, and the
   required document format. Naming convention: `BENCHMARK-{date}-{commit}.md`.
2. Older `BENCHMARK-2026-02-*.md` files are point-in-time records from the
   pre-trie linear-scan era — do not use their expected numbers as references.
3. Always include: date + commit in filename AND content, problem statement,
   methodology with commands, results tables, files changed.
