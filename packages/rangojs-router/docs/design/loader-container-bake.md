# Loader container bake: one promise doctrine for handlers, handles, AND loaders

Status: IMPLEMENTED (same branch). The former trap tests flipped red->green as
planned; the bake-lane contract is e2e-pinned in both the test-app suite and
the cloudflare-basic twin (real KV envelope round-trip), dev + production.

Implementation notes (deltas from the sketch below, all deliberate):

- **The capture gate holds for bake-lane containers.** `FLIGHT_QUIET_HOPS` is
  a ~2-macrotask byte-quiet window, so a 100ms layout loader would lose the
  race and pin. `captureAndStoreShell` extends the gate's `holdUntil` with
  `Promise.allSettled` over the recorded container promises — same mechanism
  that already held for top-level handle pushes, bounded by the 5s guard.
- **`loading(false)` (and `loading(x, { ssr: false })` under the SSR
  manifest) = BAKE lane** — the mask decision is "renderable loading only"
  (`entryLoadingMasksLoaders`, mirroring segment-system's
  isRenderableLoading), resolving open question 1 toward "absent".
- **Guard refusal is flag-based**: `assertNotInsideShellCapture` stamps
  `_shellCaptureGuardTripped` on the capture context BEFORE throwing, because
  the throw is swallowed by wrapLoaderPromise (boundary UI) or rejects the
  prerender promise itself (boundary-less segment) — both paths check the
  flag and return the new deterministic `"refused"` outcome (no retry,
  once-per-key warning naming the read).
- **`prerender()`'s promise gets a pre-attached no-op catch** in
  captureShellHTML: an early bake-lane rejection otherwise sits handler-less
  until the post-quiesce await and crashes the worker as an unhandled
  rejection (found live; the real handling is unchanged).
- **A container still pending at drain is OMITTED, not refused** — it either
  already hit the trivial-prelude gate or postponed under an ancestor
  boundary (a hole; omitting keeps it live).
- **Records are keyed by loader segment id** (`<shortCode>D<i>.<loaderId>`),
  recorded pre-wrap (the wrapper is deterministic), serialized with
  `serializeResult` (null-preserving), and seeded via `_shellLoaderSeed` on
  the HIT tail's derived context.
- **Handler-side consumption follows the CONSUMPTION-LANE RULE** (issue
  #672 / #674, post-ship): `await ctx.use(loader)` in a HANDLER executes
  during capture with identity reads permitted (the shell guard exempts
  handler-invoked loader bodies — the cache() purity precedent), and the
  value bakes as a capture-time copy wherever it renders as unshielded shell
  material. The lane machinery in THIS doc is untouched: it applies to DSL
  `loader()` SEGMENTS only (renderable loading() = masked live lane; no
  loading() = bake lane WITH the guard active), and a registered live-lane
  segment's mask still keeps its boundary a live hole even when a handler
  also consumes the same loader. An earlier fix MASKED handler consumption
  instead; it hung the capture's ring-3 cacheRoute serialization on the
  never-settling slot component (cloudflare-basic /ppr-blog, React #418 on
  every HIT) and was replaced by the rule. Pinned by semantic-matrix row
  PPR3. See ppr-shell-resume.md ("Handler-side consumption") and
  docs/internal/execution-model.md ("The consumption-lane rule").
- **Nested thenables are MASKED at capture — shape is the liveness
  declaration** (`maskNestedContainerThenables`, applied in loader-cache's
  capture branch; supersedes the settled-pinning below). A nested promise that
  settled before the quiet window closed used to pin its VALUE into the
  snapshot (`$rangoLoaderSettled`), so every HIT served the capture-time value
  to every visitor — per-request data frozen into the SHARED shell (found
  live: a storefront basket, carrying the capturing session's
  basketId/customer identifiers, served to anonymous requests; the window
  waits for the slowest material on the page plus the bake-lane holdUntil, so
  ANY real data source — a 5ms SQL read, a 200ms basket API — lost the race).
  The capture now deep-copies the container with every nested thenable
  replaced by a never-resolving mask: the consuming boundary postpones as a
  hole no matter when the promise settles, elide records a HOLE marker, and
  every HIT streams the fresh value. The raw container is untouched, so
  handler-side consumption (the consumption-lane rule, PPR3) keeps real
  values. Pinned by the flipped `/shell-cache/settled` + `/ppr-shell/settled`
  e2e twins (outer pins, nested stays fresh) and loader-snapshot unit tests.
  The SAME mask applies to pushed HANDLE containers via the capture store's
  push wrap (shell-capture.ts): `ctx.use(H)({ x: promise })` holes its nested
  promise regardless of settle timing (pinned by the fast-nested assertion in
  the handles-pair e2e); a TOP-LEVEL promise push keeps its documented bake
  contract, with the container it resolves to masked the same way. Handler
  PROP promises (a promise passed into JSX from a path/layout/parallel
  handler) remain physics-only: they are minted inside a server component's
  render, invisible to any rango funnel until React renders them — per-request
  data belongs in loaders or handles, where liveness is now guaranteed.
- **SETTLED markers (`$rangoLoaderSettled`) are now legacy-decode-only.** New
  captures cannot record them (nested thenables are masked pending), but
  snapshots stored before the mask still contain them; the overlay keeps
  rehydrating them as `Promise.resolve(pinned)` — the original #438 fix — so
  pre-mask shells stay servable until their TTL turns them over. History: the
  first cut inlined a settled nested promise's value directly, so the HIT
  overlay handed consumers a plain value where their code says `use(data.x)`
  — React #438, root error boundary, whole page down (found live on a
  storefront PDP whose 165ms price fetch won the quiet window).

## The asymmetry this closes

The PPR hole doctrine has one rule for promises: **a promise nested inside your
data is never baked; the container settles.** Two of the three data lanes
already follow it:

| Lane    | Container                                | Nested promise                    |
| ------- | ---------------------------------------- | --------------------------------- |
| Handler | awaited data BAKES                       | handed-over pending promise HOLES |
| Handle  | top-level `push(promise)` awaited, BAKES | `push({ x: promise })` HOLES      |
| Loader  | **whole value live OR capture refuses**  | streams (axis 1) / n/a (capture)  |

Loaders are the exception, and the exception has two faces:

- WITH `loading()`: the whole loader value is the live lane — masked at
  capture, fresh every serve. This is load-bearing (identity safety, guaranteed
  freshness) and does NOT change.
- WITHOUT `loading()`: the entry's loaders are awaited at tree-build
  (`segment-system.tsx`, the has-loaders-no-loading branch), the capture's
  masked loaders pin the tree above `<body>`, and the sanity gate refuses —
  `x-rango-shell: MISS` forever. An app-wide layout registering session-style
  loaders (the storefront shape) dead-ends here, and a `loading()` on the ppr
  child route does not help — the await lives at the entry that REGISTERS the
  loaders. Both facts are e2e-pinned (`/shell-cache/layout-loader`).

The kicker: on axis 1, a no-`loading()` loader ALREADY follows the container
rule. The tree-build await settles the CONTAINER; a promise nested inside it
passes through Flight verbatim and streams into the consumer's own `<Suspense>`
(`/shell-cache/no-hole` asserts "Streamed inner" arrives). The only place the
container rule breaks is the capture's blanket loader mask. This design makes
capture match axis 1.

## The contract

For a loader on an entry WITHOUT `loading()`, under shell capture:

> The loader EXECUTES during capture. Its settled container bakes into the
> shell. Every promise still nested in the container at the quiet window
> postpones at the consumer's own `<Suspense>` — a hole. The return shape is
> the declaration: sync data says "shell material", a nested promise says
> "live".

```typescript
// No loading() anywhere. The storefront layout, fixed by return shape alone:
export const StorefrontContextLoader = createLoader(async (ctx) => {
  const config = await loadSiteConfig(ctx.params.locale); // bakes
  return {
    config, // baked into the shared shell
    basket: fetchBasket(ctx), // hole — consumer <Suspense>s it
  };
});
```

`loading()` present is byte-for-byte today's behavior: whole value live, masked
at capture, LoaderBoundary is the hole. `loading()` stays the GUARANTEED live
lane — immune to fast resolution, exempt from the capture identity guard — and
the migration story for anyone who wants no part of baking.

## Semantics matrix

| Case                                 | Container (sync part)                    | Nested promise          |
| ------------------------------------ | ---------------------------------------- | ----------------------- |
| Axis 1 (no ppr, or MISS)             | settled at tree-build (today)            | streams (today)         |
| Capture                              | **executes, bakes into prelude** (new)   | postpones — hole (new)  |
| Shell HIT (document GET)             | **replayed from capture snapshot** (new) | fresh per request       |
| Client navigation / action / partial | fresh (axis-1 flow, no shell involved)   | fresh                   |
| Entry WITH `loading()`               | live (masked at capture) — unchanged     | streams inside the hole |

The freshness doctrine is the shell's, stated in `ppr-shell-resume.md`: within
a shell's lifetime, shell regions show CAPTURE-time data; parity beats
freshness inside the shell. Note the deliberate divergence this accepts: a
document GET shows the capture-time container while a client-side navigation
to the same route computes it fresh. That is already true of every other kind
of shell material.

## Mechanics

### 1. Capture: unmask no-`loading()` loaders

`fresh.ts` masks all loaders during capture and forces the streaming emit shape
(`emitStreaming = !loadingDisabled || isShellCaptureActive()`) so the
loading-disabled await cannot hang on masked promises. Change: during capture,
loaders on no-`loading()` entries are NOT masked — the tree-build await runs
the real loader and settles the container, exactly like axis 1. The capture
gate already holds open for real awaits (top-level handle pushes ride the same
mechanism, bounded by the capture's 5s guard). Loaders on `loading()` entries
stay masked. Whether `loading(false)` counts as "absent" (bake) or "present"
(live) is an open question below.

### 2. Identity guard: loaders lose their capture exemption when unmasked

`cookies()`/`headers()` currently throw during capture in handler-land
(`assertNotInsideShellCapture`) and loaders are EXEMPT — safe only because
masked loaders never run. An unmasked loader executing at capture MUST run with
the guard ACTIVE: an identity read throws, the capture refuses, and the
refusal warning names the loader — "loader X reads cookies()/headers(); give
its entry loading() (the live lane) or move the identity-dependent part into a
nested promise." Fail-closed: leaking a session into the shared shell must be
impossible by construction, same as handlers.

Two sub-edges:

- A guard throw inside a NESTED promise executor (the promise body starts
  during the capture render) must reject that promise — postponing/erroring its
  consumer boundary — without failing the whole capture. The boundary was
  already a hole; on serve the promise re-runs with real identity.
- The guard applies only DURING CAPTURE. The same loader on axis 1 and on every
  HIT reads identity freely (it always did).

### 3. HIT parity: extend the capture data snapshot with a loader family

The drift hazard from `ppr-shell-resume.md` applies verbatim: a HIT replays the
frozen prelude and runs a FULL FRESH Flight render for hydration; every baked
byte must agree. A re-executed loader computes a fresh container that disagrees
with the prelude — hydration mismatch. Same problem the capture data snapshot
already solves for ring-1/ring-3 reads; loader containers become a third
recorded family.

- **Recording.** When the capture's tree-build await settles a no-`loading()`
  loader, record `(family: "loader", key: segmentId + loaderId, value:
container-with-promise-paths-elided)` into the same
  `ShellCacheEntry.snapshot` array (`shell-snapshot.ts`). Promise-valued paths
  are recorded as markers, not values — they are holes, not shell material.
- **Seeding.** On a HIT the loader RUNS FRESH (it must — only the loader body
  can mint the nested promises), then the recorded container is OVERLAID: every
  recorded (non-promise) path takes the snapshot value; promise-valued paths
  keep the fresh run's promises. The prelude's baked bytes and the payload's
  container fields agree by construction; the holes stay live.
- **Overlay rules for shape drift** (capture says sync, hit says promise, or
  vice versa): a recorded path always wins (pinned — it is what the prelude
  froze); a path that is a promise in BOTH runs stays the fresh promise; a NEW
  path (absent at capture) passes through fresh — it cannot contradict prelude
  bytes that never rendered it.
- **Envelope compat.** CF and Vercel shells cherry-pick entry fields into
  custom envelopes (`KVShellEnvelope.sn` / `VercelShellEnvelope.sn`); the
  snapshot array itself already rides there, and the new family value is
  opaque to the stores — verify with an envelope round-trip test rather than
  assuming.

The self-aligning property from the snapshot doc is preserved: "record what the
capture read" and "everything under a hole stays live" remain the same rule —
the loader container was read at capture (bakes, recorded); the nested promise
was not (hole, live).

### 4. What does not change

`loading()` entries (masking, LoaderBoundary, freshness). Non-ppr routes. Axis
1 for everyone. PE/no-JS renders (axis-1 flow). Loader `cache()` (a cached
loader's read flows through the store and is already snapshot-recordable).
`revalidate()` semantics (a data lever; on axis-1 flows the container is fresh
as ever).

## Rollout

Behavior changes ONLY for entries that today hit the structural refusal —
loaders + no `loading()` + `ppr` — where the current behavior is an eternal
MISS plus a warning. Nothing working changes, so this ships default-on, no
flag, no new API. The return shape is the entire opt-in surface.

Independent of (and before) this design: the refusal warning at
`shell-capture.ts:244` blames "a loader route WITHOUT a route-level loading()"
— route-level framing that misled a real migration into adding `loading()` to
a child route when the pinning loaders lived on the layout. Fix regardless:
name the entries that pin (walk the matched chain for entries with loaders and
no renderable `loading()`), state that the boundary must live on the entry
that registers the loaders, and point at the layout-with-loaders playbook.
After this design ships, that warning fires only for the residual causes
(identity-guard refusal, consumer with no Suspense above a nested-promise
hole, cold-start).

## Test plan

- Flip `/shell-cache/layout-loader` (red vehicle, both modes): change
  `ShellChromeLoader` to return `{ label, pending }` and the assertions from
  MISS-forever to HIT with `label` baked in the prelude, `pending`'s fallback
  frozen, and the value resumed + seq-fresh across HITs.
- Parity/drift: a no-`loading()` loader whose container embeds an
  execution-counter — HITs must show the CAPTURE-time container (snapshot
  overlay) with zero hydration errors; the drift suite pattern
  (`/shell-cache/drift`) is the template.
- Identity refusal: a no-`loading()` loader reading `cookies()` — capture
  refuses, eternal MISS, warning names the loader; the SAME loader behind
  `loading()` captures fine.
- Envelope round-trip for the loader snapshot family on CF and Vercel stores
  (unit).
- Semantic matrix: the loader-freshness row gains the no-`loading()`+ppr
  column; `docs/internal/execution-model.md` updated in the same PR (Hard
  rule 5).
- Doc updates in the same PR: `/ppr` hole doctrine table (the loader asymmetry
  paragraph becomes historical), the layout-with-loaders playbook gains the
  return-shape option as the zero-`loading()` path, `ppr-shell-resume.md`
  snapshot section gains the loader family.

## Open questions

1. `loading(false)` (and `loading(x, { ssr: false })` which sets `false`
   during SSR): treat as "absent" (bake) or "present" (live)? Leaning ABSENT —
   it selects the awaiting branch today, and awaiting is what baking
   formalizes — but `ssr:false` flipping bake-ness between SSR and non-SSR
   manifests needs a hard look.
2. Snapshot size: loader containers can be larger than ring-1/ring-3 values
   (they were never size-gated by a store write). Likely needs the same
   per-item byte cap treatment the stores apply, with a refuse-and-warn rather
   than a silent truncation.
3. Promise-path detection: reuse the FlightSerialize notion of "pending
   promise" (`src/serialize.ts`) so the overlay and the codec never disagree
   about what counts as a hole.
4. A no-`loading()` loader whose consumer has NO `<Suspense>` above it and a
   nested promise: the boundary-less suspension pins the capture exactly like
   today's trap. The improved warning covers diagnosis; do we want a
   capture-time hint naming the suspended segment?
