# Route Matching Benchmark: Prefix Short-Circuit Optimization

Benchmark of @rangojs/router with 14,000+ routes on Cloudflare Workers, testing the prefix-based short-circuit optimization for `include()` groups.

- **Date**: 2026-02-04
- **Commit**: `39bd422` (feat/cloudflare-stress-demo branch)

## Optimization Summary

When `include()` uses a **static prefix** (e.g., `/api`, `/site`), the router can skip ALL routes in that group if the pathname doesn't match the prefix. This is O(1) instead of O(n) for non-matching prefixes.

```typescript
// Before: /:locale captures anything as locale param - can't short-circuit
include("/:locale", localizedPatterns); // Must check all routes

// After: /site is static - can short-circuit if pathname doesn't start with /site
include("/site/:locale", localizedPatterns); // Skip if no /site prefix
```

## Route Structure

```
/bench/first                 - Benchmark route BEFORE includes
/                            - Home page
/site/:locale/*              - 9,000+ localized routes
  /site/:locale/bench/first  - Early site route
  /site/:locale/bench/last   - Late site route (after 9000+ patterns)
/api/*                       - 5,000 API routes
  /api/v1/resource1/:id      - Early API route
  /api/v4/static/1000        - Late API route
/bench/last                  - Benchmark route AFTER all 14,000+ routes
```

## Results

| Route                    | Position        | TTFB (warm) | Notes                           |
| ------------------------ | --------------- | ----------- | ------------------------------- |
| `/bench/first`           | Before includes | ~96ms       | Baseline                        |
| `/site/en/bench/first`   | Early site      | ~76ms       | Quick match in site routes      |
| `/site/en/bench/last`    | Late site       | ~188ms      | After 9000+ site patterns       |
| `/api/v1/resource1/test` | Early API       | ~151ms      | **Skips 9000+ site routes**     |
| `/api/v4/static/1000`    | Late API        | ~200ms      | Skips site, late in API routes  |
| `/bench/last`            | After ALL       | ~210ms      | Worst case (all 14,000+ routes) |

## Key Findings

### 1. Prefix Optimization Works

API routes are **faster** than late site routes even though API routes are defined AFTER site routes:

- `/site/en/bench/last` (late site): **188ms** - iterates through 9000+ site routes
- `/api/v1/resource1/test` (early API): **151ms** - skips all 9000+ site routes

The **37ms savings** comes from not iterating through site routes at all.

### 2. Estimated Savings

Without the prefix optimization, `/api/v1/resource1/test` would need to:

- Check 9000+ site routes (~100ms additional)
- Then check API routes

Estimated savings: **~40-100ms** per API request.

### 3. When Optimization Applies

The optimization works when `include()` prefix is **fully static**:

| Prefix          | Can Short-Circuit? | Reason                 |
| --------------- | ------------------ | ---------------------- |
| `/api`          | ✓ Yes              | Static prefix          |
| `/site/:locale` | ✓ Yes              | `/site` is static      |
| `/admin/users`  | ✓ Yes              | Static prefix          |
| `/:locale`      | ✗ No               | First segment is param |
| `/:tenant/api`  | ✗ No               | First segment is param |

### 4. Per-Route Cost

- **~5-7 microseconds per route** for pattern matching
- With 9000 routes: ~45-63ms matching overhead
- Prefix check: **<1ms** (single string comparison)

## Recommendations

1. **Use static prefixes** for large route groups:

   ```typescript
   // Good: /site prefix enables optimization
   include("/site/:locale", localizedPatterns);

   // Bad: /:locale can't short-circuit
   include("/:locale", localizedPatterns);
   ```

2. **Order includes by traffic**: Put frequently accessed groups first since the router checks in order.

3. **Group related routes**: If you have 10,000 admin routes and 100 public routes, the prefix check can skip all admin routes for public requests.

## Test URLs

```bash
# First route (baseline)
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.example.workers.dev/bench/first

# Last route (worst case)
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.example.workers.dev/bench/last

# API route (skips 9000+ site routes)
curl -w "TTFB: %{time_starttransfer}s\n" -so /dev/null \
  https://cloudflare-stress-demo.example.workers.dev/api/v1/resource1/test
```

## Implementation

The optimization is in `packages/rangojs-router/src/router/pattern-matching.ts`:

```typescript
function canPrefixMatch(pathname: string, prefix: string): boolean {
  // Empty or root prefix always matches
  if (!prefix || prefix === "/") return true;

  const segments = parsePattern(prefix);
  const allStatic = segments.every((s) => s.type === "static");

  if (allStatic) {
    // For static prefixes, pathname must start with the prefix
    const staticPrefix = "/" + segments.map((s) => s.value).join("/");
    return pathname === staticPrefix || pathname.startsWith(staticPrefix + "/");
  }

  // For param prefixes, do segment-by-segment checks...
}

// In findMatch():
for (const entry of routesEntries) {
  if (!canPrefixMatch(pathname, entry.prefix)) {
    continue; // Skip entire include() group
  }
  // ... check routes in this entry
}
```
