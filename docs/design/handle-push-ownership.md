# Handle push ownership: one run per loader

Status: half built. Change 1 ("the pin decides both the value and the
pushes") is in `src/` and closes #1001 and #1003, plus the paths nobody had
filed that the same change covers. Change 2 (the binding table) is designed
here and not built: #1002 stays open, and its tests stay expected failures.
"What is built" and "What is not built" below say exactly where the line is.

The evidence is
`packages/rangojs-router/src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx`:
27 tests. 11 of them failed on `origin/main` (`eed288b1`) and pass now, 9 are
controls that passed before and still do, and 7 are expected failures: the
six #1002 cases and one gap found while building change 1.

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
states the rules a path must satisfy, and proposes two changes of structure
instead of an eighth patch. The first is built; the second waits on the open
questions at the end.

If you only read one section, read "The structural cause". If you are here
to change the code, read "The recommended design" for what is built and
"What is not built" for where it stops.

## What carries a loader's value, and what carries its pushes

This section and the next describe the code as it was before change 1: the
`path:line` references in them are to `origin/main` at `eed288b1`, where you
can check each claim. "What is built" has the references for the code as it
is now.

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

Three columns: `origin/main` before change 1, the code now (change 1), and
the target once change 2 lands. A cell reads "data / settled push", each
naming its source: **pin** (the shell entry's pin and its record), **run** (a
run in this request), **entry** (the loader's own `cache()` entry),
**record** (a copy in a record that does not supply the value). A mismatch is
in bold. "same" means the column to its left. Every row except the
stale-entry one is pinned by a test in the evidence file or in
`serve-shell-request.rsc-test.tsx`.

A promise-carrying `ssr: false` loader (it runs on every replay):

| Path                                                              | `origin/main`                 | Now (change 1) | After change 2                         |
| ----------------------------------------------------------------- | ----------------------------- | -------------- | -------------------------------------- |
| Document MISS (render and capture)                                | run / run                     | same           | same                                   |
| Document HIT, pins present                                        | pin / pin                     | same           | same                                   |
| Navigation replay, pins present                                   | **pin / run** (#1003)         | pin / pin      | same                                   |
| Prefetch replay (`X-Rango-Prefetch`), pins present                | **pin / run**                 | pin / pin      | same                                   |
| Navigation, explicit route `cache()` misses, seeded record serves | **pin / run**                 | pin / pin      | same                                   |
| Navigation, explicit route `cache()` hits                         | run / run                     | same           | same                                   |
| Navigation replay, navigation-only entry (no pins)                | run / run (PR #1018 broke it) | same           | same                                   |
| Navigation replay, pins dropped by `maxSnapshotBytes`             | run / run (PR #1018 broke it) | same           | same                                   |
| Document HIT, pins dropped by `maxSnapshotBytes`                  | **run / record**              | run / run      | same                                   |
| Any replay without pins, the run makes no push                    | **run / record**              | run / none     | same                                   |
| Pinned, the capture's run pushed nothing and the replay's pushes  | **pin / run**                 | **pin / run**  | not designed (see "What is not built") |

Other loaders on a shell replay:

| Path                                                                              | `origin/main`                                                  | Now (change 1)                     | After change 2        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------- | --------------------- |
| Promise-free `ssr: false` loader with `cache()` and a deferred push, document HIT | pin / pin, deferred from the entry                             | same                               | same                  |
| The same, navigation replay                                                       | pin / pin, deferred push **missing** (#1001)                   | pin / pin, deferred from the entry | same                  |
| `ssr: false` loader with `cache()`, no pins, its entry newer than the shell       | **entry / record**, its dependency's push too                  | entry / entry, each once           | same                  |
| Dependency a pinned loader awaited (registered on neither lane)                   | pin / pin                                                      | same                               | same                  |
| The same dependency, any replay without pins                                      | **run / record**                                               | run / run                          | same                  |
| A `"use cache"` entry's copy of a dependency's push, replay without pins          | entry / record, once                                           | entry / entry, once                | same                  |
| Live-lane loader (a hole), with or without its own `cache()`                      | its run's or its entry's, both                                 | same                               | same                  |
| Dependency a pinned loader and a live loader share (`/shared-dep`)                | captured push next to the live reader's fresh data, documented | same                               | same (decided: leave) |

A route `cache()` record that holds a loader's push (a ppr route under
`cache()`; the capture wrote the record):

| Path                                                                       | `origin/main`      | Now (change 1) | After change 2 |
| -------------------------------------------------------------------------- | ------------------ | -------------- | -------------- |
| Document MISS of the shell, record hits, the loader's `cache()` entry hits | **entry / record** | entry / entry  | same           |
| The same, the loader has no `cache()`                                      | run / run          | same           | same           |

A loader with its own `cache()` that something reads with `ctx.use()`
(any route, `ppr` or not). This is #1002, untouched by change 1:

| Reader, on an entry HIT                                        | `origin/main` and now                                            | After change 2             |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| The binding's own route handler, or a loader declared after it | body 0, entry / entry                                            | same                       |
| Sibling loader declared before the binding                     | body **runs**, **entry / run**, the reader sees the run          | body 0, all from the entry |
| The same on an intercept                                       | the same split (PR #1018 does not cover it)                      | body 0, all from the entry |
| Parent layout's loader                                         | the same split (PR #1018 leaves it by design)                    | body 0, all from the entry |
| Parent layout's handler                                        | the same split                                                   | body 0, all from the entry |
| `ssr: false` reader on a ppr route, HIT and navigation replay  | the same split                                                   | body 0, all from the entry |
| Any of the above, entry MISS                                   | one run shared, but the entry it writes has **no pushes**        | the entry records them     |
| Stale entry (SWR)                                              | stale data and the stale entry's pushes; the refresh is diverted | same                       |

A route without `ppr` and without loader `cache()`, and a prerendered route,
run every loader per request: data and pushes are the run's. Unchanged
throughout.

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
the evidence file, as it stood at design time with 21 tests, against
`agent/1018-verify` (`99e593c6`): 15 of 21 pass, 6 fail. Still broken: the `maxSnapshotBytes` document HIT, the dependency
without pins, the route record's copy, and the layout-loader, layout-handler
and intercept readers. It adds a `restore` condition on the implicit doc
scope, a `loaderPins` field on the replay marker, a widened `liveLane` for
the pin-less case, a `deferred` parameter and a microtask yield in
`useLoader`, and a `loaderCacheBoundIds` set allocated per request. Each
remaining failure would need one more of these. This is the baseline to beat.

## The recommended design

Two changes. Each replaces a timing- or type-dependent decision with a lookup
of a fact that already exists.

### 1. The pin decides both the value and the pushes (built)

The question "is this loader served from the shell record on this request"
has one answer and one owner: the loader seed. `resolveLoaderData` already
asked it for the value. `restoreHandles` now asks the same accessor for the
pushes, and `withCacheLookup` no longer decides. This is what is in `src/`
(paths under `packages/rangojs-router/src/`, line numbers as of the commit
that built it):

- **One accessor.** `servedPins(reqCtx)`
  (`router/segment-resolution/loader-cache.ts:296`) returns the seed, or
  nothing during a capture. `resolveLoaderData` reads a loader's pin through
  it (`:591`). `loaderPins(entries, reqCtx)` (`:329`) reads the same seed to
  say which loaders are pinned. A condition that makes a pin not apply goes
  into `servedPins`, and reaches both sides.
- **The delivery is the accessor's answer.** `OwnedPushDelivery`
  (`cache/handle-snapshot.ts:145`) lost `restore`, `liveLane` and `claim`.
  It is now `pinned(loaderId)`, `unpinned()` (the registered loaders that are
  not pinned) and `seeded` (the request has a seed at all). `withCacheLookup`
  builds it with `loaderPins(ctx.entries, pipelineReqCtx)`
  (`router/match-middleware/cache-lookup.ts:556`) and hands it to both
  lookups, the explicit one and the seeded fallback. It reads no `docTail`
  and no lane for pushes.
- **A pin's loader comes from its key.** The seed is keyed by loader segment
  id, `${shortCode}D${index}.${loaderId}`. A shortCode holds no "D" and no
  "." and a loader id can hold both, so `pinLoaderId` (`loader-cache.ts:311`)
  cuts at the first `D<index>.`. The alternative, recomputing each registered
  loader's segment id from the entries, would be a third copy of the
  enumeration `fresh.ts` and `revalidation.ts` already keep in step. A key
  that does not parse pins nothing.
- **A pinned owner is restored and stands** (`pushRestored`,
  `handle-snapshot.ts:217`): the loader's settled pushes on the replay are
  dropped, its thenable ones are added. Nothing is claimed, so its own
  `cache()` entry delivers the deferred push on a navigation exactly as on a
  document HIT (#1001). A loader the route also registers without
  `ssr: false` is never pinned.
- **Every other owner is a placeholder**: unclaimed `pushReplayed`, and its
  loader a hole (`HandleStore.markHoles`, `server/handle-store.ts:730`,
  formerly `markLiveLane`). Its run's pushes replace it, a run that ends
  without one drops it (`settleLoaderRun`), and a cached unit that claims the
  loader delivers in its place. "Hole" stops meaning "registered without
  `ssr: false`" and means "not served from this record's pin on this
  request", which is what the store's rules needed all along.
- **A cached unit's HIT replaces the placeholders of every loader it
  claims.** `redeliverReplays` (`handle-store.ts:746`) takes the claimed
  loaders, has no hole-only gate, and removes their placeholders in one pass
  per array, so two loaders that share an array get one anchor and the
  entry's pushes keep their recorded order. `replayLoaderHandles`
  (`loader-cache.ts:427`) passes the cached loader and the dependencies its
  entry recorded; `appendHandles` (`handle-snapshot.ts:252`) passes the
  loaders a `"use cache"` entry recorded, and only when it has a claim (a
  stale refresh has none: its pushes are diverted, and removing the page's
  placeholders for them would leave the page without the push). Without
  this, an unclaimed placeholder and the entry's copy would both show.
- **A dependency the route does not register** has no pin of its own. Its
  copies stand while every `ssr: false` loader of the route is pinned, and
  are placeholders otherwise (`loaderPins`, `dependenciesPinned`). That is
  exact when the pins are all present or all gone (the navigation-only and
  `maxSnapshotBytes` cases), and conservative when one pin failed to decode.
- **A route `cache()` record outside a shell replay has no pins**, so every
  owner in it is a placeholder. The claim in `restoreHandles` is gone, and
  with it the case where a record's copy blocks the loader's own entry.
- **The seed is armed before the restore.** `CacheScope.lookupRouteDetailed`
  awaits `onHit` (which arms the seed on a navigation) before
  `restoreHandles` instead of after (`cache/cache-scope.ts:878`). The
  delivery is lazy for the same reason: `withCacheLookup` builds it before
  the lookup that arms the seed.
- **When the holes are marked.** For a record that has owners, or on a
  request that has a seed. A record without owners on an unseeded request
  restores as a plain replay, so a route without `ppr` (whose records never
  have owners) keeps the loader-cache rules it had.

Document HIT, navigation replay, prefetch replay and the seeded fallback
after an explicit miss now run the same code with the same input, which is
invariant 7.

### 2. `ctx.use(Loader)` resolves through the route's bindings (not built)

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

## What is not built

Change 1 did not need any part of change 2. The push decision for a record's
copies no longer depends on anything a reader does: it is made from the seed
before any loader starts. What a reader does still decides one thing, which
is #1002 itself, and change 1 leaves it exactly as it was.

- **#1002, all of it.** A reader that starts a `cache()`-bound loader before
  its binding still runs it live while the binding serves its entry. The six
  tests are in the evidence file under `PENDING #1002`, as expected failures.
  One interaction to know: when the reader's run is what the claim sees
  (`loaderPromises` has the loader), the binding's HIT is refused and does
  not redeliver, so a record's placeholder for that loader is replaced by the
  live run, as on `origin/main`. Change 1 neither helps nor worsens it.
- **A pinned loader whose capture pushed nothing.** The store learns that a
  loader is pinned from the copies it restores for it. A loader with no copy
  in the record is unknown to the store, so a settled push its run makes on a
  replay is shown next to the pinned data
  (`PENDING (unfiled)` in the evidence file: data `late@g1`, push
  `late-note@g2`, on a document HIT and on a navigation, before and after
  change 1). Telling the store from the seed instead would fix it, and would
  break a record written before `handleOwners` existed: such a record holds
  no loader pushes at all and relies on the run to supply them
  (`shell-snapshot.ts`, the missing `runs` bit reads as 1), and it looks the
  same as a current record whose loader pushed nothing. It needs a marker on
  the record, which is a stored-format change, so it is not part of this
  change.
- **A dependency under partial pins, or one its awaiting loader's entry did
  not record.** The "every `ssr: false` loader is pinned" rule is an
  approximation the record forces (it does not name the loader that ran a
  dependency). Two consequences: with one pin missing, a dependency that
  runs under a still-pinned loader shows its live push next to that loader's
  pinned data; and on a replay without pins, when the awaiting loader's own
  `cache()` entry hits and that entry recorded no push for the dependency,
  the dependency's placeholder stays (nothing runs it, and no entry claims
  it). Both need the record to name the awaiting loader.
- **Order when a loader's pushes interleave with a dependency's.** A loader
  that pushes, awaits a dependency that pushes, and pushes again gets
  `[own, own, dependency]` when its run replaces placeholders, not the push
  order: a loader's later live pushes follow its previous one
  (`liveReplacementIndex` in `handle-store.ts`, unchanged). A navigation
  replay without pins did that on `origin/main` already; a document HIT
  without pins does it now too, where it used to keep the record's order
  with the record's values.
- **Other copies that can outrank a loader's own entry.** A dependency group
  in another loader's entry, and a loader group in a `"use cache"` entry, are
  still delivered first-come through `_claimLoaderPushes`, and a loader they
  claimed does not replay its own entry afterwards. Read from the code, not
  probed.
- **`getRequestContext().use(Loader)`** still has its own memo.

One thing the browser tests showed that is older than this work and
unrelated to which push wins: on a document HIT of a `runs` pin, the deferred
push reaches the client after hydration, while the prelude already rendered
it. A view that renders one row per push therefore hydrates with a row
missing and React regenerates the list (logged in dev as "Hydration failed
because the server rendered HTML didn't match the client", on `origin/main`
and now). `expectReplayDeliversDeferredPush` installs no hydration guard for
that reason.

## Compatibility and risk

**Stored formats, change 1 (built).** Nothing stored changes shape, and no
field is reinterpreted, so no version bump and no tolerant reader is needed.

- Shell entries: unchanged. `holes` and `runs` keep their meaning, and a
  v0.17 pin without the bits still reads as both. An entry the old code
  wrote, read by the new code, takes the new rule on the next request: its
  pinned loaders restore on a navigation as they did on a document HIT, and
  an old entry without pins restores placeholders. A record written before
  `handleOwners` existed has no owners and restores as a plain replay, as
  before. An entry the new code wrote, read by the old code (a rollback),
  behaves as the old code did.
- Route `cache()` records: unchanged. The new code reads `handleOwners` as
  placeholders; the old code reads the same records with a claim.
- Loader `cache()` entries: unchanged, and change 1 reads them exactly as
  before. It only changes what a HIT does with a record's placeholders.

**Stored formats, change 2 (not built).**

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

**Semantic matrix.** `[C1]` and `[C2]` hold, and so do the PPR rows: all 53
tests pass in dev and production with change 1. Change 1 changes no row: it
makes a navigation replay agree with the document HIT a row already pins,
and the shell paragraph of `docs/internal/execution-model.md` is rewritten to
say so. Change 2 will add rows (a reader before the binding, on a document
request and on a navigation) and rewrite the "One value per loader per
request" guarantee there: no existing row encodes "a reader that ran before
the binding gets its own run".

**Behavior an existing app can observe.** All of these are the rule being
applied; they are still changes.

| Arrangement                                                          | Was                                                    | Becomes                                               | Change      |
| -------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- | ----------- |
| Navigation replay, `ssr: false` loader that runs                     | live settled push; a deferred push from its entry lost | the capture's settled push; the deferred push arrives | 1, built    |
| Document HIT of an entry without pins                                | the capture's push next to fresh data                  | the run's push, none if the run made none             | 1, built    |
| Navigation replay of an entry without pins, the run makes no push    | the capture's push next to fresh data                  | no push                                               | 1, built    |
| ppr route under `cache()`, the loader's entry newer than the record  | the record's copy                                      | the entry's push                                      | 1, built    |
| Replay without pins, a loader that pushes around a dependency's push | the record's order on a document HIT                   | the loader's pushes next to each other                | 1, built    |
| A reader that ran before a `cache()` binding, entry HIT              | fresh value for the reader; the body ran every request | the cached value; the body does not run               | 2, breaking |
| The same loader's pushes                                             | live                                                   | the entry's                                           | 2           |
| The same loader's pushes when a parent started it                    | attributed to the parent's segment                     | attributed to the binding's segment                   | 2           |
| Side effects in that body                                            | once per request                                       | once per MISS                                         | 2           |

**Hot path, change 1.** `withCacheLookup` allocates one small object per
request where it used to allocate one (`loaderPins` in place of the old
delivery literal), and no Set: the lanes and the pinned ids are computed on
first use, which is a restore of a record that has owners or a request that
has a seed. A route without `ppr` never reaches that. `onHit` moves, it does
not multiply. A cached unit's HIT builds one short array of the loaders it
claimed. **Change 2**: the binding table is built lazily and only for a chain
`bindsLoaderCache` already flagged (memoized per entry); `useLoader` gains
one map lookup when the table exists; with the marker, a HIT of an entry that
pushed nothing compares one character instead of skipping the decode on an
empty string.

**Risk.** For change 1, the pin accessor is a small change over primitives
that have the most tests in this area (`handle-store.test.ts`,
`cache-record-loader-pushes.test.ts`, the restored-pushes block of
`serve-shell-request.rsc-test.tsx`); those pin #888, #929 and #936 and stayed
green. One existing unit test changed meaning:
`cache-record-loader-pushes.test.ts` served a document tail from a snapshot
without loader pins and expected the capture's pushes to stand next to a
loader that ran. That is the `maxSnapshotBytes` case; the test now seeds the
pin for the pinned contract and has a second block for the entry without
pins. For change 2, the binding-scope constraint above is the part with the
least existing coverage: today a binding always starts from a kickoff. The
semantic matrix must run for it (`segment-resolution/` is gated on it), and
"a cached hole a bake-lane loader starts first keeps its push in the captured
place" in `serve-shell-request.rsc-test.tsx` asserts the live push that rule
replaces.

## Delivery

The two changes are independent, so they ship separately.

**Change 1, done (closes #1001 and #1003, and replaces PR #1018 for those
two):** the pin accessor and the `OwnedPushDelivery` reduction;
`withCacheLookup` stops reading `docTail` and the lanes for pushes; `onHit`
before the restore; a cached unit's redelivery for every loader it claims,
without the hole gate. With it: the paths nobody had filed that the same
change covers (a prefetch replay, the seeded fallback, an entry without pins
on a document HIT, a dependency without pins, a run that makes no push, a
route record's copy, a loader entry newer than a shell without pins), the
#1018 regression cases kept green, unit tests next to `handle-store.ts`,
`handle-snapshot.ts`, `cache-lookup.ts` and `loader-cache.ts`, browser e2e
for #1001, #1003 and the `maxSnapshotBytes` document HIT in both apps, dev
and production.

**Change 2, next (closes #1002), once the open questions below are
answered:**

1. The binding table and `useLoader` routing; removal of the interceptor and
   the reader-first branches.
2. The entry marker, if open question 1 says so.
3. The six `red` tests under `PENDING #1002` become plain `it`. Unit tests
   next to `loader-resolution.ts` and `loader-cache.ts`. Browser e2e for
   #1002 in both apps, dev and production. Docs, changelog (`### Breaking:`
   for the reader rule), matrix rows.

**Later (follow-ups; each extends the two changes, none deletes them):**

- The table covers every registered loader, with its bake key, so a reader of
  a pinned loader gets the pin: one value per loader on shell replays too.
  The pin question then moves from the restore into the resolver, and the
  accessor keeps one caller.
- The store's six primitives fold into one statement of a loader's source.
  A refactor with no behavior change, held by stage 1's tests.
- A capture stops writing loader-owned pushes into a real route `cache()`
  record: an artifact that can only ever hold a copy.
- The shell record names the registered loader that ran a dependency, which
  replaces the all-pinned approximation for dependencies, and says which
  loaders it holds no push for, which closes the "pinned loader whose capture
  pushed nothing" gap. Both are additive fields on the record.
- `getRequestContext().use()` joins the table.

## The evidence

The path-level evidence is
`serve-shell-request-push-ownership.rsc-test.tsx`, run from
`packages/rangojs-router` with
`./node_modules/.bin/vitest run --config vitest.rsc.config.ts src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx`:
`20 passed | 7 expected fail (27)`. On `origin/main`'s sources (the ten
changed source files checked out from `eed288b1`, the test file as it is)
the same command gives `11 failed | 9 passed | 7 expected fail`.

Red on `origin/main`, green with change 1:

| Test                                                                                    | Failed on `origin/main` with                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| a navigation replay keeps the captured push next to the pinned data (#1003)             | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (data `eb@g1`)        |
| a prefetch replay keeps the captured push next to the pinned data                       | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]`                       |
| a navigation whose explicit route cache() misses replays the shell record ...           | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (data `eb@g1`)        |
| an ssr: false loader on a layout: a HIT and a navigation replay keep the captured push  | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (the navigation)      |
| a navigation replay delivers the deferred push ... (the entry misses at capture, #1001) | nav: `deferred: []`, expected `[ 'deferred-note-2' ]`                                |
| a navigation replay delivers the deferred push ... (the entry is warm at capture)       | nav: `deferred: []`, expected `[ 'deferred-note-1' ]`                                |
| a document HIT of an entry whose pins maxSnapshotBytes dropped ...                      | `expected [ 'eb-after@g1' ] to deeply equal [ 'eb-after@g2' ]` (data `eb@g2`)        |
| without pins a dependency's push follows the fresh run of the loader that awaits it     | hit: data `baked-dep@g2`, push `dep-note@g1`, expected `dep-note@g2`                 |
| a run that makes no push leaves none ...                                                | hit and nav: data `once@g2`, push `[ 'once-note@g1' ]`, expected `[]`                |
| a loader's cache() entry takes the place of the record's copies, the dependency's ...   | data `owned-dep@g2`, push `dep-note@g1`, `owned-dep-note@g1`, expected both `@g2`    |
| a document MISS that hits the route cache() record and the loader's cache() entry ...   | `expected [ 'owned-note@g1' ] to deeply equal [ 'owned-note@g2' ]` (data `owned@g2`) |

Controls, green before and after: the document HIT with pins; the navigation
replay of a navigation-only entry and of a `maxSnapshotBytes` entry (the
#1018 regression: both fail on the #1018 head `5ca6c967`, with
`expected [ 'eb-after@g1' ] to deeply equal [ 'eb-after@g2' ]` and
`... [ 'eb-after@g3' ]`); a dependency next to its pinned loader; an explicit
route `cache()` hit on a navigation; a `"use cache"` entry's copy of a
dependency's push showing once on a replay without pins, whether the capture
hit that entry or ran the dependency; a handler on the binding's own route;
the ppr reader declared after the hole.

Still expected failures (`it.fails`), with the assertion each fails on:

| Pending test                                                                            | Fails with                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| the entry a request writes records the cached loader's pushes when a reader started ... | `expected '' to contain 'sch-note@g1'`                                   |
| a sibling loader declared before the binding (a route without ppr)                      | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2` |
| a parent layout's loader reading a child route's cached loader                          | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2` |
| a parent layout's handler reading a child route's cached loader                         | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `layout-sch@g2` |
| a sibling loader declared before the binding on an intercept                            | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2` |
| a ppr route: an ssr: false reader declared before the cached hole ...                   | `bodyRuns: 2`; hit and nav: data `sch@g2`, push `sch-note@g3`            |
| (unfiled) a pinned loader whose capture pushed nothing: a push its run makes ...        | hit and nav: data `late@g1`, push `[ 'late-note@g2' ]`, expected `[]`    |

Below the path level, each changed module has its own tests:
`server/__tests__/handle-store.test.ts` (`markHoles`, `redeliverReplays` over
several loaders), `cache/__tests__/handle-snapshot-owned-pushes.test.ts`
(`restoreHandles` and `appendHandles` against a delivery),
`router/segment-resolution/__tests__/loader-pins.test.ts` (`loaderPins`: the
lanes, the dependency rule, a capture, the key grammar, the lazy seed),
`router/segment-resolution/__tests__/loader-cache-handles.test.ts` (a HIT and
a MISS over a record's copies),
`router/match-middleware/__tests__/cache-lookup-owned-pushes.test.ts`
(`withCacheLookup` on a document tail, a navigation replay, the seeded
fallback, an explicit hit and a plain request) and
`cache/__tests__/cache-record-loader-pushes.test.ts` (a pinned tail and a
tail without pins through `router.match`).

In a browser, `expectReplayKeepsCapturedPushWithPinnedData` (#1003),
`expectReplayDeliversDeferredPush` (#1001) and
`expectPinlessHitKeepsRunPushWithRunData` in `tests/shared-e2e/src/index.ts`
run in a dev and a `(production)` describe in both apps
(`packages/rangojs-router/e2e/shell-push-ownership.test.ts`,
`tests/cloudflare-basic/e2e/ppr-push-ownership.test.ts`). On `origin/main`'s
sources they fail in both apps and both modes with: expected
`pinned-note@g1`, received `pinned-note@g2`; `deferred-note@g1` missing;
expected `pinned-note@g2`, received `pinned-note@g1`.

## Open questions

Answered for change 1:

- Dependencies when the pins are partial (was question 2): "stands while
  every `ssr: false` loader is pinned" is accepted for now.
- `/shared-dep` (was question 5): leave it as documented.
- The paths nobody filed (was question 7): fixed with change 1 where that
  change covers them.
- Browser e2e (was question 8): #1001 and #1003 in both apps, dev and
  production, plus the `maxSnapshotBytes` document HIT.

Open, and all about change 2:

1. Old loader `cache()` entries: the completeness marker (one refill per key
   after the upgrade, no visible gap) or a changelog note (no refill, a
   missing push until the entry expires)? The recommendation is the marker.
2. A reader of a pinned loader: with the table, or later? It changes what
   such a reader sees on a HIT (the capture's value instead of a fresh one).
3. A cached loader a parent started pushes into the binding's segment under
   this design, which moves that push to where the binding-first order puts
   it. Confirm that is the wanted order.
4. `getRequestContext().use(Loader)`: route it through the table, and when?

New, from building change 1:

5. A pinned loader whose capture pushed nothing ("What is not built"): add a
   marker to the record so the store can drop the push its run makes on a
   replay, or document it as a rule for loader authors (push from every run,
   or from none)? The docs say the second for now.
6. The order of a loader's pushes around a dependency's when its run replaces
   placeholders: accept `[own, own, dependency]`, or change
   `liveReplacementIndex` so a later push follows the last live push made
   inside its body? That would also change a navigation replay that behaved
   this way before.
