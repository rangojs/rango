# Vite Plugin Review (`@rangojs/router`)

## Findings

### 1) High: Dev watcher can overwrite runtime-complete route maps with partial static maps
- File: `packages/rangojs-router/src/vite/index.ts:964`
- File: `packages/rangojs-router/src/vite/index.ts:1186`
- What is happening:
  - On startup, dev mode writes combined route types with:
    - `writeCombinedRouteTypes(..., { preserveIfLarger: true })`
  - On file change, watcher calls:
    - `writeCombinedRouteTypes(projectRoot, cachedRouterFiles)`
    - without `preserveIfLarger`.
- Why this is risky:
  - Runtime discovery can include routes static parsing cannot see (dynamic loops, computed definitions).
  - A later watcher write can shrink `router.named-routes.gen.ts` and make routes appear “dropped” until rediscovery or next full build.
- User-facing impact:
  - Flaky route-type output in dev.
  - Intermittent autocomplete/type errors for valid routes.
  - Confusing diffs where generated files oscillate.
- Repro pattern:
  1. Start dev with a runtime-generated full map.
  2. Edit a route file that triggers watcher.
  3. Observe `router.named-routes.gen.ts` rewritten with fewer entries.
- Suggested fix:
  - Use the same guard in watcher path:
    - `writeCombinedRouteTypes(projectRoot, cachedRouterFiles, { preserveIfLarger: true })`
  - Optionally log when a shrink is prevented, so behavior is explicit.

### 2) Medium: Wildcard prerender params are not substituted when materializing URLs
- File: `packages/rangojs-router/src/vite/index.ts:768`
- File: `packages/rangojs-router/src/vite/index.ts:781`
- What is happening:
  - Dynamic route detection includes both `:` and `*`.
  - URL substitution only replaces `:${key}` tokens.
  - No replacement path for wildcard tokens (`*`, `*rest`, etc.).
- Why this is risky:
  - Prerender URL generation can emit unresolved wildcard patterns.
  - Those URLs can fail matching in `matchForPrerender`, reducing prerender coverage.
- User-facing impact:
  - Missing prerendered entries for wildcard routes.
  - Build logs may show pre-render attempts that silently skip or fail.
- Suggested fix:
  - Extend token replacement to support wildcard segments.
  - If wildcard naming conventions are fixed, handle both:
    - named splats (e.g. `*rest`)
    - anonymous splats (`*`)
  - Add a test route with wildcard + `getParams()` to protect against regressions.

### 3) Low: Dead variable in build prerender path (`routersByHash`)
- File: `packages/rangojs-router/src/vite/index.ts:806`
- What is happening:
  - `routersByHash` is built and populated but never read.
- Why this matters:
  - Increases cognitive overhead and suggests incomplete/legacy logic.
  - Makes future refactors riskier because intent is ambiguous.
- Suggested fix:
  - Remove `routersByHash` or wire it into actual lookup logic if intended.

## Open Questions
- Should watcher behavior prioritize stability over immediacy?
  - If yes, preserving larger files in watcher is the correct default.
  - If no, then route file shrinking should be intentional and logged.

## Overall
- Plugin architecture is strong and feature-rich (runtime discovery, per-router manifests, prerender pipeline).
- Main correctness concern is consistency between startup and watcher generation paths; that mismatch explains intermittent “route dropped” reports.
