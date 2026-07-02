# Matching & Lazy-Discovery — Architecture & Accepted Tradeoffs

If you're about to touch how routes match, or how lazy `include()`s get discovered,
start here. This is the map: how the pieces fit together, the handful of rules the code
quietly leans on (and what breaks if you bend them), and the performance corners we
measured and then chose, on purpose, to leave alone.

Most of what follows started life as a bug or a careful argument — the explanations are
the scar tissue, kept so the next person doesn't have to bleed for them again. The
history of _how_ we got here lives in git and the PRs (#481, #535, #537–#541, #544–#546);
this doc is about where we landed and why.

The one promise the whole subsystem keeps, the thing everything else is in service of:
**dev and production resolve every request through the same trie, and lazy includes are
discovered the same way in both.** If you ever make those two disagree, you've reintroduced
the exact class of bug this design exists to prevent.

## How matching works

There's a bit more machinery here than you'd guess, so let's start with the shape. There
are two ways to match a route, and two ways to build the trie that does it. In both
pairs, the first is the real thing and the second is a backstop you should almost never
hit.

- **Phase 1 — the trie (this is the one that matters).** `tryTrieMatch` / `walkTrie`
  (`src/router/trie-matching.ts`) walk a prefix trie in `O(path length)`, with
  backtracking and a fixed precedence: `static > suffix-param > param > wildcard`. In
  both dev and production, this is the matcher that actually runs.
- **Phase 2 — the regex fallback (the fire extinguisher).** `findMatch`
  (`src/router/pattern-matching.ts`) walks `routesEntries` in plain definition order.
  It exists so that a weird edge case degrades to "slower but still correct" instead of
  "broken" — but for any route that's actually in the manifest, it never runs, because
  the trie is always built first (dev rebuilds it in the handler before matching;
  production loads it via `ensureRouterManifest`). `createFindMatch`
  (`src/router/find-match.ts`) ties the two together with a single-entry pathname cache
  and a retry loop for lazy evaluation. It also has a tripwire: in dev it logs a warning
  if the fallback ever resolves a real match while the trie was present. If you see that
  warning, the trie has a genuine gap — that's a bug to report, not background noise.
  (It stays quiet when the trie matched fine but a lazy entry simply hadn't been spliced
  in yet — that's the normal lazy flow, not a gap.)

**Why there's one trie builder, not two.** Production and dev get their tries from
completely different places — production deserializes a JSON blob baked at build time,
dev rebuilds from live `urlpatterns` on each request. That's two code paths that have to
produce byte-identical results forever, or a route matches in one mode and 404s in the
other. Rather than trust two implementations to stay in lockstep by discipline, both go
through one function, `buildPerRouterTrie` (`src/build/route-trie.ts`), with the pure
prefix-tree walks (`flattenLeafEntries`, `buildRouteToStaticPrefix`) living in
`src/build/prefix-tree-utils.ts`. Production serializes the build-time trie
(`discover-routers.ts` → `generateManifestFull` → `buildPerRouterTrie`); dev rebuilds it
per request (`manifest-init.ts` `buildRouterTrieFromUrlpatterns` → `buildPerRouterTrie`).
Same builder, so they can't drift. `dev-prod-trie-parity.test.ts` stands guard on that.

## The dev/prod contract

Here's the side-by-side. Scan it with one question in mind — _which column is allowed to
differ?_ The answer is essentially none of the rows that affect a match; the differences
are all in _where_ the data comes from, not _what_ it resolves to.

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

There's one caveat worth knowing about so it doesn't spook you later:
in a multi-router setup, the serialized trie carries per-leaf ancestry (`leaf.a`) computed
from a build-time global `mountIndex`, which doesn't line up with the runtime
per-router-local index for the second router onward. It looks scary but it isn't — that
field only feeds the `__debug_manifest` endpoint. The real layout pruning happens by
segment-ID prefix at render time and is self-consistent within each mode. (It's on the
optional-cleanup list below.)

## Invariants & design decisions

These are the load-bearing rules — the kind where "I'll just tweak this one line" quietly
breaks something three files away. Each one has a test standing watch, so if you change
the behavior, that test is where you'll find out. They mostly read like odd little
special cases because that's exactly what they are: each one is a bug we already paid for.

- **The trie is the canonical precedence model (M4).** `static > suffix-param > param >
wildcard`, with backtracking. The regex fallback matches in definition order, which is
  genuinely worse — a catch-all declared early can shadow a specific route — but since
  it's never the live matcher, that's fine; the trie is the source of truth, and the
  fallback just needs to not be _wildly_ wrong. `trie-regex-parity.test.ts` pins where
  they agree; the dev warning catches the case where they shouldn't have diverged.
  Within the suffix-param tier, the rule is **longest literal suffix wins**: given
  `/:file.min.js` and `/:file.js`, a request for `/app.min.js` resolves to `.min.js`
  (`file:"app"`), never `.js` (`file:"app.min"`). This is specificity, not declaration
  order — `walkTrie` returns the first suffix the segment ends with, so `route-trie.ts`
  `sortSuffixParams` pre-sorts each node's `xp` keys longest-first at build time (a stable
  sort, so equal-length suffixes keep declaration order). It started as a bug: before the
  sort, the winner depended on which overlapping suffix route was declared first. The sort
  is build-time, so it's free on the match hot path and the serialized production trie
  preserves the order through `JSON.parse`. (The regex fallback still picks by declaration
  order here — a documented M4 divergence in `trie-regex-parity.test.ts`.)
- **A bare-prefix wildcard matches with an empty splat (C1).** `/files` matches
  `/files/*` with `{"*":""}`, and a param-prefixed wildcard matches its own bare prefix
  too — `/users/:id/*` matches `/users/5` as `{ id:"5", "*":"" }` (a zero-or-more splat,
  the way React Router does it). A real static or param route at that spot still wins.
  Pinned by `trie-matching.test.ts`.
- **Nested-include prefixes get their slashes collapsed via `joinPrefix` (C5).** Write
  `include("/parent/", …)` around a nested `include("/child", …)` and the naive join
  gives you `/parent//child` — a staticPrefix the trie's `sp` can never match, so the
  route silently falls through to the regex fallback. `joinPrefix` normalizes it at both
  the placeholder `staticPrefix` and the handler-run prefix, so `entry.routes`,
  `reverse()`, `EntryData.pattern`, and `mountPath` all stay clean. Pinned by
  `lazy-include-isolation.test.ts`.
- **The find-match cache hands back a cloned `params` (C7).** That single-entry pathname
  cache gives the same result object to every request for the same path, and `ctx.params`
  aliases its `params` — so if a handler mutates `ctx.params`, it would poison the cache
  for the next request on that path. The clone is what keeps requests from stepping on
  each other. Pinned by `find-match.test.ts`.
- **Two includes that share a `staticPrefix` are dropped from the precomputed shortcut
  (C19).** This one's subtle: two genuinely different includes can collapse to the same
  prefix when a dynamic param eats their literal part — `/shop/:cat` and `/shop/:brand`
  both reduce to `/shop`. The precomputed lookup was a `Map`, which is last-wins, so one
  include's routes got silently dropped and handed to the wrong entry — and then a
  perfectly valid sibling route 500s. `buildPrecomputedByPrefix` just leaves shared
  prefixes out of the shortcut entirely, so those includes go through the real handler
  (the ground truth). Pinned by `precomputed-prefix-collision.test.ts`.
- **Leaf includes are precomputed; non-leaf includes go through the handler (C8).**
  `flattenLeafEntries` precomputes the routes of leaf includes (in dev too), so
  `evaluateLazyEntry` can take a shortcut instead of re-running the handler at match
  time. Anything with a nested `include()` _can't_ be precomputed, and there's a real
  reason: the nested handler reference only comes into existence once the parent handler
  runs, so there's nothing to serialize at build time.
- **Trailing slash is a per-path / per-include setting, not a router knob (M3).** The
  explicit modes — `path(..., { trailingSlash: "never"|"always"|"ignore" })`, same on
  `include` — are stored as `leaf.ts` and honored by the trie identically in both modes.
  There's deliberately no `createRouter({ trailingSlash })`. The one thing the trie
  doesn't do is canonicalize the _pattern-implicit_ slash (the regex fallback does) — but
  since the trie is the live matcher, behavior is consistent, and adding it would be
  optional polish (a `tts` leaf flag), not a fix.

## Lazy `include()` — is it actually pulling its weight?

A fair first reaction to lazy-by-default is "hang on, are we re-running route handlers on
every request?" Good question — we asked it too, and measured. The short answer:
**lazy-by-default is the right call, and the win is at boot, not per-request.**

One thing this section predates: an include can now be **async** —
`include("/x", () => import("./routes"))`. That form defers more than handler
execution; the route module itself isn't evaluated until the first request
reaches the prefix (it's a separate chunk), which is the cold-start and
entry-bundle win. Everything below still holds — build-time discovery `await`s
the provider, so the trie, `reverse()`, generated types, and prerender see every
route in the split group. If you're touching async include specifically, read
[async-includes.md](./async-includes.md) first; it owns that contract and the
scars behind it.

What the measurements actually showed: defining `urls()` doesn't run the handler;
`include()` captures its patterns by reference without running them; `Rango.routes()`
runs only the top-level handler once and leaves empty placeholders for the rest; an
include nobody visits never runs at all; and warm requests run zero handlers thanks to
the manifest cache. The eager guarantees you'd worry about losing — the trie, `reverse()`,
generated types, prerendering — are all built at _build_ time, so runtime laziness
doesn't touch them. The payoff is fewer module bodies executed at startup (1 instead of
1+N), not fewer executions per request.

That leaves three spots where a handler runs more than the bare minimum on a _cold_ path.
We measured each, and decided each one isn't worth chasing — they're all cold-start,
paid once per route per isolate, and the warm cache amortizes them to roughly nothing.
You can reproduce all three with `vitest bench lazy-include-cost`
(`src/router/__tests__/lazy-include-cost.bench.ts`); the run-counts are pinned by
`lazy-include-perf.test.ts`. If one of these ever looks like an easy win, please re-run
the bench before opening anything — the numbers are why we walked away, and they're what
should change our minds, not intuition.

| Item    | What runs more than once                                                                          | What it costs                                                                           | Why we left it                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LP1** | an include with M routes runs its handler once **per route** (the cache is pruned per `routeKey`) | ~20 µs/route, and ~20× cheaper once warm; ~0.6–0.8 ms worst case for a 30-route include | the clean fix is an unpruned cache + prune-on-read; the tempting shortcut (a handler-identity key) actually **thrashes** under `forRoute` pruning — we tried it, it's worse |
| **LP3** | a **non-leaf** include's direct routes run the handler at match **and** at render                 | ~0.75 µs/route (~50% of manifest-build, but well under 0.5% of a real request)          | the match run is needed for nested discovery; the render run needs the per-request `isSSR` store — reusing one for the other needs the LP4 split                            |
| **LP4** | a cold document request resolves twice (`isSSR=false` to classify, `isSSR=true` to render)        | ~20–25 µs/request (the double resolve is ~1.9× a single)                                | the EntryData tree genuinely differs by `isSSR` (through `loading()`), so you can't just drop it from the cache key                                                         |

LP3 and LP4 are really the same project wearing two hats: both only become fixable once
`isSSR`-dependent state is split out of the cached EntryData tree, and that change reaches
into shortCodes and the semantic matrix. Nothing today earns that risk. (LP2 — dev
missing precomputed entries — _was_ worth fixing, and is: that's C8 above.)

## The tests that guard this

If you change something in here and want to know what you might have knocked over, this
is the list:

- `trie-matching.test.ts` — trie precedence, plus the C1 bare / param-prefixed wildcard.
- `pattern-matching.test.ts` — the regex matcher and `joinPrefix` (C5).
- `trie-regex-parity.test.ts` — where the trie and regex agree (and the M3/M4/C1 spots
  where they don't, with the trie winning).
- `dev-prod-trie-parity.test.ts` — the dev rebuilt trie really does equal the prod
  serialized one.
- `find-match.test.ts` — the cache clone (C7), fallback selection, the lazy-iteration
  cap, and the R3 warning.
- `precomputed-prefix-collision.test.ts` — the shared-`staticPrefix` drop (C19), including
  the full findMatch→loadManifest path that used to 500.
- `lazy-include-isolation.test.ts` — lazy parent isolation and the C5 nested-prefix join.
- `lazy-include-perf.test.ts` — the lazy-by-default guarantees and the LP1/LP3/LP4
  run-count sentinels.
- `lazy-include-cost.bench.ts` — the LP1/LP3/LP4 timing benchmark.
- `semantic-matrix.test.ts` — the router's core execution guarantees (middleware scope,
  handler-first ordering, PE/JS parity). If you change matching or discovery, keep this
  one green above all.

## The backlog (optional, not v1)

None of these keep anyone up at night — they don't affect matching correctness or
dev/prod parity — but they're real, so here they are:

- **Stop serializing `leaf.a` (M2 / R9).** That build-time ancestry rides along in every
  production per-router chunk and only feeds the debug endpoint; it could be recomputed on
  demand. Best done alongside giving the runtime `mountIndex` a stable per-router key.
- **Tidy the find-match cache mutation (M5 / R11).** `match-api` mutates the shared cached
  `matched.pt`. It's idempotent today so nothing's wrong, but reading
  `snapshot.isPassthrough` instead would be cleaner. (The part that _did_ matter — the
  `params` clone — already shipped as C7.)
- **Drop `RouteMatchResult.optionalParams`.** It's written in three places and read
  nowhere in `src/` (only tests look at it). Removing it is all-or-nothing across both
  result types and both match paths, so it's worth its own focused cleanup rather than a
  half-measure that increases divergence.
- **Small diagnostic symmetry (C9/C10).** Emit the route-name-conflict warning on the
  precomputed-shortcut branch too, and route the lazy-iteration cap through
  `router.onError`.
