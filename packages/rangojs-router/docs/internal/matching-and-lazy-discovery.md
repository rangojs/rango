# Matching & Lazy-Discovery — Architecture & Accepted Tradeoffs

Internal reference for how route **matching** and lazy `include()` **discovery** work,
the **dev/production contract** they must honor, the **invariants** the code relies on
(with the rationale behind the non-obvious ones), and the **performance tradeoffs that
have been measured and deliberately accepted**.

This is durable reference documentation, not a changelog — the history of how these
were found and fixed lives in git and the PRs (#481, #535, #537–#541, #544–#546). The
one-line guarantee it exists to protect: **dev and production resolve every request
through the same trie, and lazy includes are discovered identically in both modes.**

## How matching works

There are two matching code paths and two trie-construction code paths. The first of
each is canonical; the second exists only as a safety net or a different build-time
entry point.

- **Phase 1 — trie (canonical).** `tryTrieMatch` / `walkTrie` (`src/router/trie-matching.ts`)
  walk a prefix trie in `O(path length)` with backtracking and fixed precedence
  `static > suffix-param > param > wildcard`. This is the live matcher in **both** dev
  and production.
- **Phase 2 — regex fallback (latent).** `findMatch` (`src/router/pattern-matching.ts`)
  iterates `routesEntries` in **definition order**. It is a should-not-happen net: the
  trie is built before any match in both modes (dev rebuilds it per request in the
  handler; production loads it via `ensureRouterManifest`), so for routes that exist in
  the manifest the fallback is never the active matcher. `createFindMatch`
  (`src/router/find-match.ts`) orchestrates the two with a single-entry pathname cache
  and a lazy-evaluation retry loop, and emits a **dev-only warning** if the fallback
  ever resolves a real match while the trie was present (a genuine trie gap; suppressed
  when the trie matched but a lazy entry merely had not been spliced yet).

- **Trie construction — one shared builder.** Both modes build the per-router trie
  through `buildPerRouterTrie` (`src/build/route-trie.ts`); the pure prefix-tree walks
  (`flattenLeafEntries`, `buildRouteToStaticPrefix`) live in `src/build/prefix-tree-utils.ts`
  and are re-exported from `src/vite/utils/manifest-utils.ts` for the vite layer.
  Production serializes the build-time trie (`discover-routers.ts` → `generateManifestFull`
  → `buildPerRouterTrie`, serialized via `virtual-module-codegen.ts`); dev rebuilds it
  per request from live `urlpatterns` (`manifest-init.ts` `buildRouterTrieFromUrlpatterns`
  → `buildPerRouterTrie`). One builder means the two cannot structurally drift; the
  `dev-prod-trie-parity` test pins their equality.

## The dev/prod contract

| Concern                          | Dev                                                        | Production                                               |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Trie source                      | rebuilt per request from `urlpatterns` (`manifest-init`)   | serialized JSON chunk, loaded via `ensureRouterManifest` |
| Trie builder                     | `buildPerRouterTrie` (shared)                              | `buildPerRouterTrie` (shared)                            |
| `routeToStaticPrefix` builder    | `buildRouteToStaticPrefix` (shared)                        | `buildRouteToStaticPrefix` (shared)                      |
| `mountIndex` arg                 | `undefined` → default `0` (single-router == prod router-0) | global counter `0,1,2…` per router                       |
| Precomputed leaf entries         | computed in the dev trie rebuild (`flattenLeafEntries`)    | serialized `precomputedEntries`                          |
| Nested lazy includes             | runtime `evaluateLazyEntry` (same code)                    | runtime `evaluateLazyEntry` (same code)                  |
| `routesEntries` (regex fallback) | `Rango.routes()` walk at init                              | `Rango.routes()` walk at init                            |
| Regex fallback reachability      | reachable only in the HMR window before the trie rebuilds  | effectively unreachable (trie always present)            |

Multi-router caveat: the serialized trie carries per-leaf ancestry (`leaf.a`) computed
from the build-time global `mountIndex`, which differs from the runtime per-router-local
index for the 2nd+ router. This feeds **only** the `__debug_manifest` endpoint — real
layout pruning is by segment-ID prefix at render time and is self-consistent within each
mode — so it is not a matching/render divergence. (Tracked as optional cleanup below.)

## Invariants & design decisions

These are the non-obvious rules the matching/discovery code depends on. Changing any of
them is a behavior change; the named test pins it.

- **The trie is the canonical precedence model (M4).** `static > suffix-param > param >
wildcard`, with backtracking. The regex fallback's definition-order precedence is
  deficient by design (catch-alls can shadow specific routes) and is never the active
  matcher. Pinned by `trie-regex-parity.test.ts` (agreeing surface) + the R3 dev guard.
- **A bare-prefix wildcard matches with an empty splat (C1).** `/files` matches
  `/files/*` with `{"*":""}`, and a param-prefixed wildcard matches its bare prefix —
  `/users/:id/*` matches `/users/5` → `{ id:"5", "*":"" }` (zero-or-more splat). A
  static/param terminal at that node still wins. Pinned by `trie-matching.test.ts`.
- **Nested-include prefixes are slash-collapsed via `joinPrefix` (C5).** An
  `include("/parent/", …)` with a nested `include("/child", …)` must not produce a
  `/parent//child` staticPrefix (which the trie's `sp` can never match, silently forcing
  the regex fallback). `joinPrefix` is applied at both the placeholder `staticPrefix` and
  the handler-run prefix so `entry.routes` / `reverse()` / `EntryData.pattern` / `mountPath`
  are all normalized. Pinned by `lazy-include-isolation.test.ts`.
- **The find-match cache returns an isolated `params` clone (C7).** The single-entry
  pathname cache hands the same result to every same-pathname request, and `ctx.params`
  aliases its `params`; a handler mutating `ctx.params` must not corrupt the cache.
  Pinned by `find-match.test.ts`.
- **A `staticPrefix` shared by two leaf includes is omitted from the precomputed
  shortcut (C19).** Two distinct includes can collapse to the same prefix when a dynamic
  param eats their literal prefix (`/shop/:cat` and `/shop/:brand` both → `/shop`).
  Collapsing them last-wins (or merging them) mis-assigns one include's routes to the
  other's entry and 500s a valid sibling route; `buildPrecomputedByPrefix` drops shared
  prefixes so those includes resolve via the handler path (ground truth). Pinned by
  `precomputed-prefix-collision.test.ts`.
- **Leaf includes are precomputed; non-leaf includes resolve via the handler (C8).**
  `flattenLeafEntries` precomputes leaf-include routes (in dev too), so `evaluateLazyEntry`
  takes a shortcut and does not re-run the handler at match time. Non-leaf includes (those
  containing a nested `include()`) are never precomputed — the nested handler reference
  only exists once the parent handler runs, so it cannot be serialized.
- **Trailing slash is a configurable per-path / per-include feature (M3).** The explicit
  modes `path(..., { trailingSlash: "never"|"always"|"ignore" })` (and the same on
  `include`) are stored as `leaf.ts` and honored by the trie identically in dev and
  production. There is no router-level `trailingSlash` option. The trie does not carry
  the _pattern-implicit_ slash (the regex fallback does) — adding that is optional polish
  (a `tts` leaf flag), not a stability concern, since the trie is the live matcher.

## Lazy `include()` discovery — verdict and accepted tradeoffs

**Lazy-by-default is the correct design and is beneficial at boot, not per-request.**
Measured: defining `urls()` does not run the handler; `include()` captures patterns by
reference and does not run them; `Rango.routes()` runs only the top-level handler once
and creates empty lazy placeholders; an unmatched include's handler never runs; warm
requests run zero handlers (manifest cache). Eager guarantees (trie / `reverse()` /
types / prerender) are built at **build** time, so runtime laziness does not regress
them. The boot win is "fewer module-body executions (1 vs 1+N)," not per-request.

The three residual handler-run redundancies were **measured and accepted as not worth
optimizing** — all are cold-start, paid once per route per isolate, and amortize to ~0
via the per-routeKey manifest cache. Reproduce with `vitest bench lazy-include-cost`
(`src/router/__tests__/lazy-include-cost.bench.ts`); the run-count is pinned by
`lazy-include-perf.test.ts`. **Do not re-litigate these without re-running the bench.**

| Item    | What runs redundantly                                                                      | Measured cost                                                                  | Why not fixed                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **LP1** | an include with M routes runs its handler once **per route** (cache pruned per `routeKey`) | ~20 µs/route, ~20× cheaper warm; ~0.6–0.8 ms worst case for a 30-route include | needs an unpruned cache + prune-on-read; a handler-identity key **thrashes** under `forRoute` pruning (verified)     |
| **LP3** | a **non-leaf** include's direct routes run the handler at match **and** render             | ~0.75 µs/route (~50% of manifest-build, <0.5% of a real request)               | match run needed for nested discovery; render run needs the per-request `isSSR` store — reuse requires the LP4 split |
| **LP4** | a cold document request resolves twice (`isSSR=false` classify + `isSSR=true` render)      | ~20–25 µs/request (double resolve is ~1.9× a single)                           | the EntryData tree genuinely differs by `isSSR` (via `loading()`); dropping it from the key is unsafe                |

LP3 and LP4 share one prerequisite refactor — splitting `isSSR`-dependent state out of
the cached EntryData tree (which touches shortCodes and the semantic matrix). Nothing
today justifies it; re-run the bench to re-justify before taking it on. (LP2 — dev
lacking precomputed entries — was fixed: see C8 above.)

## Tests that pin this contract

- `trie-matching.test.ts` — trie precedence + the C1 bare/param-prefixed wildcard.
- `pattern-matching.test.ts` — regex matcher + `joinPrefix` (C5).
- `trie-regex-parity.test.ts` — the agreeing trie↔regex surface (and documented M3/M4/C1
  divergences where the trie is canonical).
- `dev-prod-trie-parity.test.ts` — dev rebuilt trie ≡ prod serialized trie.
- `find-match.test.ts` — cache clone (C7), fallback selection, lazy-iteration cap, R3 warn.
- `precomputed-prefix-collision.test.ts` — shared-`staticPrefix` omission (C19), incl. the
  request-path findMatch→loadManifest consequence.
- `lazy-include-isolation.test.ts` — lazy parent isolation + the C5 nested-prefix join.
- `lazy-include-perf.test.ts` — the lazy-by-default guarantees + the LP1/LP3/LP4 run-count
  sentinels.
- `lazy-include-cost.bench.ts` — the LP1/LP3/LP4 timing benchmark.
- `semantic-matrix.test.ts` — the router's core execution guarantees (middleware scope,
  handler-first ordering, PE/JS parity); any change here must keep it green.

## Optional / not-v1 (tracked, not blocking)

Genuinely-still-open items, none of which affect matching correctness or dev/prod parity:

- **Stop serializing `leaf.a` (M2 / R9).** The build-time ancestry is dead weight in
  every production per-router chunk and only feeds the debug endpoint; could be recomputed
  on demand. Pair with making the runtime `mountIndex` a stable per-router key.
- **Harden the find-match cache mutation (M5 / R11).** `match-api` mutates the shared
  cached `matched.pt`; idempotent today, but reading `snapshot.isPassthrough` instead
  would be cleaner. (The live half — the `params` clone — shipped as C7.)
- **Remove `RouteMatchResult.optionalParams`.** Written three times, never read in `src/`
  (only tests). Removal is all-or-nothing across both result types + the trie/regex paths;
  defer to a dedicated cleanup to avoid increasing divergence mid-change.
- **Minor diagnostic symmetry (C9/C10).** Route-name-conflict warning on the precomputed
  shortcut branch; routing the lazy-iteration cap through `router.onError`.
