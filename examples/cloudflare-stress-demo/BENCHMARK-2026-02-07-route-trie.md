# Build-Time Route Trie + Ancestry-Based Layout Pruning

- **Date**: 2026-02-07
- **Commit**: `9e3ab84` (uncommitted changes on `research/manifest-ancestry`)
- **Deployed Version**: `85ab1c0b-adc5-4559-b6b5-5bd2e0ddc405`

## Problem Statement

Two runtime costs remained after the prefix-based short-circuit and build-time discovery:

1. **Route matching**: `findMatch()` iterates all entries and compiles regex per route -- O(entries x routes). For `/site/en/bench/last` this meant checking 9,003 patterns via regex.
2. **Manifest building**: `loadManifest()` runs ALL DSL calls (layout, path, middleware) even though only 1 route matched. For 4 nested layout levels x 1000+ routes, that's thousands of unnecessary `path()` calls.

## Solution

Two-phase optimization:

### Phase 1: Route Trie (O(path_length) matching)

Build a trie at build time from the route manifest. At runtime, walk the trie by path segments instead of iterating entries and compiling regexes.

- Static segments: hash-based O(1) child lookup
- Dynamic params: single backtrack path
- Wildcards: terminal match for remaining segments
- Constraint validation: post-match check against allowed param values
- Trailing slash: same redirect logic as regex path

### Phase 2: Ancestry-Based Layout Pruning

Embed each route's ancestry (shortCode chain from root to route) in the trie. When `loadManifest()` runs the DSL:
- `layout()` checks if its shortCode is in the matched route's ancestry
- If not an ancestor, skip the entire subtree (no children evaluated)
- Counters still increment to maintain shortCode consistency

## Implementation Details

### New files

- `src/build/route-trie.ts` -- Build-time trie construction from route manifest, ancestry map, and staticPrefix map. Uses `parsePattern()` from pattern-matching.ts.
- `src/router/trie-matching.ts` -- Runtime trie walker with static > param > wildcard priority, constraint validation, and trailing slash handling.

### Modified files

- `src/router/pattern-matching.ts` -- Exported `parsePattern()` and `ParsedSegment`. Added `ancestry` field to `RouteMatchResult`.
- `src/route-map-builder.ts` -- Added `setRouteTrie/getRouteTrie` and `setRouteAncestry/getRouteAncestry` storage.
- `src/server.ts` -- Exported trie/ancestry setters.
- `src/build/generate-manifest.ts` -- Ancestry capture via parent chain traversal using `createRouteHelpers()` + `MapRootLayout` wrapping.
- `src/vite/index.ts` -- Build trie in `discoverRouters()`, emit in virtual module.
- `src/server/context.ts` -- Added `ancestry?: Set<string>` to `HelperContext`, propagated in `run()`/`runWithStore()`.
- `src/router/manifest.ts` -- Set ancestry in context before handler evaluation.
- `src/route-definition.ts` -- Ancestry pruning in `layout()` and `cache()`.
- `src/router.ts` -- Trie-first matching with regex fallback in `findMatch()`.
- `src/server/route-manifest-cache.ts` -- Build and set trie at runtime on manifest cache MISS.

### Trie data structure

```typescript
interface TrieNode {
  r?: TrieLeaf;                    // route terminal at this node
  s?: Record<string, TrieNode>;    // static segment children
  p?: { n: string; c: TrieNode };  // param child
  w?: TrieLeaf & { pn: string };   // wildcard terminal
}

interface TrieLeaf {
  n: string;       // route name
  sp: string;      // staticPrefix of the entry
  a: string[];     // ancestry shortCodes
  op?: string[];   // optional param names
  cv?: Record<string, string[]>;  // constraint validation
  ts?: string;     // trailing slash mode
}
```

### Matching algorithm

```
findMatch(pathname):
  1. Try trie match (O(path_length))
     - Split pathname into segments
     - Walk trie: static child > param child > wildcard
     - Validate constraints post-match
     - Handle trailing slash alternates
  2. If trie returns null, fall back to regex iteration
```

## Test Setup

- **Total routes**: 14,214 (4 root + 5,003 site + 5,002 api + 4,205 shop)
- **Worker bundle**: 5,487 KB total (includes trie data + ancestry map)
- **Gzip size**: 585 KB
- **Worker Startup Time**: 57ms

## Results

### Route Matching (matchStats)

| Route | Previous (regex) | Current (trie) |
|-------|-----------------|----------------|
| | Checked / Skipped / Routes | Checked / Skipped / Routes |
| `/bench/first` | 1 / 3 / 1 | **0 / 0 / 0** |
| `/bench/last` | 1 / 3 / 4 | **0 / 0 / 0** |
| `/api/bench/first` | 1 / 1 / 1 | **0 / 0 / 0** |
| `/api/bench/last` | 1 / 1 / 5,002 | **0 / 0 / 0** |
| `/site/en/bench/first` | 1 / 0 / 2 | **0 / 0 / 0** |
| `/site/en/bench/last` | 1 / 0 / 9,003 | **0 / 0 / 0** |

The trie bypasses the regex matching entirely. Zero entries checked, zero routes checked.

### TTFB (warm, 5 runs)

| Route | Previous Min/Med/Max | Current Min/Med/Max |
|-------|---------------------|---------------------|
| `/bench/first` | 35/36/47ms | **34/35/78ms** |
| `/bench/last` | - | **31/34/34ms** |
| `/api/bench/first` | 75/80/110ms | **39/41/49ms** |
| `/api/bench/last` | 68/89/251ms | **39/42/43ms** |
| `/site/en/bench/first` | 91/118/162ms | **44/46/52ms** |
| `/site/en/bench/last` | 112/139/592ms | **47/49/64ms** |

Key improvements:
- `/api/bench/last`: **89ms -> 42ms** (median, -53%)
- `/site/en/bench/last`: **139ms -> 49ms** (median, -65%)
- Variance dramatically reduced (no more 251ms/592ms spikes)

### Comparison with Previous Approaches

| Route | Baseline (no opt) | Prefix opt | **Trie** |
|-------|-------------------|-----------|----------|
| `/api/bench/last` | ~200ms | ~89ms | **~42ms** |
| `/site/en/bench/last` | ~200ms | ~139ms | **~49ms** |

## Browser Verification

Tested partial navigation on deployed `cloudflare-basic`:
- Home -> About -> Counter -> Blog -> Blog Post: all work correctly
- Layout preserved across navigations
- Breadcrumbs update correctly
- Blog post nested route renders properly

## Debugging Journey

### Issue: Trie not loaded in dev mode

The Vite plugin's `configureServer` fires `setTimeout(discover, 0)` but the RSC environment runner isn't ready yet (`rscEnv.runner` is null). The manifest/trie was only populated at runtime on first request via `route-manifest-cache.ts`.

**Fix**: Build the trie in `route-manifest-cache.ts` on cache MISS, alongside the manifest generation. The `GeneratedManifest` already contains `routeAncestry` and `prefixTree`, so we build the trie from those.

### Issue: Trie not in production build

The virtual module `load()` correctly emits `setRouteTrie(...)` for build mode, since `buildStart()` creates a temp server where the RSC runner IS available. Production build confirmed working.

## Files Changed

| File | Change |
|------|--------|
| `src/build/route-trie.ts` | NEW: trie builder |
| `src/router/trie-matching.ts` | NEW: trie matcher |
| `src/router/pattern-matching.ts` | Export parsePattern, add ancestry to RouteMatchResult |
| `src/route-map-builder.ts` | Trie + ancestry storage |
| `src/server.ts` | Export trie/ancestry setters |
| `src/build/generate-manifest.ts` | Ancestry capture |
| `src/build/index.ts` | Export trie types |
| `src/vite/index.ts` | Build trie, emit in virtual module |
| `src/server/context.ts` | ancestry in HelperContext |
| `src/router/manifest.ts` | Set ancestry from match result |
| `src/route-definition.ts` | Pruning in layout() and cache() |
| `src/router.ts` | Trie-first matching |
| `src/server/route-manifest-cache.ts` | Runtime trie building on cache MISS |

## Test Commands

```bash
# Build and deploy
cd examples/cloudflare-stress-demo
pnpm build && pnpm wrangler deploy

# Verify trie matching (all should show 0/0/0)
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/bench/first | jq .matchStats
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last | jq .matchStats
curl -s https://cloudflare-stress-demo.devcorner.workers.dev/site/en/bench/last | jq .matchStats

# Measure TTFB
for i in {1..5}; do
  curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
    https://cloudflare-stress-demo.devcorner.workers.dev/api/bench/last
done

# Run e2e tests
pnpm --filter @rangojs/router exec playwright test
pnpm --filter cloudflare-basic exec playwright test
```
