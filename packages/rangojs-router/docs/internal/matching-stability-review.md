# Matching & Lazy-Discovery Stability Review (v1)

Date: 2026-06-07
Status: **pass 1 landed** — straightforward fixes + unified trie construction implemented and
verified; behavior-decision and heavier items tracked below.
Owner: router maintainers
Scope: render pipeline, route **matching**, and **lazy route `include()` discovery**, with the
explicit goal of proving dev/production matching is **stable for v1**.

This is a tracking doc. Each item has a status (`open` / `fixed` / `verified-safe` /
`deferred`) and a fix classification (`straightforward` / `moderate` / `needs-design`).
Straightforward items are implemented in the same pass and flipped to `fixed`.

## Pass 1 — landed (2026-06-07)

Implemented and verified (typecheck, 3367 unit tests, oxlint, oxfmt, `build-router`, and
`route-resolution` e2e in **both** dev (18) and production (10)):

- **C1** — trie now matches a bare wildcard prefix (`/files` → `/files/*` with `*=""`),
  killing the corrupt `/files`→`/file` regex-fallback redirect. (`trie-matching.ts`;
  regression tests in `trie-matching.test.ts`.)
- **C5** — nested-include join normalized via a shared `joinPrefix`, fixing the
  `/parent//child` double slash. Applied to **both** the nested-placeholder
  `staticPrefix` (which fed the trie-`sp` mismatch that forced the regex fallback) **and**
  the handler-run prefix in `evaluateLazyEntry`/`loadManifest` (so the registered route
  patterns in `entry.routes`/`reverse()`/`EntryData.pattern`/`mountPath` are normalized too).
  (`pattern-matching.ts` `joinPrefix`, used in `lazy-includes.ts`, `manifest.ts`, `router.ts`;
  regression tests in `lazy-include-isolation.test.ts` + `pattern-matching.test.ts`.)
- **C7** — `createFindMatch` cache hit now returns a clone with an independent `params`, so a
  handler mutating `ctx.params` can't corrupt the shared single-entry cache. (`find-match.ts`;
  regression test in `find-match.test.ts`.)
- **R1 + R2** — dev and production now build the per-router trie through **one** shared
  `buildPerRouterTrie(manifest)` (`build/route-trie.ts`); the pure prefix-tree walks moved to
  `build/prefix-tree-utils.ts` (re-exported from `vite/utils/manifest-utils.ts`). The dev
  inline `visitPrefixNode` is gone. This structurally removes the dev/prod trie-drift hazard.
  Pinned by the new `dev-prod-trie-parity.test.ts` (dev trie === prod router-0 trie; multi-
  router differs only in debug-only `leaf.a`).
- **R3** — Phase-2 regex fallback now emits a dev-only warning if it resolves a real match
  while the trie was present (signals a trie gap); paired with the new
  `trie-regex-parity.test.ts`. (`find-match.ts`.)
- **R4** — removed the dead `ancestry` field from `TrieMatchResult`/`RouteMatchResult` and the
  find-match remap (kept `leaf.a` + `extractAncestryFromTrie` for the debug endpoint).
- **R5** — removed the unused `getRouteTrie` import in `find-match.ts`.
- **C11/C12/C13** — new stability tests: trie↔regex parity, dev↔prod trie equality, and
  `createFindMatch` unit coverage (cache clone, recompute, MAX_LAZY_ITERATIONS cap).

Remaining work is in the sections below (behavior nuance C3; defense-in-depth
C4/C6/C9/C10; e2e prod-coverage gaps C16/C17/C18; needs-design R9/R11 and lazy-include
LP1/LP3/LP4; `optionalParams` removal). C2/M3 (trailing slash) and C8/LP2 (dev
precomputed entries) are closed/done — see their sections. None are regressions from
pass 1.

## Pass 2 — landed (2026-06-08)

A follow-up adversarial audit (6 skeptic lenses, refute-by-default verification) confirmed
LP1/LP3/LP4 are genuinely correctness-neutral (see their sections) and surfaced **one**
real correctness bug that the pass-1 work had not covered:

- **C19 — precomputed shared-staticPrefix collapse (500 on a valid sibling route).**
  `getPrecomputedByPrefix` (`router.ts`) built its lookup as
  `new Map(entries.map(e => [e.staticPrefix, e.routes]))`. Two **distinct** leaf includes can
  legitimately share a `staticPrefix` when a dynamic param collapses their literal prefixes
  onto the same value — e.g. `include("/shop/:cat", ...)` and a nested
  `include("/shop/:brand", ...)` both extract `"/shop"` (verified: `generateManifestFull`
  emits two `"/shop"` leaf entries). The `Map` constructor is last-wins, so one include's
  routes were silently dropped and the survivor's routes mis-assigned to whichever lazy
  entry evaluated first. The `prefixIsShared` guard in `evaluateLazyEntry` did **not** save
  it: that guard counts live `routesEntries`, which cannot see a nested sibling not yet
  spliced (timing-blind). Net effect: `findMatch` selects the wrong include's entry (its
  corrupted `routes` contain the sibling's key), then `loadManifest` runs the wrong handler
  and fails its `Store.manifest.has(routeKey)` invariant → `RouteNotFoundError`/500 on a
  valid route, **identical in dev and production**. This branch had zero coverage (every
  unit test passed `getPrecomputedByPrefix: () => null`).
  - **Fix:** new `buildPrecomputedByPrefix(entries)` in `build/prefix-tree-utils.ts` — any
    `staticPrefix` owned by more than one leaf include is **omitted** from the shortcut
    (not collapsed, not merged), so those includes resolve via the handler path (ground
    truth, identical to pre-precomputed behavior). The shortcut is purely an optimization,
    so dropping a prefix can only cost a handler run, never change a result. Wired into
    `router.ts`; the `prefixIsShared` comment in `lazy-includes.ts` was updated to record
    that the load-bearing protection now lives upstream and the live-count guard is
    timing-blind defense-in-depth only.
  - **Tests:** `router/__tests__/precomputed-prefix-collision.test.ts` pins (a) the real
    config emits duplicate-`staticPrefix` leaves, (b) naive collapse loses routes while
    `buildPrecomputedByPrefix` omits the shared prefix and keeps unshared ones, and (c) the
    runtime consequence via `evaluateLazyEntry` — old collapse mis-assigns the sibling's
    routes, the fix runs the handler and registers the entry's own routes.

## Why this review exists

The router has two matching code paths and two trie-construction code paths that must
agree across dev and production:

- **Match paths** — Phase 1 trie (`src/router/trie-matching.ts`), Phase 2 regex fallback
  (`src/router/pattern-matching.ts` `findMatch`), orchestrated by
  `src/router/find-match.ts` `createFindMatch`.
- **Trie construction** — _production_ serializes the build-time trie
  (`src/vite/discovery/discover-routers.ts` → `generateManifestFull` → `buildRouteTrie`,
  serialized via `src/vite/discovery/virtual-module-codegen.ts`); _dev_ rebuilds the trie
  per request from live `router.urlpatterns`
  (`src/rsc/manifest-init.ts` `buildRouterTrieFromUrlpatterns`).

Both modes feed the **same runtime matcher**. Any behavioral difference between the two
trie constructions, or between the trie matcher and the regex fallback, is a dev/prod
stability risk. Lazy `include()` discovery adds a third axis: leaf includes are
build-precomputed, nested includes are discovered at runtime in **both** modes and must
stay symmetric.

## The dev/prod contract (reference)

| Concern                                 | Dev                                                          | Production                                                  |
| --------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Trie source                             | rebuilt per request from `urlpatterns` (`manifest-init.ts`)  | serialized JSON chunk, loaded via `ensureRouterManifest`    |
| `generateManifestFull` `mountIndex` arg | `undefined` → default `0` (every router)                     | global counter `0,1,2…` (per router, `discover-routers.ts`) |
| `routeToStaticPrefix` builder           | inline `visitPrefixNode` (`manifest-init.ts`)                | `buildRouteToStaticPrefix` (`manifest-utils.ts`)            |
| Precomputed leaf entries                | discovery in-memory / rebuilt                                | serialized `precomputedEntries`                             |
| Nested lazy includes                    | runtime `evaluateLazyEntry`                                  | runtime `evaluateLazyEntry` (same code)                     |
| `routesEntries` (regex fallback)        | `Rango.routes()` walk at init                                | `Rango.routes()` walk at init                               |
| Regex fallback reachability             | reachable in the window after HMR before the trie is rebuilt | effectively unreachable (trie always present)               |
| Runtime `mountIndex` per router         | per-router-local `let mountIndex = 0` (`router.ts:264`)      | per-router-local `let mountIndex = 0` (same)                |

## Findings

Severity legend: critical (matching/render incorrect), high (observable in a supported
config), medium (latent or narrow), low (cleanup / drift hazard), none (verified safe).

### M1 — `buildRouteToStaticPrefix` duplicated inline in the dev trie builder

- Status: `open` · Severity: low · Class: dev/prod drift hazard · Fix: **straightforward**
- `src/rsc/manifest-init.ts:53-66` reimplements `buildRouteToStaticPrefix`
  (`src/vite/utils/manifest-utils.ts:59-75`) as an inline `visitPrefixNode` walk. The
  build path calls the shared helper; the dev path hand-rolls the same logic.
- **Verified behaviorally identical today** (both init all routes to `""`, then walk the
  prefix tree setting each node's routes to `node.staticPrefix`, recursing children). So
  this is not a live divergence — it is a drift hazard: a future change to one copy
  silently desyncs the dev and prod `routeToStaticPrefix`, which feeds the trie's `sp`
  used by `find-match.ts` entry resolution.
- Fix: import and call `buildRouteToStaticPrefix` from `manifest-init.ts`; delete the
  inline walk. Single source of truth for `sp`.

### M2 — `mountIndex` differs build (global) vs runtime (per-router); only feeds dead `leaf.a`

- Status: `open` · Severity: low · Class: latent landmine + bundle bloat · Fix: needs-design (note only)
- Build assigns a **global** `routerMountIndex` (`discover-routers.ts`, `0,1,2…`) as the
  starting `mountIndex` to each router's `generateManifestFull`; runtime assigns a
  **per-router-local** `let mountIndex = 0` (`router.ts:264`). For the 2nd+ router in a
  multi-router/host setup, the serialized trie's ancestry shortcodes (`leaf.a`, e.g.
  `M1L0…`) do not match the render-time shortcodes (`M0L0…`).
- **Verified NOT a live matching/render bug**: `leaf.a` flows only into
  `RouteMatchResult.ancestry` (`find-match.ts:117`, `trie-matching.ts:232`) which is
  **never read** anywhere outside the `__debug_manifest` endpoint
  (`handler.ts:578` via `extractAncestryFromTrie`). Real layout pruning is by segment-ID
  prefix at render time (`segment-system.tsx`), self-consistent within each mode.
- Consequences today: (a) the dead `a:[...]` array is serialized into every production
  per-router chunk (bundle bloat, JSON parse cost); (b) the dev `__debug_manifest`
  ancestry differs from prod's for multi-router; (c) a future consumer of
  `matched.ancestry` would silently break multi-router prod.
- Options: drop `leaf.a` from the serialized trie and recompute on demand for the debug
  endpoint; OR make runtime `mountIndex` consistent with build (stable per-router key, not
  eval-order counter — ties into the existing `router_N` auto-id warning). Track; do not
  rush a semantics change before v1.

### Empirical parity evidence (trie vs regex)

A throwaway diagnostic drove `tryTrieMatch` and the regex `findMatch` over the same route
set + URL matrix. **5 confirmed divergences**, all latent (the trie is always the active
matcher — see below):

| Case                                                                    | Trie result          | Regex result                                      |
| ----------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| param `/docs/:slug` declared before static `/docs/new`, url `/docs/new` | `stat` (specificity) | `param`, `{slug:new}` (definition order) — **M4** |
| wildcard `/api/*` before `/api/health`, url `/api/health`               | `specific`           | `any`, `{*:health}` — **M4**                      |
| route `/foo` (no `ts` mode), url `/foo/`                                | match, no redirect   | match, redirect→`/foo` — **M3**                   |
| route `/foo/` (no `ts` mode), url `/foo`                                | match, no redirect   | match, redirect→`/foo/` — **M3**                  |
| `/:locale?`, url `/shop/` (i.e. `/x/`)                                  | match, no redirect   | match, redirect→strip slash — **M3**              |

Confirmed **agreements** (no divergence): static-before-param, optional-middle +
required-tail, suffix params (`:id.html`), `ts` modes `ignore`/`always`/`never`,
only-optional root. The optional-middle regression (`trie-matching.test.ts:172`) holds.

**Why latent:** in dev the handler rebuilds the trie before `findMatch` (`handler.ts:413`);
in prod `ensureRouterManifest` loads it before any match. So the regex fallback is never
the active matcher for routes that exist in the manifest — it returns the same null a
trie miss does. The divergence is only reachable if the trie is absent at match time
(a should-not-happen window). Both dev and prod therefore match **via the same trie**,
which is the actual v1 stability guarantee.

### M3 — trie ignores the PATTERN-implicit trailing slash (explicit modes already work) — NOT a v1 issue

- Status: `closed` (not actionable) · Severity: low · Class: latent-fallback-only
- **Trailing slash is already a complete, configurable feature.** The explicit modes —
  `path(..., { trailingSlash: "never"|"always"|"ignore" })` and the same option on
  `include(...)` (`urls/pattern-types.ts:47`) — are stored as `leaf.ts` and honored by the
  trie (`validateAndBuild` redirects for `always`/`never`). The `route-resolution`
  `trailing-slash-config` e2e proves all three modes behave correctly and **identically in
  dev and production**. There is no `createRouter({ trailingSlash })` router-level option;
  config is per-path / per-include, collected per-router.
- The only residual: the trie build (`route-trie.ts:85-86`) normalizes the pattern's own
  trailing slash away and stores only the explicit `leaf.ts` mode — it does **not** keep the
  pattern-implicit slash. The regex fallback does (`pattern-matching.ts:623`), so with **no
  explicit mode** the regex would canonicalize `path("/foo/")` while the trie serves both
  forms. Since the trie is the live matcher in **both** dev and prod, behavior is consistent;
  the regex fallback is never reached for manifest routes; and a consumer who wants
  canonicalization sets the explicit mode (which works). So this is **not a stability bug, not
  a dev/prod divergence, and not an open product decision** — it was over-flagged in the
  initial pass. If we ever want pattern-implicit canonicalization in the trie too, it's a small
  additive change (carry a `tts` flag on the leaf), but it is optional polish, not v1 work.

### M4 — trie (specificity) vs regex (definition-order) precedence models

- Status: `open` (empirically confirmed) · Severity: medium · Class: latent-fallback-only · Fix: needs-design
- Trie enforces `static > suffix-param > param > wildcard` with backtracking (`walkTrie`);
  regex iterates `routesEntries`/`Object.entries(routes)` in **definition order**
  (`pattern-matching.ts:424-455`). The `handler.ts:411-412` comment already documents the
  regex path as deficient ("catch-all patterns match before specific routes") — which is
  exactly why the trie exists. The trie is therefore the **canonical** precedence model.
- v1 recommendation: codify "trie precedence is canonical; the regex path is a best-effort
  net that is not reached for manifest routes in normal operation." Add a dev-only warning
  if the regex fallback ever resolves a real match (signals the trie was unexpectedly
  absent), and add the M6 parity test for the cases that _do_ agree so they don't regress.
  Re-sorting the regex path by specificity is possible but is dead-weight complexity for a
  path that should never be the active matcher — prefer the guard-rail over the rewrite.

### M5 — `findMatch` single-entry cache lifetime / staleness

- Status: `open` · Severity: TBD · Class: TBD · Fix: TBD
- `createFindMatch` (`find-match.ts:21-28`) holds `lastFindMatchPathname` /
  `lastFindMatchResult` for the lifetime of the closure (created once per router). Open
  questions under adversarial verification: (a) is the cached `RouteMatchResult` a shared
  mutable object handed to concurrent same-path requests; (b) after dev HMR + trie rebuild
  - `routesEntries` rebuild, can a stale entry be returned (nothing clears this cache —
    `clearManifestCache` does not touch it). Prod is unaffected (routes are immutable).
- Pending workflow verdict.

### M6 — no systematic trie-vs-regex parity test

- Status: `open` · Severity: medium (coverage) · Class: test-gap · Fix: straightforward
- Parity is pinned only case-by-case (e.g. the optional-middle-params regression,
  `trie-matching.test.ts:172-240`). There is no property/table test that runs a route set
  through **both** matchers and asserts identical `(routeKey, params, redirectTo, flags)`.
- Add a unit test that, for a fixed matrix of patterns (static, param, optional, multiple
  optionals + required tail, constrained, suffix `:id.html`, wildcard, trailing-slash
  variants) and probe URLs, asserts `tryTrieMatch` and the regex `findMatch` agree. This
  directly serves "prove dev/prod matching is stable."

### M7 — dev/prod e2e bucketing gaps for matching-relevant suites

- Status: `open` · Severity: medium (coverage) · Class: test-gap · Fix: straightforward
- `route-resolution.test.ts` dev block has a `nested-routes` describe (line 187) with **no
  `(production)` counterpart** — violates the CLAUDE.md dev+prod mandate.
- Dev-only suites with no build fixture (candidate gaps; confirm whether covered in
  cloudflare-basic / vite-rsc-demo before adding): `include-middleware.test.ts`,
  `same-route-nav.test.ts`, `navigation-hooks.test.ts`, `navigation-loading.test.ts`.
  (HMR suites — `intercept-hmr`, `prerender-hmr`, `route-types-hmr` — are legitimately
  dev-only.)
- Several `prerender-*` suites show build fixtures but 0 literal `(production)` tags; these
  likely use a `prodDescribe`/helper that the static grep misses. Confirm against
  `pnpm check:e2e-bucketing` (CI guard) before treating as gaps.

## Verified-safe (negative results)

- `buildRouterTrieFromUrlpatterns` passing `mountIndex: undefined` is **not** a
  single-router divergence — it hits `generateManifestFull`'s default `= 0`, matching prod's
  router-0 index. (Multi-router caveat is M2, and even there only `leaf.a` is affected.)
- Dev and prod use the **same** `parsePattern` / `buildRouteTrie` for trie construction
  (both import from `src/router/pattern-matching.ts` and `src/build/route-trie.ts`); the
  trie _shape_ is built by identical code in both modes.
- Nested lazy include discovery runs the **same** `evaluateLazyEntry` code at runtime in
  both dev and prod (not build-serialized), so it is structurally symmetric.

## Refactors (refactor-review workflow, adversarially verified)

A second multi-agent review (5 lenses → dedup → 3 lenses per proposal: behavior-preservation
/ load-bearing / value-vs-risk) produced 12 recommended refactors (18 canonical, 6
not-recommended). Reconciled with the stability findings and triaged for this pass:

**Implement now (behavior-preserving, low risk, stability value):**

- **R1 `unify-per-router-trie-construction`** (3/3/3, high value) — extract one
  `buildPerRouterTrie(manifest, mountIndex?)` into `src/build/route-trie.ts` used by **both**
  dev (`manifest-init.ts`) and prod (`discover-routers.ts`). This collapses the two
  trie-construction code paths into one — the single highest-value structural fix for the
  dev/prod-divergence goal (a future change can no longer desync the two). Depends on R2.
- **R2 `consolidate-build-route-to-static-prefix`** (M1, 3/2/3, high value) — relocate the
  pure `buildRouteToStaticPrefix` (and `flattenLeafEntries`) from `src/vite/utils/manifest-utils.ts`
  to a neutral `src/build/` module both layers import; re-export from `manifest-utils.ts` so
  vite-side imports are unchanged; delete the inline `visitPrefixNode` copy in `manifest-init.ts`.
  Keeps `jsonParseExpression` in `vite/utils` (genuinely codegen-only). Respects
  `api-boundary-policy.md` (runtime no longer imports from `vite/`).
- **R3 `phase2-regex-fallback-dev-guard-and-parity`** (M4/M6, 3/3/3, high value) — do **not**
  delete Phase 2 for v1; instead (a) emit a dev-only `console.warn` (folded out in prod) when
  the trie was present but the regex fallback resolved a real non-lazy match (signals an
  unexpected trie-absent window), and (b) add a committed trie-vs-regex parity test over the
  agreeing matrix so the stable surface can't regress.
- **R4 `remove-dead-match-result-ancestry`** (M2, 3/3/3, safe-mechanical) — delete the unread
  `ancestry` field from `TrieMatchResult`/`RouteMatchResult` and the `find-match.ts:117` copy.
  Keep `TrieLeaf.a` + `extractAncestryFromTrie` (debug endpoint reads them off the trie, not
  the match result). Verified zero readers.
- **R5 `remove-unused-getroutetrie-import`** (3/3/2, safe-mechanical) — drop the unused
  `getRouteTrie` import in `find-match.ts:2` (still exported/used elsewhere).

**Implement if clean (behavior-preserving, quality — lower priority):**

- **R6 `extract-shared-lazy-handler-invocation`** (3/3/3) — a `runLazyHandler(entry, lazyContext, run)`
  shared by `evaluateLazyEntry` (`lazy-includes.ts`) and `loadManifest` (`manifest.ts`); both
  compute `fullPrefix` + dispatch through `runWithPrefixes` identically today.
- **R7 `collapse-findmatch-trailing-slash-branches`** (3/3/3) — extract a pure
  `resolveTrailingSlashRedirect(...)` decision table + a single result constructor in
  `pattern-matching.ts`, replacing the 8-return branch tree.
- **R8 `dedup-findlazyincludes-descriptor-shape`** (3/3/3, safe-mechanical) — one named
  `LazyIncludeDescriptor` interface instead of the thrice-inlined object literal.

**Defer / needs-design (track; get sign-off before changing behavior):**

- **R9 `stop-serializing-trie-leaf-ancestry`** (needs-design, 1/3 behavior-preserving) — strip
  `leaf.a` from prod chunks (~bytes/route) and source debug ancestry from the build manifest.
  Contentious (multi-router debug symmetry); pair with the M2 mountIndex note. Defer.
- **R10 = M3** `trie-canonical-trailing-slash-no-ts-mode` — **closed** (see M3): trailing
  slash is configurable per-path/include and works dev/prod; pattern-implicit
  canonicalization in the trie is optional future polish, not a v1 decision.
- **R11 = M5** `harden-find-match-cache-mutation-and-hmr` — stop mutating the shared cached
  `matched.pt` (`match-api.ts:89/231`) and invalidate the `createFindMatch` single-entry cache
  on dev HMR. Confirmed the mutation + cross-request cache sharing are real; needs a careful
  design (read `snapshot.isPassthrough` instead of mutating, + a `reset()` hook). Defer.
- **`optionalParams` removal** — `RouteMatchResult.optionalParams` is written 3× and never read
  in `src/` (only tests assert it). Removing the trie-path copy alone would _increase_
  divergence; the clean removal is all-or-nothing across both result types + ~5 test files.
  Defer to a dedicated cleanup to keep this stability pass focused.

**Not recommended (rejected by verification):** full `entry`/`sp` match-result merge (0/3 worth),
flatten find-match entry-resolution (0/3 worth), centralize pattern trailing-slash strip (1/3),
trie-key legend docs (0/3), and two no-change confirmations (match-debug exports + runtime→build
type dep are intentional/sound).

## Correctness findings (parity workflow, adversarially verified)

6-dimension review → dedup → 3 skeptic lenses per finding: **18 confirmed, 5 rejected, 9
verified-safe**. Vote tallies in brackets are (real / parity).

### Confirmed real bugs (fix)

- **C1 `trie-bare-wildcard-prefix-corrupt-redirect`** — HIGH, general-correctness [3/3,3/3],
  fix=moderate. `walkTrie` only consults `node.w` inside the `index < segments.length` body
  (`trie-matching.ts:147`), so a wildcard whose parent node is reached with **zero** remaining
  segments is never matched. `/files` against `/files/*` (no `/files` index) → trie returns
  null → regex fallback → no-config branch computes `canonical = "/files".slice(0,-1)` →
  **308 redirect to `/file`** (corrupt). Identical dev and prod. Same gap makes `/*` not match
  `/`. (`/files/` serves fine — only the bare prefix is corrupt.) **Fix:** in `walkTrie`, when
  `index === segments.length` and `node.r` is absent, also return `node.w` with empty
  wildcard value (matching the regex `*=''`). **Generalization (intended):** this also makes a
  PARAM-prefixed wildcard match its bare prefix — `/users/:id/*` matches `/users/5` with
  `{ id:"5", *:"" }` (zero-or-more splat, like React Router); a static/param terminal at that
  node still wins. Covered by `trie-matching.test.ts` ("param-prefixed wildcard at its bare prefix").
- **C5 `nested-include-double-slash-staticprefix-forces-regex`** — LOW, general-correctness
  [3/3,0/3], fix=straightforward. `include('/parent/', …)` (trailing slash) with a nested
  `include('/child', …)` produces a runtime nested-entry `staticPrefix` of `/parent//child`
  (double slash, `lazy-includes.ts:194`, `router.ts:836`) while the trie `sp` is
  `/parent/child`; `find-match.ts:73` can't match `trieResult.sp` to the entry, silently
  forcing the regex fallback. **Fix:** normalize the slash join at both sites (mirror
  `runWithPrefixes`/`include-helper.ts`): if `urlPrefix.endsWith('/') && prefix.startsWith('/')`
  join with `prefix.slice(1)`. Route both through one shared `joinPrefix()` helper.
- **C7 `findmatch-cache-shared-mutable-result`** — LOW, general-correctness [3/3,0/3],
  fix=straightforward. The `createFindMatch` single-entry cache returns the **same**
  `RouteMatchResult` object to every same-pathname request; `ctx.params` aliases its `params`
  (`handler.ts:764`, `request-context.ts:419`). `matched.pt` mutation (`match-api.ts:89/231`)
  is idempotent (benign), but userland mutating `ctx.params` would corrupt the cache for
  concurrent/subsequent same-path requests. **Fix:** on cache hit return a shallow clone with
  a copied `params` object. (This is the live half of **M5**; the HMR-staleness half was
  _rejected_ — `createFindMatch` re-evaluates on HMR module reload, so no stale closure.)

### Confirmed but latent / defense-in-depth (track)

- **C2 = M3** `trie-trailing-slash-no-config-no-redirect` — **closed** (non-issue). See M3.
- **C3 `trie-splat-strips-trailing-slash`** — LOW [3/3,1/3]. `/files/a/b/` → trie `*=a/b`,
  regex `*=a/b/`. Trie strips the trailing slash before walking (`trie-matching.ts:49`).
  Latent (trie is live in both modes → dev/prod agree at `a/b`); it's a splat-semantics
  decision. Track with M3.
- **C4 = M4** `trie-regex-precedence-divergence-latent` — LOW, latent. R3 guard covers it; the
  regex-specificity-sort is optional defense-in-depth.
- **C6 `content-negotiation-flags-absent-on-regex-fallback`** — LOW, latent. The regex fallback
  can't reproduce `negotiateVariants`/`rscFirst` (trie-leaf-only). Defense-in-depth; R3 guard
  reduces reachability. Track.
- **C8 `dev-lacks-precomputed-entries-always-handler-path`** — **DONE (LP2).**
  `buildRouterTrieFromUrlpatterns` now calls `setRouterPrecomputedEntries` via
  `flattenLeafEntries`, so dev/Cloudflare exercises the same precomputed-shortcut branch
  as prod (`evaluateLazyEntry` no longer re-runs the handler for leaf includes at match
  time). Pinned by Part C of `lazy-include-perf.test.ts`.
- **C9 `route-name-conflict-warn-only-on-handler-path`** — LOW [3/3,2/3], straightforward. Add
  the same conflict `console.warn` to the precomputed-shortcut branch (`lazy-includes.ts:99`)
  for diagnostic symmetry. Optional.
- **C10 `max-lazy-iterations-fallback-only`** — LOW, latent. Cap only reachable on the regex
  path; same outcome dev/prod. Optionally route the cap-hit through `router.onError`.

### Confirmed test gaps (add tests — these _prove_ stability)

- **C11 `trie-regex-parity-test-gap`** — HIGH [3/3,3/3]. No test asserts the two matchers agree.
  Add `trie-regex-parity.test.ts` (= R3 part b).
- **C12 `dev-prod-trie-equality-test-gap`** — HIGH [3/3,1/3]. No test pins the dev rebuilt trie
  against the prod serialized trie. Add a unit test reproducing both construction paths for a
  non-trivial tree, asserting structural trie equality (after stripping `leaf.a`) + match
  agreement. **Most goal-relevant test.**
- **C13 `findmatch-unit-test-gap`** — MEDIUM [3/3,0/3]. No `createFindMatch` unit test
  (cache reuse, fallbackEntry selection, MAX_LAZY_ITERATIONS). Add `find-match.test.ts`.
- **C14 `lazy-include-shortcut-unit-test-gap`** — LOW. `lazy-include-isolation.test.ts` always
  passes `getPrecomputedByPrefix: () => null`; the shortcut + `prefixIsShared` guard are
  untested. Add coverage.
- **C15 `per-router-manifest-test-replica-drift`** — LOW. `per-router-manifest.test.ts` has
  drifted _replicas_ of `flattenLeafEntries`/`buildRouteToStaticPrefix` (missing the #506
  guard). Replace with imports of the real helpers (aligns with R2).
- **C16 `include-middleware-test-dev-only`** — MEDIUM, dev-only. Add a `(production)` sibling
  describe (fixtures already exist).
- **C17 `nested-lazy-include-prod-match-e2e-gap`** — MEDIUM [2/3]. The prod sibling tests only
  `reverse()`, not the URL match/render of a nested lazy include. Add a prod `goto('/href/nested')`
  render assertion.
- **C18 `trie-default-trailing-slash-e2e-gap`** — LOW. Depends on the M3 decision; then assert
  the actual URL outcome for `/blog/` in both modes.

### Rejected (false alarms)

- `overlapping-suffix-params-order-divergence` [1/3] — parse-invalid repro.
- `findmatch-cache-not-invalidated-on-hmr` [1/3] — HMR re-evaluates the module → new closure;
  no stale cache. (Narrows M5 to C7.)
- `multi-router-auto-id-coverage-gap` [1/3] — a dedicated multi-router app exists.
- `wildcard-suffix-e2e-gap` [0/3], `nested-include-collapse-506-e2e-gap` [0/3] — fixtures exist.

### Verified-safe negatives (corroborate the independent analysis)

`trie-ancestry-mountindex-dead` (M2 confirmed), `route-to-static-prefix-dev-prod-identical`
(M1 confirmed), `generate-manifest-option-diffs-harmless`, `trie-json-roundtrip-lossless`,
`precomputed-shortcut-vs-handler-route-ownership-identical`,
`nested-lazy-mountindex-request-order-inert`, `pe-js-share-match-loadmanifest`,
`notfound-path-and-dev-trie-rebuild-gate-safe`, `find-match-per-router-trie-isolation-safe`.

## Implementation plan (this pass)

**Code fixes (straightforward/verified, low risk):** C1 (trie bare-wildcard), C5 (double-slash
join), C7 (cache params clone), R4 (remove dead `ancestry`), R5 (drop unused import),
R2 (consolidate `buildRouteToStaticPrefix` → `build/`), R1 (`buildPerRouterTrie` shared by
dev+prod), R3 (Phase-2 dev-guard). (C8/LP2 dev precomputed entries landed separately in
`manifest-init.ts`; the LP1 handler-identity cache key was attempted then reverted — see LP1.)

**Tests (prove stability):** C11 trie↔regex parity, C12 dev↔prod trie equality, C13 findMatch
unit, C15 replica de-drift, plus C1/C5 regressions; C16/C17 e2e prod siblings.

**Deferred (needs-design / sign-off):** C2/M3 + C3 + C18 (trailing-slash & splat semantics —
behavior decision), C4/C6 (regex-fallback defense-in-depth), R9 (stop serializing `leaf.a`),
`optionalParams` removal, C9/C10 (minor diagnostics).

## Next actions

1. Merge workflow-verified findings; reconcile with M1–M7.
2. Implement straightforward items (M1, M6, M7) with dev+prod coverage.
3. Precedence contract (M4) — codify trie-as-canonical (done via R3 guard). Trailing
   slash (M3) is closed: explicit per-path/include modes already work consistently dev/prod;
   no v1 decision needed.
4. Resolve M5 cache lifetime once verified.
5. Re-run typecheck, unit, lint, format, and the semantic matrix before any push.

## Lazy include() performance audit (2026-06-07)

A 5-lens adversarial review (122 agents) plus a direct instrumentation test
(`src/router/__tests__/lazy-include-perf.test.ts`, which counts handler
executions across the lifecycle) answered: **is lazy include() beneficial, and
is the implementation efficient?**

**Verdict: lazy-by-default is the correct design and is beneficial — at boot,
not per-request — and is efficient on the warm path.**

- Confirmed (measured): defining `urls()` does not run the handler; `include()`
  captures the patterns by reference (include-helper.ts:146) and does NOT run
  them; `Rango.routes()` runs only the **top-level** handler once (router.ts:741)
  and creates empty lazy placeholder entries. Nested include handlers run **zero
  times** at construction. An unmatched include's handler **never runs**. Warm
  requests run **zero** handlers (manifest cache). The eager-metadata guarantees
  (trie/reverse/types/prerender) are built at **build** time, so runtime laziness
  does not regress them. The boot win is "fewer module-body executions" (1 vs
  1+N), not "fewer per-request executions".

> Outcome of this audit: **LP2 fixed** (dev now precomputes leaf entries). LP1
> (handler runs once per route, not per include) was attempted via a
> handler-identity cache key but that **thrashes** under `forRoute` pruning, so it
> was **reverted and deferred** (needs an unpruned-cache + prune-on-read design).
> LP3/LP4 deferred (needs-design). Separately, the C5 trailing-slash join fix was
> **completed** to also cover the handler-run prefix (not just the placeholder
> staticPrefix) so nested includes under a trailing-slash parent register
> normalized route patterns.

### LP1 — an include with M routes runs its handler once per route on cold start — MEASURED, DEFERRED (not worth it)

- **What.** `loadManifest` builds a manifest **pruned to `forRoute=routeKey`** —
  `path-helper.ts:153` skips registering every route except the matched one — and
  `manifestModuleCache` is keyed by `routeKey`. So an include with M routes runs its
  handler M times across the isolate's life (once per sibling route, each cached
  after its first request) instead of once.
- **Measured cost** (`lazy-include-cost.bench.ts`, LP1 benches): for a **30-route**
  include, warming **all** 30 routes from cold costs ~0.6–0.8 ms (the 30 handler
  runs) vs. ~40–60 µs for re-hitting them (all cache hits) — i.e. the warm steady
  state is **~20× cheaper**. The waste is **~20–25 µs/route, paid once per route per
  isolate** and amortized to zero. That is the worst case (every route hit); most
  includes have few routes and most routes are hit rarely.
- **Why not fixed.** A handler-identity cache key (dropping `routeKey`) is NOT the
  fix — it is a **regression**: each cached manifest is pruned to one route, so a
  sibling request misses, rebuilds, and overwrites the entry → alternating siblings
  **thrash** (re-run every time), strictly worse. (Tried and reverted; a unit test
  masked it by running `loadManifest` without `forRoute`.) The real fix is an
  **unpruned manifest cache with prune-on-read** — a deeper change to the pruning
  interaction. **Risk ≫ reward** for a ~20-µs/route, amortizes-to-zero cold-start
  cost. Deferred as a documented decision. Tracked as `it.todo` (LP1) in
  `lazy-include-perf.test.ts`. Current behavior is correct, just not minimal.

### LP2 — dev/Cloudflare lacked precomputed entries (double match+render run) — FIXED (C8)

- `buildRouterTrieFromUrlpatterns` (dev/HMR trie rebuild) now also computes
  per-router precomputed leaf entries via `flattenLeafEntries`, so the match-time
  shortcut in `evaluateLazyEntry` applies in dev too — collapsing leaf-include
  first-request handler runs from 2 (match + render) to 1, matching production.
  Behavior-preserving (verified-safe negative: precomputed and handler paths
  produce identical route ownership). Pinned by Part C of the perf test.

### LP3 — double handler execution (match + render) for non-leaf includes — MEASURED, DEFERRED (not worth it)

- **Scope (narrowed by measurement).** The common case is already 1 run: leaf
  includes are precomputed (`flattenLeafEntries`), so `evaluateLazyEntry` takes the
  shortcut and only `loadManifest` runs the handler (this is C8/LP2). The residual
  double-run is a **non-leaf include's direct routes** — a module with `path()`
  routes alongside a nested `include()` is never precomputed (it has children), so
  its handler runs at match-time (`evaluateLazyEntry`, to populate `entry.routes`
  AND discover the nested include) AND render-time (`loadManifest`). The match-time
  EntryData build is discarded; only the routes are kept.
- **Measured cost** (`src/router/__tests__/lazy-include-cost.bench.ts`, run
  `vitest bench lazy-include-cost`): the redundant match run is **~0.75 µs/route**
  (~7 µs for a 5-route include, ~39 µs for 50 routes) — about **50% of the
  manifest-build time**, but manifest-build is itself microseconds and a real RSC
  first request (render + Flight + SSR) is milliseconds, so the waste is **well
  under 0.5% of a cold first request**. It is paid **once per route per isolate**
  and **amortizes to ~0** (warm `loadManifest` cache hit is ~0.8–1.8 µs).
- **Why not fixed.** You cannot skip the match run (nested-include discovery needs
  it — the nested handler reference only exists once the parent handler runs, so it
  cannot be serialized at build time). You cannot skip the render run (the
  match-time tree is built in a throwaway `"lazy"` namespace **without `isSSR`** —
  which is not even known at match time). Reusing the match-time tree for render
  therefore requires splitting `isSSR`-dependent state out of the cached tree — that
  is the **LP4 refactor**, touching shortCodes and the semantic matrix. **Risk ≫
  reward** for a sub-microsecond-per-route, amortizes-to-zero cold-start cost.
  Deferred as a documented decision, not planned work. Distinct from LP1 (the
  per-sibling-route re-runs), also deferred — see LP1.

### LP4 — isSSR doubles cold first-request handler runs for document loads — MEASURED, DEFERRED (not worth it)

- **What.** A cold document request resolves twice (classify `isSSR=false`, render
  `isSSR=true`); `isSSR` is in the cache key, so both miss → two handler runs.
- **Measured cost** (`lazy-include-cost.bench.ts`, LP4 benches): the two-resolve
  path is ~1.9× a single resolve → **~20–25 µs waste per cold document request**,
  paid **once per route per isolate** and amortized to zero thereafter.
- **Why not fixed.** Dropping `isSSR` from the key was **refuted** as unsafe (the
  produced tree differs by `isSSR` via `loading()` behavior). A safe fix must split
  the `isSSR`-dependent state out of the cached tree (or warm the `isSSR=true` key
  during classification) — the same refactor LP3 depends on, touching shortCodes and
  the semantic matrix. **Risk ≫ reward** for a ~20-µs, amortizes-to-zero cost.
  Deferred as a documented decision; LP4 is the gate for ever revisiting LP3.

### Confirmed-but-immaterial (no change)

`registerRouteMap`/`mergedRouteMap` full-spread per lazy eval, the cached-manifest
copy into Store per warm request, the `prefixIsShared` O(entries) scan, and the
find-match entry-resolution loop — all once-per-entry or small; not worth touching.

### Follow-up

- **Done — all three quantified.** The lazy-eval / `loadManifest` / cold-start
  timing benchmark (`src/router/__tests__/lazy-include-cost.bench.ts`, run `vitest
bench lazy-include-cost`) now measures **LP1** (~20 µs/route, ~20× cheaper warm),
  **LP3** (~0.75 µs/route redundant run), and **LP4** (~1.9× double-resolve). All
  three are cold-start, paid once per route/isolate, amortizing to ~0 — the numbers
  drove the deferral of each. **No optimization is warranted.**
- The only thing that could ever change the calculus is the shared **LP3+LP4**
  refactor (splitting `isSSR`-dependent state out of the cached EntryData tree). Re-run
  the bench to re-justify before taking that on; nothing today does.
