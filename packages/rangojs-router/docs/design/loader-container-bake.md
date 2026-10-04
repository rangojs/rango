# Loader container bake: one promise doctrine for handlers, handles, AND loaders

ADDENDUM 2026-07-28 — the bake lane's TRIGGER is now the per-loader
`ssr: false` flag (`loader(Def, { ssr: false })`), not
the entry's missing loading(). #813 (streaming useLoader) retired the
loading()-less trigger — plain loaders are LIVE at capture on every entry
shape, and a boundary-less masked read refuses the capture. The flag's
document promise ("this loader's data is in the HTML before first flush")
maps to the frozen prelude under ppr, so flagged loaders re-engage the
UNCHANGED machinery below: execute at capture, nested-thenable mask (shape
is liveness), `_shellCaptureLoaderRecords` registration (capture gate hold,
bounded by `ppr.captureTimeout`), snapshot pinning, HIT-tail seed overlay
(pin-first when hole-free). A route whose loaders are ALL flagged needs no
loading() and captures a complete shell. Pinned by the "ssr:false loader
bakes into the shell", "fully-baked route needs no loading()", and group-ppr
baked-value probes (shell-cache.test.ts, dev+prod). (The flag was
`stream: "navigation"` until #820 renamed it.)

Read the rest of this doc with that substitution: wherever it says "no
`loading()`" / "WITHOUT `loading()`" selects the bake lane, the trigger is
now `ssr: false`, and `loading()` present is no longer what makes a loader
live — every unflagged loader is live and needs `loading()` or an inline
`<Suspense>` above its reader. Passages below are marked where they state
the old trigger.

Status: IMPLEMENTED (same branch). The former trap tests flipped red->green as
planned; the bake-lane contract is e2e-pinned in both the test-app suite and
the cloudflare-basic twin (real KV envelope round-trip), dev + production.

Implementation notes (deltas from the sketch below, all deliberate):

- **The capture waits for bake-lane containers.** `FLIGHT_QUIET_HOPS` is
  a ~2-macrotask byte-quiet window, so a 100ms layout loader would lose the
  race and pin. The capture first held the gate open (`holdUntil`,
  `Promise.allSettled` over the recorded container promises); the
  record-first step (`settleCaptureRecord`, ppr-shell-resume.md) now waits
  for them, with the top-level handle pushes, before the capture's Flight
  render begins, so the gate holds nothing. Bounded by `ppr.captureTimeout`.
- **`loading(false)` (and `loading(x, { ssr: false })` under the SSR
  manifest) = BAKE lane** — the mask decision is "renderable loading only"
  (`entryLoadingMasksLoaders`, mirroring segment-system's
  isRenderableLoading), resolving open question 1 toward "absent".
  _Superseded (see the addendum):_ the mask decision is now per loader in
  `resolveLoaderData` — `ssr: false` bakes, everything else masks.
  `entryLoadingMasksLoaders` only decides whether an unflagged loader's
  segment key rides as the bake/seed key, which is inert at capture.
- **Guard refusal is flag-based**: the capture guard (today the first step
  of `guardIdentityRead`, `src/server/context.ts`) stamps
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
  the HIT tail's derived context. A Flight error in that encode refuses the
  capture like a render error (issue #927).
- **Handler-side consumption follows the CONSUMPTION-LANE RULE** (issue
  #672 / #674, post-ship; tightened by the handlers-baked change):
  `await ctx.use(loader)` in a HANDLER executes during capture and the value
  bakes as a capture-time copy, like everything else the handler produces.
  Identity reads inside it (`cookies()`, `headers()`, a `{ cache: false }`
  variable) now REFUSE the capture: the shell guard used to exempt
  handler-invoked loader bodies (the cache() purity precedent), which was
  safe only while a HIT re-ran handlers and so rendered that read per
  visitor. Every HIT now replays the capture's doc record, so the exemption
  would bake the capturing request's identity into every visitor's page; the
  cache() purity guards keep theirs. The lane machinery in THIS doc is
  untouched: it applies to DSL `loader()` SEGMENTS only (unflagged = masked
  live lane; `ssr: false` = bake lane WITH the guard active). A registered
  live-lane segment stays a live hole where it is read client-side with
  `useLoader`; a handler's own `ctx.use` of the same loader bakes. An earlier
  fix MASKED handler consumption instead; it hung the capture's ring-3
  cacheRoute serialization on the never-settling slot component
  (cloudflare-basic /ppr-blog, React #418 on every HIT) and was replaced by
  the rule. Pinned by semantic-matrix row PPR3 and
  `src/rsc/__tests__/shell-handlers-baked.rsc-test.tsx` (`cookies() in a
loader the handler awaits`). See ppr-shell-resume.md and
  docs/internal/execution-model.md ("The consumption-lane rule").
- **Nested thenables are MASKED at capture — shape is the liveness
  declaration** (`maskNestedContainerThenables`, applied in loader-cache's
  capture branch; supersedes the settled-pinning below). A nested promise that
  settled before the quiet window closed used to pin its VALUE into the
  snapshot (`$rangoLoaderSettled`), so every HIT served the capture-time value
  to every visitor — per-request data frozen into the SHARED shell (found
  live: a storefront basket, carrying the capturing session's
  basketId/customer identifiers, served to anonymous requests; the window
  waits for the slowest material on the page plus the bake-lane containers, so
  ANY real data source — a 5ms SQL read, a 200ms basket API — lost the race).
  The capture now deep-copies the container with every nested thenable
  replaced by a never-resolving mask: the consuming boundary postpones as a
  hole no matter when the promise settles, elide records a HOLE marker, and
  every HIT streams the fresh value. The raw container is untouched, so
  handler-side consumption (the consumption-lane rule, PPR3) keeps real
  values. Pinned by the flipped `/shell-cache/settled` + `/ppr-shell/settled`
  e2e twins (outer pins, nested stays fresh) and loader-snapshot unit tests.
  The SAME mask applies to a LOADER's pushed handle containers via the
  capture store's push wrap (`deriveShellCaptureContext` in
  shell-capture.ts): a push made inside a DSL loader scope,
  `ctx.use(H)({ x: promise })`, holes its nested promise regardless of settle
  timing. HANDLER pushes no longer take the mask: since the handlers-baked
  change they are handler output, and the capture waits for their nested
  promises (`settleNestedThenables` in
  `src/router/segment-resolution/mask-nested.ts`) and bakes the settled
  values into the doc record every HIT replays. A top-level promise push
  keeps its documented bake contract. Handler PROP promises (a promise passed
  into JSX from a path/layout/parallel handler) used to be holes by timing
  alone (pending when the capture's quiet window closed); they are now baked
  too: writing the doc record Flight-serializes the handler output and waits
  for every promise in it. Per-request data belongs in live-lane loaders read
  with `useLoader`, or in promises nested in an `ssr: false` loader's return
  value.
- **SETTLED markers (`$rangoLoaderSettled`) are gone.** Captures cannot
  record them (nested thenables are masked pending, so elide records every
  nested promise as a hole), and the overlay no longer decodes them: the
  buildVersion gate retires the pre-mask shells that carried them. History:
  the first cut inlined a settled nested promise's value directly, so the HIT
  overlay handed consumers a plain value where their code says `use(data.x)`
  — React #438, root error boundary, whole page down (found live on a
  storefront PDP whose 165ms price fetch won the quiet window); the settled
  marker rehydrated as `Promise.resolve(pinned)` fixed that until the mask
  made the pin impossible.

## The asymmetry this closes

> _Superseded for handlers and handler pushes (the handlers-baked change):_
> the table below is the doctrine this design started from. Today a promise
> nested in HANDLER output bakes — a promise a handler passes to a component,
> and `push({ x: promise })` from handler code — because the capture waits
> for it before writing the doc record. The rule below still holds for loader
> data: a promise nested in an `ssr: false` loader's return value, or in a
> push made from a loader, stays a hole.

The PPR hole doctrine had one rule for promises: **a promise nested inside your
data is never baked; the container settles.** Two of the three data lanes
followed it when this design was written:

| Lane    | Container                                | Nested promise                                        |
| ------- | ---------------------------------------- | ----------------------------------------------------- |
| Handler | awaited data BAKES                       | handed-over pending promise HOLES (now: BAKES)        |
| Handle  | top-level `push(promise)` awaited, BAKES | `push({ x: promise })` HOLES (now: from loaders only) |
| Loader  | **whole value live OR capture refuses**  | streams (axis 1) / n/a (capture)                      |

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

> _Superseded (see the addendum):_ both faces describe the pre-#813 tree.
> Streaming `useLoader` (#813) removed the tree-build await for streaming
> lanes, so an unflagged loader is live on every entry shape and its reader
> postpones at the nearest `loading()` or inline `<Suspense>`; only a
> boundary-less read still refuses the capture. The bake lane is opted into
> per loader with `ssr: false`.

The kicker: on axis 1, a no-`loading()` loader ALREADY follows the container
rule. The tree-build await settles the CONTAINER; a promise nested inside it
passes through Flight verbatim and streams into the consumer's own `<Suspense>`
(`/shell-cache/no-hole` asserts "Streamed inner" arrives). The only place the
container rule breaks is the capture's blanket loader mask. This design makes
capture match axis 1.

## The contract

> _Superseded trigger (see the addendum):_ this section, the semantics
> matrix, and "Mechanics" below key the bake lane on an entry WITHOUT
> `loading()`. The contract now applies to `loader(Def, { ssr: false })`
> loaders on any entry shape (with nested promises masked regardless of
> settle timing, per the implementation notes); an unflagged loader is live
> whether or not its entry has `loading()`.

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

`cookies()`/`headers()` threw during capture in handler-land only (the capture
guard, today the first step of `guardIdentityRead` in `src/server/context.ts`)
and loaders were EXEMPT — safe only because masked loaders never ran. An
unmasked loader executing at capture MUST run with
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

> _Superseded (see the implementation notes, "Guard refusal is flag-based"):_
> the shipped guard stamps `_shellCaptureGuardTripped` before throwing, and
> the capture refuses whenever the flag is set, so an identity read inside a
> nested promise that runs during capture refuses too; the first sub-edge does
> not hold. The shipped refusal warning (`refuseOnCaptureGuard` in
> `shell-capture.ts`) therefore advises reading the value in a loader without
> `ssr: false` (the live lane) consumed with `useLoader`, not a nested promise.

### 3. HIT parity: extend the capture data snapshot with a loader family

The drift hazard from `ppr-shell-resume.md` applies verbatim: a HIT replays the
frozen prelude and runs a FULL FRESH Flight render for hydration; every baked
byte must agree. A re-executed loader computes a fresh container that disagrees
with the prelude — hydration mismatch. Same problem the capture data snapshot
already solves for ring-1/ring-3 reads; loader containers become a third
recorded family.

> _Since the handlers-baked change:_ a HIT's Flight render no longer runs
> handlers; it replays the handler layer from the entry's doc record. The
> bake-lane loaders are now the only shell material a HIT still executes, so
> the loader family alone is what the snapshot pins besides the doc record
> (`pruneShellSnapshot` in `src/cache/shell-snapshot.ts`). The capture no
> longer records ring-1 `"use cache"` item reads at all: a bake-lane loader
> body that runs on a HIT reads the store, not the snapshot.

- **Recording.** When the capture's tree-build await settles a no-`loading()`
  loader, record `(family: "loader", key: segmentId + loaderId, value:
container-with-promise-paths-elided)` into the same
  `ShellCacheEntry.snapshot` array (`shell-snapshot.ts`). Promise-valued paths
  are recorded as markers, not values — they are holes, not shell material.
- **Seeding.** On a HIT a hole-carrying loader RUNS FRESH, and the recorded
  container is OVERLAID: every recorded (non-promise) path takes the snapshot
  value; promise-valued paths keep the fresh run's promises. The prelude's
  baked bytes and the payload's container fields agree by construction; the
  holes stay live. A hole-free loader does not run at all (next bullet).
- **Pin-first for hole-free records.** Each loader record carries a
  capture-computed hole bit (`ShellSnapshotLoaderValue.holes`, from elide's
  walk — no per-HIT rescan). A record WITH holes gates the overlay on the
  fresh run, because only the loader body can mint the live nested promises
  the markers re-slot. A hole-free record resolves the payload promise
  IMMEDIATELY from the pin, and the loader body does NOT run: a HIT is
  rendered from the shell, like the handler layer it replays, so a live value
  would be discarded (recorded paths win wholesale) and a body run only cost a
  backend call per HIT. It used to run ungated in the background (`waitUntil`)
  for side effects and cache read-through writes; now those happen once per
  capture. The pushes such a run delivered are recorded instead: the capture
  keeps every settled, thenable-free push of a loader body (the loader's own,
  those of loaders it awaits via `ctx.use`, and a loader-cache replay's,
  which the capture store's `pushReplayed` names) under its loader
  (`CachedEntryData.handleOwners`), and the HIT restores them. A push the
  capture cannot keep (a deferred push, one with masked nested promises)
  sets `runs: 1` on the loader records
  (`ShellSnapshotLoaderValue.runs`), and those bodies still run in the
  background, rejection swallowed, so the push reaches the page; a record
  written with `runs: 0` does not run, and one without the bit (written
  before it, and lacking the pushes a capture now records) reads as
  `runs: 1`. The bit's presence is itself a fact a replay uses: a pin that
  carries it was written by a capture that recorded every settled push of
  the loader's run, so the replay drops any other settled push of that
  loader, with or without a copy in the record
  (`ShellLoaderSeedEntry.complete`). A route `cache()` record's owned values
  that a capture restores keep their owner the same way (the funnel's
  handler lane reads the owner `pushPlaceholder` names), so a replay that
  serves the loader from its pin
  restores them as that loader's (`HandleStore.pushRestored`) and a run of
  the loader there adds no copy. The pin decides that, not the request: a
  loader the replay has no pin for runs fresh, and the record's copies of its
  pushes are placeholders its run replaces (`loaderPins`,
  `docs/design/handle-push-ownership.md`). The seed is also armed for a PPR partial replay, decoded
  when its doc record hits (`matchPartialWithPprReplay`'s `onHit`, which the
  lookup awaits before the loaders resolve), so a client navigation matches
  the document HIT: hole-free loaders are served from the pin and do not run,
  hole-carrying ones run with their baked paths pinned. Before, a navigation
  ran every loader and served its fresh values. The partial path passes the
  bake key by the loader's own flag (`LoaderEntry.bake`, set on navigation
  evaluations too, unlike `awaitBeforeFlush`), so an `ssr: false` loader on
  an entry with `loading()` pins there exactly as on the document. A record
  stored before the hole bit existed reads as hole-carrying and keeps the
  gated path; TTL ages those out.
- **Pin-first drops fresh-only keys — a deliberate contract divergence.** The
  gated overlay passes fresh-only object keys through ("they cannot
  contradict prelude bytes that never rendered them"). Pin-first does NOT: a
  hole-free pin serves the pinned shape wholesale, so a key the fresh run
  starts returning mid-TTL is absent from HIT payloads until recapture. Why
  this is correct and not a loss: a fresh-only key on a hole-free record had
  no postponed hole (nothing suspended there at capture), so the prelude
  froze the consumer's without-that-field branch and the resume pass has
  nothing to fill — under the old passthrough the field could only surface
  as a payload/prelude hydration mismatch the client repaired (the exact
  divergence class the snapshot exists to prevent), never as cleanly
  streamed content. A field that varies per request belongs on the live
  surface: promise-shaped at capture (masked → hole marker → `holes: 1` →
  the gated path, where fresh-only passthrough still holds and live promises
  re-slot) or behind `loading()`. A sometimes-present plain field on a
  bake-lane loader is uncached nondeterminism in shell material — the
  documented drift residual.
- **Overlay rules for shape drift** (capture says sync, hit says promise, or
  vice versa): a recorded path always wins (pinned — it is what the prelude
  froze); a path that is a promise in BOTH runs stays the fresh promise; a NEW
  path (absent at capture) passes through fresh — it cannot contradict prelude
  bytes that never rendered it.
- **React elements: never copied, holes placed by type (issue #942).** A
  container can carry JSX (`related: <Related id={id} />`). A key-by-key copy
  loses React's non-enumerable dev fields (`_debugStack`, `_debugTask`), dev
  Flight refused it ("Attempted to render <x> without development
  properties"), and the capture crashed, so the route never HIT in dev. Now
  every walk keeps an element by identity and rebuilds one only where a
  thenable or marker sits in its props, through `cloneElementWithProps`
  (`mask-nested.ts`), which is `cloneElement` plus React's dev key-validation
  state (React 19 dev `cloneElement` resets `_store.validated`, and a keyless
  child of a static list then warns "Each child in a list should have a
  unique key").
  - The capture mask descends every element's props: a promise there
    (`<Reviews data={fetchReviews()} />`) declares per-request data by the
    same shape rule.
  - Elide places markers by what the pin encode does with the element type
    (`rendersOnServer`, `loader-snapshot.ts`, mirroring Flight's
    `renderElement`). Host (`string`), Suspense/Fragment (`symbol`) and
    client-reference elements are encoded with their props as data, so the
    marker stays inside their props and everything else about the element
    is pinned: exact parity, the same as for plain containers. A `lazy` type
    is resolved first, the way Flight resolves it: the Flight decode (a
    `cache()` hit, a `"use cache"` result) hands every client component back
    as a lazy around its client reference, and treating those as server
    components made the whole element a hole. A server component (a function
    component, `memo`/`forwardRef` around one, or a `lazy` resolving to one,
    or one that cannot resolve yet) is CALLED by the pin encode, so a marker in its props would reach
    it: an element of that type with a thenable anywhere in its props is ONE
    hole marker, and the HIT takes the fresh run's element. That is the one
    place parity is not exact — the component's other props come from the
    fresh run while the prelude holds whatever it rendered at capture — so
    they must come out the same on every run.
  - The HIT overlay rebuilds a recorded element at its marker paths only, so
    its other props stay pinned, and it reads through lazy nodes: Flight
    moves an element past ~3.2 KB of its row into a row of its own (`$L`),
    which the decode wraps in a lazy node, so a marker can sit behind one.
    Props a fresh element adds do not pass through.
  - Lazy nodes and every other object with a symbol `$$typeof` are leaves to
    the mask and elide (`isPlainDataObject`).
- **Envelope compat.** CF and Vercel shells cherry-pick entry fields into
  their own layouts (the CF frame's snapshot tail, `cf-shell-frame.ts` /
  `VercelShellEnvelope.sn`); the snapshot array itself already rides there,
  and the new family value is opaque to the stores — verify with a round-trip
  test rather than assuming.

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
