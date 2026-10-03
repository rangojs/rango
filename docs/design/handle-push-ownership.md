# Handle push ownership: one run per loader

Status: design, awaiting review. Nothing in `src/` is changed by the commit
that adds this file. The evidence is
`packages/rangojs-router/src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx`:
14 tests that state the target behavior and fail on `origin/main`
(`d42b56e7`), and 7 controls that pass today and must keep passing.

## Why you are reading this

A loader returns data and, through `ctx.use(Handle)(value)`, pushes handle
values that describe it: a title, a meta tag, a breadcrumb. The page shows
both, so they must come from the same run of the loader. That is the whole
rule.

Three issues (#1001, #1002, #1003) are three places where the page shows data
from one run next to pushes from another, or loses a push. The first fix
(PR #1018) closed them with a restore flag, a claim change and a one-microtask
yield, and opened a fourth (a navigation replay without loader pins). While
checking that fix, four more turned up on `main` that nobody had filed. When
one rule breaks in eight places, the places are not the problem. This
document names the structure that lets a value and its pushes part ways,
states the rules a path must satisfy, and proposes one change of structure
instead of an eighth patch.

If you only read one section, read "The structural cause".

## What carries a loader's value, and what carries its pushes

Start with the inventory, because the cause is visible in it: the value has
five carriers, the pushes have six, and only one artifact holds both.

| Carries the VALUE                                | Where                                                                                                                                                                                                          | Holds the pushes too?            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Live run memo (`loaderPromises`)                 | `loader-resolution.ts:483` read, `:783` write; one map per match context (`match-api.ts:143`, `:338`)                                                                                                          | no, they are in the handle store |
| Second runner memo (`getRequestContext().use`)   | `createUseFunction`, `server/request-context.ts:1855-1891`; its own map on the request context                                                                                                                 | no                               |
| `cache()` binding memo (`_loaderCacheOverrides`) | `loader-cache.ts:583-599` (the `ctx.use` interceptor), `:612` dedup, `:822` write                                                                                                                              | no                               |
| Loader `cache()` entry                           | `readThroughItem` in `loader-cache.ts:736-800`; `setItem(key, value, { handles, tags })` at `:760-764`                                                                                                         | **yes**: `handles`               |
| Shell loader pin                                 | `ShellSnapshotLoaderValue { value, holes, runs }` (`cache/types.ts:623-646`), written at `shell-capture.ts:2385-2397`, decoded by `buildShellLoaderSeed` (`shell-snapshot.ts:386-423`) into `_shellLoaderSeed` | no, they are in the doc record   |

A route `cache()` record and the prerender store never hold a loader value:
`withCacheLookup` resolves loaders fresh after every record hit
(`cache-lookup.ts:831-839`, `:308-316`), and loaders throw at build
(`setupBuildUse`, `loader-resolution.ts:958-963`).

| Carries the PUSHES                                                    | Where                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live push                                                             | `HandleStore.push`, `server/handle-store.ts:621-697`                                                                                                                                       |
| Loader `cache()` entry's `handles` blob                               | recorded on the MISS by `startHandleCapture` (`loader-cache.ts:694-698`), replayed on a HIT by `replayLoaderHandles` (`:332-369`, called at `:804-812`) through `pushReplayed`             |
| Shell doc record's `handles` + `handleOwners`                         | written by `CacheScope.cacheRoute` (`cache-scope.ts:1070-1118`) from the capture's push funnel (`shell-capture.ts:2024-2073`), restored by `restoreHandles` (`handle-snapshot.ts:185-232`) |
| Route `cache()` record's `handles` + `handleOwners`                   | the same writer; it carries loader-owned values only when a capture render wrote it (a normal render tags loader pushes out, `handle-snapshot.ts:113-122`)                                 |
| A dependency group in another loader's entry or a `"use cache"` entry | `recordOwnerKey` (`loader-cache.ts:407-418`), `appendHandles` (`handle-snapshot.ts:250-280`)                                                                                               |
| A run on the HIT for what the record could not keep                   | deferred (thenable) pushes stay out of the record (`shell-capture.ts:2044-2047`, `:2071`); the pin's `runs` bit asks for a run (`loader-cache.ts:521-525`)                                 |

How a stored copy lands in the store is chosen by the caller, from six
primitives keyed by loader id: `pushReplayed` (a live push of that loader
replaces it), `pushRestored` (it stands, and that loader's settled pushes are
dropped), `markLiveLane` (which loaders are holes), `settleLoaderRun`,
`redeliverReplays`, and the first-come `_claimLoaderPushes`
(`loader-resolution.ts:816-822`).

## The structural cause

Four facts, each checkable against the tables above.

1. **The value and the pushes are decided in different places, by different
   conditions.** The value is picked per loader, late, in `resolveLoaderData`
   (`loader-cache.ts:465-542`): a pin if `_shellLoaderSeed` has this segment
   key (`:495-539`), else the loader's `cache()` entry, else a run. The pushes
   are picked per request, early, in `withCacheLookup`
   (`cache-lookup.ts:556-562`), before any loader has resolved, from the
   request's type and the DSL flags: `restore = tailMarker.docTail === true`,
   `liveLane = liveLaneLoaderIds(ctx.entries)`, and a claim. "This is a
   document tail" and "this loader is registered `ssr: false`" correlate with
   "this loader's value comes from the pin". They are not the same fact. A
   navigation replay serves pins without being a document tail (#1003,
   #1001). A document tail whose pins `maxSnapshotBytes` dropped is a
   document tail without pins. PR #1018 keyed the restore on the implicit doc
   scope instead, a third stand-in, and broke the entry that has that scope
   and no pins.

2. **Copies of a loader's pushes travel without its value.** The shell keeps
   pins and pushes in separate records, and three things drop the pins and
   keep the pushes: `pruneShellSnapshot` for a navigation-only entry
   (`shell-snapshot.ts:248-262`), the `maxSnapshotBytes` guard
   (`shell-capture.ts:2450-2455`), and a pin that fails to decode
   (`shell-snapshot.ts:412-414`). A route `cache()` record holds a loader's
   pushes and never its value. Another entry can hold them as a dependency
   group. Every such copy is a candidate for being shown next to a value from
   somewhere else, and `_claimLoaderPushes` settles the contest by arrival
   order: the first copy delivered blocks the loader's own entry from
   replaying (`loader-cache.ts:804-812`).

3. **A loader has three per-request memo tables, and timing picks one.** A
   reader's `ctx.use(Loader)` finds the binding's value only if the binding
   already registered (`loader-resolution.ts:480-483`); otherwise it starts a
   live run in `loaderPromises`. The binding then reads its cache without
   looking at `loaderPromises` (`loader-cache.ts:612`, `:736`). One request
   holds two values for one loader, and the claim pairs the entry's data with
   the other run's push (#1002). "Already registered" depends on declaration
   order, on whether the reader awaits before it reads, and on the entry: the
   route loop kicks off synchronously (`fresh.ts:151-186`), the intercept
   loop awaits between kickoffs (`intercept-resolution.ts:267-344`), and a
   parent layout resolves long before its child route.

4. **Nothing identifies a run.** A slot in the handle store is tagged with a
   loader id (`SlotTag.replayOf`, `liveOf`, `owner`, `restoredOf`,
   `handle-store.ts:55-68`), never with which run or artifact produced it. A
   value carries tags and an identity mark, never a source.
   `LoaderRunIdentity` (`server/context.ts:1167`) exists per execution, for
   the `"use cache"` identity guard (#1011) only. So no code can ask "do this
   value and this push belong together"; each path has to get it right by
   construction, and the construction is spread over the two decision points
   above.

## The invariants

A path is correct when it satisfies these. They are what the tests assert.

1. **One source.** On a request, each loader has one source: the shell
   record's **pin**, its own `cache()` **entry**, or a **run** in this
   request. The data the page shows and the settled values the loader pushed
   both come from it.
2. **A HIT runs no body.** When a loader's `cache()` entry hits, its body
   does not run in that request, whoever reads the loader first.
3. **One value.** Every reader of a loader in a request, the binding and each
   `ctx.use`, gets the same value. Declaration order and where a reader
   awaits do not change it.
4. **A copy is not a source.** A stored copy of a loader's pushes stands only
   on a request where the same artifact supplies the loader's value.
   Otherwise it is a placeholder: the loader's source replaces it, with
   nothing if the source pushed nothing.
5. **A deferred push is a hole.** A thenable push is never in a shell record.
   Wherever the pin is replayed it is delivered once, by the loader's
   `cache()` entry when that hits, else by a run. Its value may be newer than
   the pin: nesting is liveness, as for a promise nested in bake-lane data.
6. **An entry is whole.** A loader `cache()` entry holds a value and the
   pushes of the run that produced it, or it is treated as a miss.
7. **Same shell, same answer.** A document HIT, a navigation replay and a
   prefetch replay of one shell entry show the same data and pushes for the
   same store state.
8. **Once.** Each push shows once.

## The path table

"Today" is `origin/main`. A row marked RED has a failing test in the evidence
file; the others are pinned by a passing control there or by an existing test
in `serve-shell-request.rsc-test.tsx`, except the stale-entry row, which is
from reading the code.

A promise-carrying `ssr: false` loader (it runs on every replay):

| Path                                                              | Data today | Settled push today    | Target    |
| ----------------------------------------------------------------- | ---------- | --------------------- | --------- |
| Document MISS (render and capture)                                | run        | run                   | unchanged |
| Document HIT, pins present                                        | pin        | record                | unchanged |
| Navigation replay, pins present                                   | pin        | **run** (RED, #1003)  | record    |
| Prefetch replay (`X-Rango-Prefetch`), pins present                | pin        | **run** (RED)         | record    |
| Navigation, explicit route `cache()` misses, seeded record serves | pin        | **run** (RED)         | record    |
| Navigation, explicit route `cache()` hits                         | run        | run                   | unchanged |
| Navigation replay, navigation-only entry (no pins)                | run        | run (broken by #1018) | unchanged |
| Navigation replay, pins dropped by `maxSnapshotBytes`             | run        | run (broken by #1018) | unchanged |
| Document HIT, pins dropped by `maxSnapshotBytes`                  | run        | **record** (RED)      | run       |

Other loaders on a shell replay:

| Path                                                                              | Today                                                                   | Target                      |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| Promise-free `ssr: false` loader with `cache()` and a deferred push, document HIT | body 0, data pin, settled record, deferred from the entry               | unchanged                   |
| The same, navigation replay                                                       | deferred push **missing** (RED, #1001, both variants)                   | deferred from the entry     |
| Dependency a pinned loader awaited (registered on neither lane)                   | its captured push stands                                                | unchanged                   |
| The same dependency, document HIT without pins                                    | awaiting loader's data from the run, dependency's push **record** (RED) | run                         |
| Live-lane loader (a hole), with or without its own `cache()`                      | data and pushes from its entry or its run                               | unchanged                   |
| Dependency a pinned loader and a live loader share (`/shared-dep`)                | captured push next to the live reader's fresh data, documented          | unchanged (open question 5) |

A route `cache()` record that holds a loader's push (a ppr route under
`cache()`; the capture wrote the record):

| Path                                                                       | Today                                  | Target    |
| -------------------------------------------------------------------------- | -------------------------------------- | --------- |
| Document MISS of the shell, record hits, the loader's `cache()` entry hits | data entry, push **record copy** (RED) | entry     |
| The same, the loader has no `cache()`                                      | run, run                               | unchanged |

A loader with its own `cache()` that something reads with `ctx.use()`
(any route, `ppr` or not):

| Reader                                                         | Entry HIT today                                                                              | Target                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------- |
| The binding's own route handler, or a loader declared after it | body 0, data and push from the entry                                                         | unchanged                  |
| Sibling loader declared before the binding                     | body **runs**, data entry, push **run**, reader sees the run (RED, #1002)                    | body 0, all from the entry |
| The same on an intercept                                       | the same split (RED; #1018 does not cover it)                                                | body 0, all from the entry |
| Parent layout's loader                                         | the same split (RED; #1018 leaves it by design)                                              | body 0, all from the entry |
| Parent layout's handler                                        | the same split (RED)                                                                         | body 0, all from the entry |
| `ssr: false` reader on a ppr route, HIT and navigation replay  | the same split (RED, #1002)                                                                  | body 0, all from the entry |
| Any of the above, entry MISS                                   | one run shared, but the entry it writes has **no pushes** (RED)                              | the entry records them     |
| Stale entry (SWR)                                              | stale data and the stale entry's pushes; the refresh is diverted (`loader-cache.ts:691-698`) | unchanged                  |

A route without `ppr` and without loader `cache()`, and a prerendered route,
run every loader per request: data and pushes are the run's. Unchanged.

## The options

**a. Store the pushes with the value.** A pin record would carry its loader's
settled pushes, the doc record only handler pushes, and a route `cache()`
record no loader pushes at all. Dropping a pin would drop its pushes, so
fact 2 could not arise for shells. The cost: a loader's pushes interleave
with handler pushes in one segment array (that is why `handleOwners` is
index-aligned), so the pin would need positions; the shell entry format
changes in three stores, and entries written before it need today's read path
anyway for their lifetime. And it does nothing for facts 1 and 3: the loader
`cache()` entry already stores value and pushes together, and it still leaks,
because a first-come claim blocks its replay and a reader-first run writes it
without pushes. Co-location is neither sufficient nor necessary. The property
it gives (invariant 4) can be enforced when the record is read.

**b. One resolver.** One place decides, per loader per request, where its
value comes from, and the push delivery follows that decision instead of
making its own. Every reader goes through it. This removes facts 1 and 3
directly and turns fact 2's copies into placeholders by rule. Cost: a
per-request table of the route's loader bindings, and `ctx.use` routed
through it. Recommended.

**c. Tag values and pushes with a run id, check at delivery.** It would
detect a mismatch on any path, including ones nobody thought of. But a value
is opaque user data, so the id lives in a side table per request and in every
stored artifact (a format change in all of them), and a check that fails at
delivery can only drop a push or warn: it does not know which side is right.
It makes a leak visible, not impossible. Worth considering later as a
development-mode assertion over design b; not a mechanism.

**d. The patch set: PR #1018 plus the `loaderPins` fix.** Measured by running
the evidence file against `agent/1018-verify` (`99e593c6`): 15 of 21 pass, 6
fail. Still broken: the `maxSnapshotBytes` document HIT, the dependency
without pins, the route record's copy, and the layout-loader, layout-handler
and intercept readers. It adds a `restore` condition on the implicit doc
scope, a `loaderPins` field on the replay marker, a widened `liveLane` for
the pin-less case, a `deferred` parameter and a microtask yield in
`useLoader`, and a `loaderCacheBoundIds` set allocated per request. Each
remaining failure would need one more of these. This is the baseline to beat.

## The recommended design

Two changes. Each replaces a timing- or type-dependent decision with a lookup
of a fact that already exists.

### 1. The pin decides both the value and the pushes

The question "is this loader served from the shell record on this request"
has one answer and one owner: the loader seed. `resolveLoaderData` already
asks it for the value. `restoreHandles` will ask the same accessor for the
pushes, and `withCacheLookup` stops deciding.

- `OwnedPushDelivery` loses `restore`, `liveLane` and `claim`. It carries one
  thing: `pinned(loaderId)`, backed by `_shellLoaderSeed` through an accessor
  that lives next to `resolveLoaderData`'s pin lookup. A later change that
  makes a pin not apply (a new skip condition) goes into that accessor and
  reaches both sides.
- An owner the accessor says is pinned is restored as today (`pushRestored`):
  the record stands, the loader's settled pushes are dropped, its thenable
  ones are added. Nothing is claimed, so its own `cache()` entry delivers the
  deferred push on a navigation exactly as on a document HIT (#1001).
- Every other owner is a placeholder with the semantics a hole has today:
  unclaimed `pushReplayed`, replaced by its run's pushes, dropped when its
  run ends without one, and replaced by its own entry's recorded pushes when
  that entry hits (`redeliverReplays`, without the hole-only gate). "Hole"
  stops meaning "registered without `ssr: false`" and means "not served from
  this record's pin on this request", which is what the store's rules needed
  all along.
- A dependency the route does not register has no pin of its own. Its copies
  stand while every `ssr: false` loader of the route is pinned, and are
  placeholders otherwise. That is exact when the pins are all present or all
  gone (the navigation-only and `maxSnapshotBytes` cases), and conservative
  when one pin failed to decode.
- A route `cache()` record outside a shell replay has no pins: every owner in
  it is a placeholder. The claim in `restoreHandles` goes away, and with it
  the case where a record's copy blocks the loader's own entry.
- `CacheScope.lookupRouteDetailed` awaits `onHit` (which arms the seed on a
  navigation, `rsc-rendering.ts:1542-1550`) before `restoreHandles` instead
  of after (`cache-scope.ts:887-908`).

Document HIT, navigation replay, prefetch replay and the seeded fallback
after an explicit miss then run the same code with the same input, which is
invariant 7.

### 2. `ctx.use(Loader)` resolves through the route's bindings

The matched chain is known when the match context is built, and so is the
active intercept (`match-api.ts:391-407`). From them the request gets a
binding table: loader id to its `LoaderEntry` and owning segment, for the
loaders bound with `cache()`. It is built on the first read that needs it and
only when `bindsLoaderCache(entries)` or the intercept binds one, so a
request without a cached loader pays one `undefined` check.

`useLoader` (`loader-resolution.ts:436`) consults the table before the live
memo. A read of a bound loader goes to that binding's read-through
(`executeLoaderData`), starting it if the DSL kickoff has not reached it yet;
the kickoff then gets the same promise through the existing dedup
(`loader-cache.ts:612`). So:

- order stops mattering, inside an entry and across entries;
- a parent layout's loader or handler reading a child route's cached loader
  gets the binding's value without waiting for the child's kickoff, so there
  is no deadlock to avoid and no yield to tune;
- an intercept's bindings are in the table, so intercepts need no separate
  rule;
- a MISS runs the body once, inside the binding's capture, so the entry it
  writes has the pushes (invariant 6);
- the `ctx.use` interceptor and `_loaderCacheOriginalUse`
  (`loader-cache.ts:583-600`), the `bound ||` branch in `useLoader`, and the
  "a reader started it first" tag link in `_bindLoaderCacheTags`
  (`loader-resolution.ts:827-831`) lose their reason to exist. The loader
  skill's caveat about a reader's entry missing the binding's `cache({ tags })`
  goes with them.

Two constraints the implementation must hold, both testable:

- A binding a reader starts runs in the binding's scope, not the reader's:
  inside the DSL loader scope (so `ctx.rendered()` and auxiliary tracking
  behave as for a kickoff) and outside the reader's loader-body scope (the
  store reads that scope to attribute a push, and `replayLoaderHandles`
  already documents why it must not run inside one).
- Its pushes attribute to the binding's segment, not to whatever
  `_currentSegmentId` is when the reader calls.

### On the #1002 rule

The working decision is right: a reader of a `cache()`-bound loader gets the
binding's value, and a HIT runs no body. Three reasons. It is what already
happens when the binding starts first or a handler on the same route reads,
so the opposite rule would change the common arrangement to fix the rare one.
The opposite rule (the binding reuses the reader's run and skips its cache)
makes `cache()` silently do nothing under an ordering the author cannot see.
And the entry is the one artifact that stores a value with its pushes, so
serving from it satisfies invariant 1 without further work.

The one-microtask yield is the wrong mechanism for it. It is correct only
when the binding registers within one microtask of the read, which holds for
siblings in one synchronous kickoff loop and for nothing else; the evidence
file shows it failing for the intercept and for both parent-layout readers.
The binding table has no timing in it.

What still gets a live run under this design, and why:

| Arrangement                                                                         | Why it runs                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The loader is not bound with `cache()` in the matched chain or the active intercept | no binding on this request, so no entry is served for it; one run, memoized                                  |
| The binding's `condition()` is false, or it has no item store                       | the binding itself runs live; every reader shares that run                                                   |
| The entry misses                                                                    | one run, inside the binding's capture, shared by every reader                                                |
| A stale refresh's reads (`_runLoaderIsolated`)                                      | deliberate: a refresh must not rebuild its entry from another stale entry (`loader-resolution.ts:833-850`)   |
| `getRequestContext().use(Loader)`                                                   | the second runner has its own memo (`request-context.ts:1855-1891`); not routed in stage 1 (open question 6) |
| A reader of a loader the shell pinned                                               | the page shows the pin, the reader gets the entry or a run; the pushes follow the pin. Stage 2               |

A layout loader reading a child route's cached loader is no longer on this
list.

## Compatibility and risk

**Stored formats.**

- Shell entries: unchanged. No field is added or reinterpreted; `holes` and
  `runs` keep their meaning, and a v0.17 pin without the bits still reads as
  both (`shell-snapshot.ts:405-409`). Old entries read by the new code and
  new entries read by the old code behave as each code does today.
- Route `cache()` records: unchanged. The new code reads `handleOwners` as
  placeholders; the old code reads the same records with a claim.
- Loader `cache()` entries: an entry the old code wrote while a reader had
  started the loader first has no `handles` (RED test "the entry a request
  writes records the cached loader's pushes"). The old code hid that: the
  reader's run pushed live on every request. The new code runs no body on a
  HIT, so such an entry would show no push until it expires. Two ways to
  handle it, open question 1:
  - a completeness marker: the new code writes a one-character `handles`
    sentinel when a run pushed nothing, and treats an entry without `handles`
    as a miss, once. Old code reading a new entry decodes the sentinel to
    nothing, as it does a missing blob (`decodeHandleValue` returns null on a
    failed decode, `handle-snapshot.ts:88-95`). The cost is one body run per
    old entry after the upgrade on a store that does not version its keys per
    deploy. It also gives invariant 6 a mechanism: an entry whose handle
    encode timed out is written without the marker and reads as a miss,
    instead of serving a value without its pushes as today
    (`loader-cache.ts:802-803`);
  - no marker, and a changelog note to bump the store `version` or
    `updateTag()` the affected loaders, as #972 did for the identity mark.

**Semantic matrix.** `[C1]` and `[C2]` hold. No existing row encodes "a
reader that ran before the binding gets its own run". The change adds rows
(a reader before the binding, on a document request and on a navigation) and
rewrites the "One value per loader per request" guarantee in
`docs/internal/execution-model.md:89-99`, plus the shell paragraph at
`:114-143`.

**Behavior an existing app can observe.** All of these are the rule being
applied; they are still changes, and the first is breaking.

| Arrangement                                                         | Was                                                    | Becomes                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| A reader that ran before a `cache()` binding, entry HIT             | fresh value for the reader; the body ran every request | the cached value; the body does not run               |
| The same loader's pushes                                            | live                                                   | the entry's                                           |
| The same loader's pushes when a parent started it                   | attributed to the parent's segment                     | attributed to the binding's segment                   |
| Side effects in that body                                           | once per request                                       | once per MISS                                         |
| Navigation replay, `ssr: false` loader that runs                    | live settled push; a deferred push from its entry lost | the capture's settled push; the deferred push arrives |
| Document HIT of an entry without pins                               | the capture's push next to fresh data                  | the run's push                                        |
| ppr route under `cache()`, the loader's entry newer than the record | the record's copy                                      | the entry's push                                      |

**Hot path.** No Set is allocated per request: the binding table is built
lazily and only for a chain `bindsLoaderCache` already flagged (memoized per
entry). `useLoader` gains one map lookup when the table exists. The restore
computes the pinned ids once per record that has owners. `onHit` moves, it
does not multiply. With the marker, a HIT of an entry that pushed nothing
compares one character instead of skipping the decode on an empty string.

**Risk.** The binding-scope constraint above is the part with the least
existing coverage: today a binding always starts from a kickoff. The semantic
matrix must run for it (`segment-resolution/` is gated on it). The pin
accessor is a small change over primitives that have the most tests in this
area (`handle-store.test.ts`, `cache-record-loader-pushes.test.ts`, the
restored-pushes block of `serve-shell-request.rsc-test.tsx`); those pin #888,
#929 and #936 and must stay green unchanged, except
"a cached hole a bake-lane loader starts first keeps its push in the captured
place", which asserts the live push the rule now replaces.

## Delivery

One PR can carry stage 1. It is two mechanisms, each independently testable,
and it is smaller than the patch set it replaces in flags.

**Stage 1 (closes #1001, #1002, #1003, the #1018 regression, and the four
unfiled paths):**

1. The pin accessor and the `OwnedPushDelivery` reduction; `withCacheLookup`
   stops reading `docTail` for pushes; `onHit` before the restore; the
   own-entry redelivery without the hole gate.
2. The binding table and `useLoader` routing; removal of the interceptor and
   the reader-first branches.
3. The entry marker, if open question 1 says so.
4. The 14 `red` tests become plain `it`. Unit tests next to
   `handle-store.ts`, `handle-snapshot.ts`, `cache-lookup.ts`,
   `loader-resolution.ts` and `loader-cache.ts`. Browser e2e for the three
   issues in both apps, dev and production. Docs, changelog (`### Breaking:`
   for the reader rule), matrix rows.

**Stage 2 (follow-ups; each extends stage 1, none deletes it):**

- The table covers every registered loader, with its bake key, so a reader of
  a pinned loader gets the pin: one value per loader on shell replays too.
  The pin question then moves from the restore into the resolver, and the
  accessor keeps one caller.
- The store's six primitives fold into one statement of a loader's source.
  A refactor with no behavior change, held by stage 1's tests.
- A capture stops writing loader-owned pushes into a real route `cache()`
  record: an artifact that can only ever hold a copy.
- The shell record names the registered loader that ran a dependency, which
  replaces the all-pinned approximation for dependencies.
- `getRequestContext().use()` joins the table.

## The evidence

All in `serve-shell-request-push-ownership.rsc-test.tsx`, run from
`packages/rangojs-router` with
`./node_modules/.bin/vitest run --config vitest.rsc.config.ts src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx`:
`7 passed | 14 expected fail (21)`, four runs, the same each time. The
failing assertions below were captured with the tests as plain `it` before
they were marked.

| RED test                                                                                | Fails on `main` with                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| a navigation replay keeps the captured push next to the pinned data                     | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (data `eb@g1`)        |
| a prefetch replay keeps the captured push next to the pinned data                       | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]`                       |
| a document HIT of an entry whose pins maxSnapshotBytes dropped ...                      | `expected [ 'eb-after@g1' ] to deeply equal [ 'eb-after@g2' ]` (data `eb@g2`)        |
| without pins a dependency's push follows the fresh run of the loader that awaits it     | hit: data `baked-dep@g2`, push `dep-note@g1`, expected `dep-note@g2`                 |
| a navigation whose explicit route cache() misses replays the shell record ...           | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (data `eb@g1`)        |
| a navigation replay delivers the deferred push ... (the entry misses at capture)        | nav: `deferred: []`, expected `[ 'deferred-note-2' ]`                                |
| a navigation replay delivers the deferred push ... (the entry is warm at capture)       | nav: `deferred: []`, expected `[ 'deferred-note-1' ]`                                |
| a document MISS that hits the route cache() record and the loader's cache() entry ...   | `expected [ 'owned-note@g1' ] to deeply equal [ 'owned-note@g2' ]` (data `owned@g2`) |
| the entry a request writes records the cached loader's pushes when a reader started ... | `expected '' to contain 'sch-note@g1'`                                               |
| a sibling loader declared before the binding (a route without ppr)                      | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2`             |
| a parent layout's loader reading a child route's cached loader                          | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2`             |
| a parent layout's handler reading a child route's cached loader                         | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `layout-sch@g2`             |
| a sibling loader declared before the binding on an intercept                            | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2`             |
| a ppr route: an ssr: false reader declared before the cached hole ...                   | `bodyRuns: 2`; hit and nav: data `sch@g2`, push `sch-note@g3`                        |

Controls that pass today: the document HIT with pins; the navigation replay
of a navigation-only entry and of a `maxSnapshotBytes` entry (the #1018
regression: both fail on the #1018 head `5ca6c967`, with
`expected [ 'eb-after@g1' ] to deeply equal [ 'eb-after@g2' ]` and
`... [ 'eb-after@g3' ]`); a dependency next to its pinned loader; an explicit
route `cache()` hit on a navigation; a handler on the binding's own route;
the ppr reader declared after the hole.

Not probed, stated from reading only: a `"use cache"` entry that recorded a
bound loader's pushes can claim them ahead of that loader's own entry
(`appendHandles`, `handle-snapshot.ts:250-280`), the same contest as the
route record's copy; and `getRequestContext().use(Loader)` on a route that
also binds the loader runs it a second time.

## Open questions

1. Old loader `cache()` entries: the completeness marker (one refill per key
   after the upgrade, no visible gap) or a changelog note (no refill, a
   missing push until the entry expires)? The recommendation is the marker.
2. Dependencies when the pins are partial: is "stands while every
   `ssr: false` loader is pinned" acceptable for stage 1, or should the shell
   record name the loader that ran each dependency now (an additive field)?
3. A reader of a pinned loader: leave for stage 2, or widen the table in
   stage 1? It changes what such a reader sees on a HIT (the capture's value
   instead of a fresh one).
4. A cached loader a parent started pushes into the binding's segment under
   this design, which moves that push to where the binding-first order puts
   it. Confirm that is the wanted order.
5. `/shared-dep` keeps a captured push next to a live reader's fresh data, by
   documented choice. Leave it, or bring it under the rule (it would need the
   field from question 2)?
6. `getRequestContext().use(Loader)`: route it through the table, and when?
7. The four unfiled paths fall out of the same two changes. Fix them in the
   same PR (recommended), or file them and keep the PR to the three issues?
8. Browser e2e: the three issues in both apps, dev and production. Which of
   the other paths need a browser test, beyond their `serveShellRequest`
   coverage?
