# Prefetch/Cache Review Actions (Non-Test Runtime)

Scope reviewed:

- `src/browser/prefetch/fetch.ts`
- `src/browser/prefetch/queue.ts`
- `src/browser/prefetch/cache.ts`
- `src/browser/prefetch/observer.ts`
- `src/browser/prefetch/policy.ts`
- `src/browser/rango-state.ts`
- `src/browser/navigation-store.ts`
- `src/browser/react/use-router.ts`
- `src/browser/link-interceptor.ts`

## Findings

### F1 (Medium): Cross-origin prefetch is not blocked in router-level prefetch path

Files:

- `src/browser/react/use-router.ts:46-50`
- `src/browser/prefetch/fetch.ts:30,53-60`

`useRouter().prefetch(url)` forwards arbitrary URLs into `prefetchDirect()`. The prefetch fetch path then sends router-specific headers (`X-Rango-State`, `X-RSC-Router-Client-Path`, `X-Rango-Prefetch`) without enforcing same-origin. Link-based prefetch is guarded by `isExternal`, but router API prefetch is not.

Risk:

- Unexpected cross-origin network requests from app code.
- Router-internal headers can be sent to third-party origins when CORS permits.

### F2 (Medium): Invalid URL input can throw synchronously in prefetch

Files:

- `src/browser/prefetch/fetch.ts:30`
- call paths: `src/browser/react/use-router.ts:46-50`, `src/browser/react/Link.tsx:267-271,286-290`

`new URL(url, window.location.origin)` can throw. Prefetch is best-effort and should not throw into hover/effect/caller paths. Current behavior can create noisy runtime errors and brittle UI behavior when URL input is malformed.

### F3 (Low): Runtime informational logs are not debug-gated in store/interceptor

Files:

- `src/browser/navigation-store.ts:341,350,375,407,419,424,432,659`
- `src/browser/link-interceptor.ts:134,138`

Several routine logs use `console.log` directly in browser runtime flow, creating production console noise.

### F4 (Low): Prefetch policy result is cached permanently for session

Files:

- `src/browser/prefetch/policy.ts:14,41-43`

`shouldPrefetch()` memoizes once and does not react to runtime changes in reduced-data signals (save-data / media query changes). This is usually acceptable, but not ideal for long-lived tabs.

## Commit Plan

### Commit 1: Guard prefetch to same-origin http/https

Files:

- `src/browser/prefetch/fetch.ts`
- optionally `src/browser/react/use-router.ts` (defensive call-site guard)

Changes:

- Parse URL once in prefetch helpers and block if origin differs.
- Block non-http/https schemes explicitly.
- Skip silently (or debug-log only), never throw.

Tests to add:

- `prefetch-fetch.test.ts`: cross-origin URL is skipped.
- `prefetch-fetch.test.ts`: `javascript:` / `data:` URL is skipped.

### Commit 2: Make prefetch URL parsing non-throwing

Files:

- `src/browser/prefetch/fetch.ts`

Changes:

- Wrap URL construction in safe parsing helper returning `null` on invalid input.
- Ensure `prefetchDirect()` and `prefetchQueued()` no-op on invalid URL.

Tests to add:

- `prefetch-fetch.test.ts`: malformed URL does not throw and does not fetch.

### Commit 3: Logging hygiene (non-error logs)

Files:

- `src/browser/navigation-store.ts`
- `src/browser/link-interceptor.ts`

Changes:

- Route routine info logs through `debugLog` (keep warnings/errors explicit).

Tests to add:

- Optional unit assertions for no direct `console.log` in normal paths (if useful).

### Commit 4: Optional policy re-evaluation hook

Files:

- `src/browser/prefetch/policy.ts`

Changes (optional):

- Either keep current behavior and document as session-cached by design,
- or add an opt-in refresh/re-evaluate path on visibilitychange/mediaquery events.

Tests to add:

- Only if behavior changes.

## Suggested Execution Order

1. Commit 1 (same-origin + scheme guard)
2. Commit 2 (non-throwing prefetch input)
3. Commit 3 (log hygiene)
4. Commit 4 (optional behavior refinement)
