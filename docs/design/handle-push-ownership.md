# Handle push ownership: one run per loader

Status: change 1 is built, change 2 is not planned. Change 1 ("the pin
decides both the value and the pushes") is in `src/` and closes #1001 and
#1003, plus the paths nobody had filed that the same change covers. Change 2
(the binding table) was decided against on 2026-10-04: #1002 is closed as by
design, so a loader that reads a `cache()`-bound loader before its binding
runs it live, and the six #1002 tests pin that behavior as plain tests. The
change 2 text below is kept as analysis, with a note at the top of each
affected section. "What is built" and "What is not built" below say exactly
where the line is.
A later section, "What a document hydrates with on a shell HIT", covers
#1035: not which push a page shows, but when the client gets it.

The evidence is
`packages/rangojs-router/src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx`:
31 tests. 14 of them failed on `origin/main` (`eed288b1`) and pass now, 9 are
controls that passed before and still do, and the six #1002 cases were expected failures and now pin today's behavior as
plain tests, and 2 are expected failures, the two dependency cases the
record cannot decide (#1036). One
of those two passes on `origin/main` for a document HIT, so it is a corner
change 1 made worse, not one it left alone; "What is not built" says which.

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
instead of an eighth patch. The first is built; the second was decided
against (see "The #1002 decision" under "What is not built").

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
   It is not in the shell's HTML either, and a document HIT delivers it
   after hydration (#1035).
6. **An entry is whole.** A loader `cache()` entry holds a value and the
   pushes of the run that produced it, or it is treated as a miss.
7. **Same shell, same answer.** A document HIT, a navigation replay and a
   prefetch replay of one shell entry show the same data and pushes for the
   same store state.
8. **Once.** Each push shows once.

## The path table

Three columns: `origin/main` before change 1, the code now (change 1), and
the target had change 2 been built (not planned, see below). A cell reads "data / settled push", each
naming its source: **pin** (the shell entry's pin and its record), **run** (a
run in this request), **entry** (the loader's own `cache()` entry),
**record** (a copy in a record that does not supply the value). A mismatch is
in bold. "same" means the column to its left. Every row except the
stale-entry one is pinned by a test: in the evidence file, in
`serve-shell-request.rsc-test.tsx`, or, for the row about a route with no
`ssr: false` loader, in `cache-lookup-owned-pushes.test.ts`.

A promise-carrying `ssr: false` loader (it runs on every replay):

| Path                                                              | `origin/main`                 | Now (change 1) | After change 2 (not planned) |
| ----------------------------------------------------------------- | ----------------------------- | -------------- | ---------------------------- |
| Document MISS (render and capture)                                | run / run                     | same           | same                         |
| Document HIT, pins present                                        | pin / pin                     | same           | same                         |
| Navigation replay, pins present                                   | **pin / run** (#1003)         | pin / pin      | same                         |
| Prefetch replay (`X-Rango-Prefetch`), pins present                | **pin / run**                 | pin / pin      | same                         |
| Navigation, explicit route `cache()` misses, seeded record serves | **pin / run**                 | pin / pin      | same                         |
| Navigation, explicit route `cache()` hits                         | run / run                     | same           | same                         |
| Navigation replay, navigation-only entry (no pins)                | run / run (PR #1018 broke it) | same           | same                         |
| Navigation replay, pins dropped by `maxSnapshotBytes`             | run / run (PR #1018 broke it) | same           | same                         |
| Document HIT, pins dropped by `maxSnapshotBytes`                  | **run / record**              | run / run      | same                         |
| Any replay without pins, the run makes no push                    | **run / record**              | run / none     | same                         |
| Pinned, the capture's run pushed nothing and the replay's pushes  | **pin / run**                 | pin / none     | same                         |
| The same with a pin stored before the `runs` bit (v0.17)          | pin / run, by design          | same           | same                         |
| Pinned, the navigation does not revalidate the loader             | no value sent / pin           | same           | same                         |

The last row is the one place where the value side skips the pin without the
push side following: `resolveLoadersWithRevalidation` drops a loader the
navigation does not revalidate before it reaches `resolveLoaderData`, and the
record's copy of its push still stands. That is right when the value the
client keeps came from this shell (a HIT or a replay of it), which is the
case the test pins. When the client holds a value from somewhere else, no
value on the server matches it, the record's copy is the only one there is,
and dropping it would take the push off a page that still shows the loader's
data. The restore also runs before the revalidation decision, so it could not
follow it without a second pass.

Other loaders on a shell replay:

| Path                                                                                     | `origin/main`                                                  | Now (change 1)                             | After change 2 (not planned)            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| Promise-free `ssr: false` loader with `cache()` and a deferred push, document HIT        | pin / pin, deferred from the entry                             | same                                       | same                                    |
| The same, navigation replay                                                              | pin / pin, deferred push **missing** (#1001)                   | pin / pin, deferred from the entry         | same                                    |
| `ssr: false` loader with `cache()`, no pins, its entry newer than the shell              | **entry / record**, its dependency's push too                  | entry / entry, each once                   | same                                    |
| The same, its entry stored without its pushes (a reader-first MISS, an encode timeout)   | **entry / record**                                             | entry / none: the entry as it is           | not planned: the entry is a miss: a run |
| Dependency a pinned loader awaited (registered on neither lane)                          | pin / pin                                                      | same                                       | same                                    |
| The same dependency, any replay without pins                                             | **run / record**                                               | run / run                                  | same                                    |
| The same dependency, one other `ssr: false` loader lost its pin, document HIT            | pin / pin                                                      | **pin / run** (pending)                    | not designed                            |
| The same, navigation replay                                                              | **pin / run**                                                  | **pin / run** (pending)                    | not designed                            |
| A dependency whose push the awaiting loader's `cache()` entry did not record, no pins    | **entry / record**                                             | **entry / record** (pending)               | not designed                            |
| A `"use cache"` entry's copy of a dependency's push, replay without pins                 | entry / record, once                                           | entry / entry, once                        | same                                    |
| Live-lane loader (a hole), with or without its own `cache()`                             | its run's or its entry's, both                                 | same                                       | same                                    |
| Live-lane loader on a route with no `ssr: false` loader, a record without loader copies  | a hole, when the record holds any handle push                  | a hole, with or without a handles blob     | same                                    |
| Dependency a pinned loader and a live loader share (`/shared-dep`)                       | captured push next to the live reader's fresh data, documented | same                                       | same (decided: leave)                   |
| Order: a loader pushes, awaits a dependency that pushes, pushes again; its entry replays | `[own, dependency, own]`                                       | same                                       | same                                    |
| The same loader runs over the record's copies, document HIT without pins                 | the record's order, with the **record's** values               | `[own, dependency, own]`, the run's values | same                                    |
| The same, navigation replay without pins                                                 | `[own, own, dependency]`                                       | `[own, dependency, own]`                   | same                                    |

A route `cache()` record that holds a loader's push (a ppr route under
`cache()`; the capture wrote the record):

| Path                                                                       | `origin/main`      | Now (change 1) | After change 2 (not planned) |
| -------------------------------------------------------------------------- | ------------------ | -------------- | ---------------------------- |
| Document MISS of the shell, record hits, the loader's `cache()` entry hits | **entry / record** | entry / entry  | same                         |
| The same, the loader has no `cache()`                                      | run / run          | same           | same                         |

A loader with its own `cache()` that something reads with `ctx.use()`
(any route, `ppr` or not). This is #1002, untouched by change 1 and by
design: the "After change 2" column is what the change would have done, and
it is not planned. The tests that pin the current column are under
`#1002 by design` in the evidence file:

| Reader, on an entry HIT                                        | `origin/main` and now                                            | After change 2                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| The binding's own route handler, or a loader declared after it | body 0, entry / entry                                            | same                                    |
| Sibling loader declared before the binding                     | body **runs**, **entry / run**, the reader sees the run          | not planned: body 0, all from the entry |
| The same on an intercept                                       | the same split (PR #1018 does not cover it)                      | not planned: body 0, all from the entry |
| Parent layout's loader                                         | the same split (PR #1018 leaves it by design)                    | not planned: body 0, all from the entry |
| Parent layout's handler                                        | the same split                                                   | not planned: body 0, all from the entry |
| `ssr: false` reader on a ppr route, HIT and navigation replay  | the same split                                                   | not planned: body 0, all from the entry |
| Any of the above, entry MISS                                   | one run shared, but the entry it writes has **no pushes**        | not planned: the entry records them     |
| Stale entry (SWR)                                              | stale data and the stale entry's pushes; the refresh is diverted | same                                    |

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
asked it for the value. `restoreHandles` and the handle store now ask the
same pins for the pushes, and `withCacheLookup` no longer decides. This is
what is in `src/` (paths under `packages/rangojs-router/src/`, line numbers
as of the commit that built it):

- **One accessor, one key.** `servedPins(reqCtx)`
  (`router/segment-resolution/loader-cache.ts:303`) returns the seed, or
  nothing during a capture. The seed is keyed by **loader id**:
  `buildShellLoaderSeed` (`cache/shell-snapshot.ts:411`) cuts the id out of
  the segment id a pin is stored under (`${shortCode}D${index}.${loaderId}`;
  a shortCode holds no "D" and no ".", a loader id can hold both, so the
  first `D<index>.` ends it, `PIN_KEY_PREFIX`, `:390`). A loader runs once
  per capture, so every segment that registers it pinned the same container.
  The value side does `servedPins(reqCtx)?.get(loader.$$id)` (`:531`) and
  the push side does the same lookup in `loaderPins` (`:327`). Before, the
  value looked up the exact segment key and the pushes parsed loader ids out
  of the keys, two projections that could drift. A condition that makes
  pins, or one loader's pin, not apply goes into `servedPins` or into the
  seed's decode, and reaches both sides.
- **Each side applies its own lane, and they are different on purpose.** The
  value is per registration: `resolveLoaderData` takes the pin for an
  `ssr: false` registration (`loaderEntry.bake`) whose caller passed a bake
  key. The pushes are per loader: one the route also registers without
  `ssr: false` is a hole whatever its other registration's pin says, because
  the capture credited its pushes to the live registration's run
  (`routeLoaderLanes`). `loader-pins.test.ts` pins both, and the case where
  they differ.
- **The delivery is one fact per loader.** `OwnedPushDelivery`
  (`cache/handle-snapshot.ts:143`) lost `restore`, `liveLane` and `claim`,
  and then `pinned`, `unpinned` and `seeded`. It is a function,
  `(loaderId) => RecordAuthority` (`server/handle-store.ts:101`): what the
  restored record is to that loader's pushes on this request.

  | Authority        | Who                                                                                                | The record's copies              | The loader's other settled pushes                                 |
  | ---------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
  | `"pin"`          | a registered `ssr: false` loader served from its pin                                               | stand (`pushRestored`)           | dropped: the record lists every one the capture's run made        |
  | `"copies"`       | a pin stored before the `runs` bit (v0.17); a dependency while every `ssr: false` loader is pinned | stand                            | dropped once it has a copy, kept when the record holds none       |
  | `"hole"`         | a registered loader the record does not pin (live lane, or its pin is gone)                        | placeholders (`pushPlaceholder`) | its own, with or without copies: its body is a hole               |
  | `"placeholders"` | a dependency while a pin is missing                                                                | placeholders                     | counted for the loader that awaits it, until it has a placeholder |

  `loaderPins(entries, reqCtx)` builds it when a record hits, over the pins
  as they are then: `matchPartialWithPprReplay` arms the seed for the match
  only and restores the previous value after it, while loader bodies still
  run and the store still asks.

- **Only a ppr route has a delivery.** `withCacheLookup`
  (`router/match-middleware/cache-lookup.ts:552`) passes a thunk when the
  matched route is a ppr route (`isPprEntry`), and nothing otherwise. That
  is the fact `seeded` stood in for: only a ppr route's records hold a
  loader push, and only its shell pins loaders. Every other route's record
  restores as a plain replay and marks no hole, as on `origin/main`. On a
  ppr route the registered loaders without a pin are holes whether or not
  the record holds a copy for them, which is also what `origin/main` did for
  the live lane. The thunk runs on a hit, so a miss allocates one closure
  and a route without `ppr` none.
- **The store learns the authority from the hit, not from the copies.**
  `CacheScope.lookupRouteDetailed` calls `handleStore.setRecordAuthority`
  (`cache/cache-scope.ts:883`) for every record hit that has a delivery,
  before and regardless of the handles blob. So a pinned loader whose
  capture pushed nothing, which has no copy in the record, is still known as
  pinned, and a settled push its run makes on a replay is dropped. This is
  safe against old records because the pin itself says which kind it is: a
  capture writes the `runs` bit since it records every settled loader push
  (v0.18, `40df8d26`; `handleOwners` is v0.17), so a pin that carries the bit
  vouches for the record (`ShellLoaderSeedEntry.complete`,
  `shell-snapshot.ts:380`), and one without it reads as `"copies"` and
  leaves the run's pushes alone, as before.
- **A placeholder is its own kind of slot.** A record's copy for a loader it
  does not supply goes through `pushPlaceholder` (`SlotTag.placeholderOf`,
  `handle-store.ts:64`), a cached unit's replay through `pushReplayed`
  (`replayOf`). Before, both were `replayOf` and a loader-level set
  (`markHoles`) told them apart. Now the rules read off the slot: a run's
  first push replaces both kinds; a run that ends without a push drops its
  placeholders, and its replays only if the loader is a hole
  (`settleLoaderRun`, `:855`, as `origin/main` did for the live lane); a
  cached unit's delivery takes the place of placeholders and of nothing else
  (`replacePlaceholders`, `:869`, formerly `redeliverReplays`).
- **One replay for every cached unit.** `appendHandles`
  (`handle-snapshot.ts:222`) is the replay of a `"use cache"` entry and of a
  loader's own `cache()` entry (`replayLoaderHandles` passes the cached
  loader as `unitLoader`). It asks the claim once per loader, the cached
  loader first, delivers the granted groups, and hands the granted loaders
  to `replacePlaceholders`, the cached loader even when its entry recorded
  no push. The two copies of this loop had drifted: a key without ":" was a
  bogus loader id in one and no owner in the other (it is the unit's own
  group now), and "no claim" granted everything in one and skipped the
  replacement in the other. No claim now means one thing, stated in the
  function: the caller's pushes are diverted off the page (a stale refresh),
  so every group is delivered and no placeholder is touched.
- **A pinned owner is restored and stands.** Its settled pushes on the
  replay are dropped, its thenable ones are added. Nothing is claimed, so
  its own `cache()` entry delivers the deferred push on a navigation exactly
  as on a document HIT (#1001).
- **Push order is the run's.** When a run replaces copies, a dependency's
  push made inside it is tagged with the loaders around it whose runs
  replaced copies too (`SlotTag.under`, `replacedAround`, `:468`), and a
  loader's next push follows the last push of its run, not its own last
  push (`runCursor`, `:454`). A loader that pushes, awaits a dependency that
  pushes, and pushes again ends as `[own, dependency, own]`, which is what
  its entry's HIT replays and what an uncached render gives. Before, the run
  gave `[own, own, dependency]`.
- **A dependency the route does not register** has no pin of its own. Its
  copies stand while every `ssr: false` loader of the route is pinned, and
  are placeholders otherwise. That is exact when the pins are all present or
  all gone (the navigation-only and `maxSnapshotBytes` cases). With one pin
  missing it is a guess, and "What is not built" has the case it gets wrong.
- **A route `cache()` record outside a shell replay has no pins**, so every
  owner in it is a placeholder. The claim in `restoreHandles` is gone, and
  with it the case where a record's copy blocks the loader's own entry.
- **The seed is armed before the restore.** `CacheScope.lookupRouteDetailed`
  awaits `onHit` (which arms the seed on a navigation) before it builds the
  delivery and restores the handles (`cache/cache-scope.ts:876`).

Document HIT, navigation replay, prefetch replay and the seeded fallback
after an explicit miss now run the same code with the same input, which is
invariant 7.

### 2. `ctx.use(Loader)` resolves through the route's bindings (not planned)

Decided against on 2026-10-04 (issue #1002, closed as by design). The maintainer's rule: a loader that reads another loader with `ctx.use()` may run it live, and a handler's `ctx.use()` is where a loader read is baked. The arrangement is an edge case with a way around it (declare the cached loader first, or read it from the handler), and the change would be breaking for every app that has a reader ahead of a cached loader. The analysis below stays as the record of what the change would have been.

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

Decided against on 2026-10-04 (issue #1002, closed as by design). The maintainer's rule: a loader that reads another loader with `ctx.use()` may run it live, and a handler's `ctx.use()` is where a loader read is baked. The arrangement is an edge case with a way around it (declare the cached loader first, or read it from the handler), and the change would be breaking for every app that has a reader ahead of a cached loader. The analysis below stays as the record of what the change would have been. The reasoning below argued for the change; the maintainer weighed it
differently and the way around is the documented answer.

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

### The #1002 decision

Decided against on 2026-10-04 (issue #1002, closed as by design). The maintainer's rule: a loader that reads another loader with `ctx.use()` may run it live, and a handler's `ctx.use()` is where a loader read is baked. The arrangement is an edge case with a way around it (declare the cached loader first, or read it from the handler), and the change would be breaking for every app that has a reader ahead of a cached loader. The analysis below stays as the record of what the change would have been.

What an author sees today, pinned by the `#1002 by design` tests in the
evidence file: the reader runs the cached loader live (its body runs on every
request), the binding serves its entry, so the loader's data comes from the
entry and its handle push from the live run. A handler's `ctx.use()` is where
a loader read is baked, and a cached loader declared first keeps data and
push together.

Change 1 did not need any part of change 2. The push decision for a record's
copies no longer depends on anything a reader does: it is made from the seed
before any loader starts. What a reader does still decides one thing, which
is #1002 itself, and change 1 leaves it exactly as it was.

- **#1002, all of it (by design, not planned).** A reader that starts a
  `cache()`-bound loader before its binding still runs it live while the
  binding serves its entry. The six tests are in the evidence file under
  `#1002 by design`, as plain tests that assert today's values.
  One interaction to know: when the reader's run is what the claim sees
  (`loaderPromises` has the loader), the binding's HIT is refused and does
  not redeliver, so a record's placeholder for that loader is replaced by the
  live run, as on `origin/main`. Change 1 neither helps nor worsens it.
- **A dependency the record does not attribute.** The record names the
  loader that pushed a value, not the registered loader that ran it, so a
  dependency no route registers follows the "every `ssr: false` loader is
  pinned" rule. Two cases get it wrong, both expected failures in the
  evidence file (`PENDING #1036: a dependency ...`, filed as #1036, open):
  - One pin missing, the others present. A dependency that a still-pinned
    loader awaits is a placeholder, and when that loader runs on the replay
    the dependency's live push takes its place: data `holey-dep@g1`, push
    `dep-note@g2`. A navigation replay did that on `origin/main` too. A
    document HIT did not: `origin/main` restored every bake-lane owner there
    whatever the pins, so this is a corner change 1 made worse. It needs a
    shell entry that lost one pin and kept another, which the size cap never
    produces (it drops them all); a pin that fails to encode at capture or to
    decode on the HIT does. Counting the dependency as pinned while any pin
    is present only moves the error to the loader that lost its pin.
  - No pins, the awaiting loader's own `cache()` entry hits, and that entry
    recorded no push for the dependency (it pushed nothing in the run that
    wrote the entry). Nothing runs the dependency and no entry claims it, so
    the record's copy stays: data `owned-dep-once@g2`, push
    `dep-once-note@g1`. The same on `origin/main`.

  Both go away when the record names the loader that ran a dependency.

- **A loader `cache()` entry without its pushes.** A claimed entry is the
  loader's source, whatever it holds: its HIT removes the loader's
  placeholder and delivers what it recorded. An entry stored without handles
  delivers nothing, so the page shows the entry's data and no push for that
  loader, where `origin/main` kept the record's copy (data `owned@g2`, push
  `owned-note@g1`). Two things write such an entry: a MISS a reader started
  first (#1002, the first row of its table), and a handle encode that timed
  out. Neither copy is the run's push, so neither answer satisfies invariant
  1. Invariant 6 is the fix (such an entry is a miss), and it belonged to
     change 2 with the marker in open question 1; with change 2 not planned,
     an entry a reader-first MISS wrote stays without pushes. Pinned by "a loader's cache()
     entry stored without its pushes shows none".
- **A doc record whose handle encode timed out.** `cacheRoute` then stores
  the record without a handles blob, and nothing in it says so. A pinned
  loader of that entry is still `"pin"`, so a settled push its run makes on
  a replay is dropped, where the run used to supply it when the pin asked
  for one. Such an entry already serves a hole-free pin without its pushes
  on every HIT, on `origin/main` too. Read from the code, not probed.
- **Other copies that can outrank a loader's own entry.** A dependency group
  in another loader's entry, and a loader group in a `"use cache"` entry, are
  still delivered first-come through `_claimLoaderPushes`, and a loader they
  claimed does not replay its own entry afterwards. Read from the code, not
  probed.
- **`getRequestContext().use(Loader)`** still has its own memo.

One thing the browser tests showed while this was built was older than it
and unrelated to which push wins: a document HIT of a `runs` pin failed
hydration on its deferred push. That was issue #1035, and "What a document
hydrates with on a shell HIT" below is its fix.

## What a document hydrates with on a shell HIT (#1035)

Status: built, in three pieces you can read apart: the capture, the HIT, and
`useHandle`. Two other designs were considered and decided against; "Options
decided against" says why.

Everything above decides WHICH push a page shows. This section is about
WHEN the client gets it, and it exists because that question had no owner. A
document served from a shell is two renders stitched together: the prelude,
rendered at capture, and this request's payload, which React hydrates it
with. Hydration works only when the second matches the first. For handle
data nothing made it so: the capture rendered the prelude from its whole
handle store, its record kept a part of that, and a HIT hydrated with
whatever its own store held when the document stream was first read. Issue
#1035 is the case that failed on every HIT. The path table has four more.

### The rule

1. **A HIT hydrates with the record.** The pre-hydration snapshot
   (`metadata.handles`) is the record's handle data as `restoreHandles`
   restored it, standing copies and placeholders alike. Nothing this
   request's loaders did is in it.
2. **This request's pushes arrive after hydration.** Everything a loader of
   this request does to the store after the restore (a live push, a
   placeholder replaced or dropped, a deferred push, a cache entry's replay)
   rides the late channel (`metadata.handlesLate`), which the client applies
   once the root has hydrated.
3. **The capture renders the prelude from what its record keeps.** A push
   the record leaves out renders no element at capture.
4. **A reader hydrates with the document's handle data.** `useHandle` in a
   render React is hydrating reads the data its HTML was rendered from,
   whenever its boundary hydrates, and moves on to the live data in its
   mount effect. This one is not about shells: it holds on every document.

For an app author the four come down to one sentence: **a promise pushed
from a loader is live and is never in a shell; to have a value in the
shell's HTML, push it settled (await it) from the `ssr: false` loader, or
push it from the handler.**

The consequence to keep in mind: on a shell HIT a deferred push is not in
the HTML and shows right after hydration. On a MISS, and on a route without
`ppr`, it is in the HTML as before. A crawler that reads a HIT's HTML does
not see it.

### How #1035 broke

You may expect, as the issue first did, that the HIT awaits the `ssr: false`
loader and its deferred push therefore lands in the pre-hydration data
early. It does not await it. The trace below is `tests/cloudflare-basic`,
route `/ppr-push/deferred`, with every step logged in dev and in production
(line numbers are `origin/main` at `ede1367f`).

| Step                                                                                                                                                                                                    | Where                                                          | Logged                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **MISS.** The document render awaits an `ssr: false` loader, so both pushes are in the store before the handler barrier                                                                                 | `segment-resolution/fresh.ts:194`                              | both pushes stored with `handlerBarrierResolved=false`                                                                 |
| The document stream reads the store after the barrier and awaits every top-level thenable: SSR and the client get the same resolved snapshot                                                            | `handles/deferred-resolution.ts:109-112`                       | `metadata.handles` = `[settled-note@g1, deferred-note@g1]`; SSR reads the same                                         |
| **Capture.** The loader's `cache()` entry, written by the MISS, hits: the body does not run, the entry's pushes are replayed, the deferred one as the thenable Flight decoded                           | `loader-cache.ts:840` (`replayLoaderHandles`)                  | `loader cache() entry HIT`, blob `["settled-note@g1","$@1"]`                                                           |
| The push funnel calls `value.then(mask)`. React's decoded promise has a `then()` that returns nothing, so the slot is `undefined`, tagged as a loader push                                              | `rsc/shell-capture.ts:2051`, `:2076`                           | `value.then(mask) returned=undefined`; stored `undefined`, `loaderTag=true`                                            |
| The capture waits for every top-level thenable in its store before the record is written. `undefined` is not one, so nothing is awaited here; a body-made promise is                                    | `rsc/shell-capture.ts:1646`                                    | resolved to `[settled-note@g1, undefined]`                                                                             |
| The record leaves tagged pushes out. The capture's own payload does not: it reads the whole store                                                                                                       | `cache/handle-snapshot.ts:119`; `rsc/full-payload.ts:56`       | the capture's SSR reads `[string("settled-note@g1"), undefined(undefined)]`: `<li>settled-note@g1</li><li></li>`       |
| **HIT.** The record restores the settled push. The loader's data is its pin, resolved at once; the pin carries `runs`, so `executeLoaderData` is started in the background and nothing awaits it        | `loader-cache.ts:555-560`                                      | `PIN served, value resolved immediately ... kicked in the BACKGROUND`, then `router.match() returned`                  |
| The background run hits the loader's `cache()` entry and replays its pushes: the settled one is dropped (the record's copy stands), the deferred one is stored, after the handler barrier in both modes | `loader-cache.ts:840`; `server/handle-store.ts` `push`         | `push DROPPED`, then `push STORED v3 ... handlerBarrierResolved=true`                                                  |
| The document stream reads the store one macrotask after it is first pulled. The late channel starts at the handler barrier. A push between the two is on BOTH                                           | `server/handle-store.ts:937` (`stream`), `:963` (`streamLate`) | production: stored at `t=…304`, first read at `t=…304` with it. Dev: first read at `#040` without it, stored at `#046` |

So the answer to "does it arrive early because the loader is awaited" is no.
The push comes from an un-awaited replay, and whether the pre-hydration data
has it is a race with a `setTimeout(0)`: production on workerd, and dev and
production on Node, had it (text mismatch, React #418); dev on workerd did
not (one row fewer than the HTML). Both fail, because the mismatch was fixed
at capture:
the prelude has an element the record does not account for. With a loader
that has no `cache()` the body runs at capture, the promise is a real one,
and the element holds the resolved value: a promise-shaped value baked into
a shell every visitor shares, next to a HIT that pushes the current one.

### The path table

What the HTML was rendered from, what the client hydrates with, and what
arrives after hydration. "record" is the shell record's handle data. Each
row is pinned through `readHandles()` in
`serve-shell-request-push-ownership.rsc-test.tsx` ("a shell HIT hydrates
from its record"); rows marked B were also run in a browser, dev and
production. The same reader on a document MISS, with the push made after an
await, failed on `origin/main` too and is clean now (rule 4).

| Path                                                                                             | `origin/main` (`ede1367f`)                                                                                                                         | Now                                                                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Document MISS (B)                                                                                | HTML and hydration: every push made before the handler barrier, a deferred one resolved. After: pushes made later (a live loader after an await)   | same                                                                                      |
| HIT, the loaders push settled values only (`/eb`)                                                | HTML, hydration: record. After: nothing                                                                                                            | same                                                                                      |
| HIT, a deferred push, the loader's `cache()` entry warm at capture (B, #1035)                    | HTML: record **plus an empty element**. Hydration: record, **plus the value if the replay won the race**. After: the value. Fails either way       | HTML, hydration: record. After: record plus the value                                     |
| HIT, a deferred push, the body ran at capture (no `cache()`, or its entry missed)                | HTML: record **plus the capture's value, baked**. Hydration: record plus this run's value (`@g2` next to `@g1`), or not                            | HTML, hydration: record. After: record plus this run's value                              |
| HIT, a push that holds a promise                                                                 | HTML: the capture's value with the promise masked. Hydration: this run's value, or not                                                             | HTML, hydration: record (no element). After: this run's value                             |
| HIT, an entry without loader pins (`ppr.maxSnapshotBytes`), the run pushes                       | HTML: the capture's push. Hydration: **the run's push** (the run is awaited). Text mismatch                                                        | HTML, hydration: the capture's push (the placeholder). After: the run's push in its place |
| The same, the run makes no push                                                                  | HTML: the capture's push. Hydration: **none**                                                                                                      | HTML, hydration: the capture's push. After: none                                          |
| HIT, a live-lane loader pushes, the reader is in the static part (B)                             | HTML: no element. Hydration: **the push when made before the loader's first await** (element mismatch, #418), else after                           | HTML, hydration: record. After: the push                                                  |
| HIT, a live-lane loader pushes, the reader is inside that loader's boundary (a hole) (B, e2e)    | Push before the first await: in the hole's HTML and in the hydration data, clean. Push after an await: after hydration, **fails in that boundary** | Both after hydration, clean: the reader hydrates with the document's data (rule 4)        |
| Client navigation that replays the shell                                                         | one stream, the final state                                                                                                                        | same                                                                                      |
| Document of a route without `ppr`                                                                | as a MISS                                                                                                                                          | same                                                                                      |
| HIT of a `Prerender` + `ppr` route, a promise-free `ssr: false` loader's settled push (B, #1057) | HTML: the push. Hydration: **the prerender store's handles only**, so React removes the element (#418). After: nothing                             | HTML, hydration: the shell's `handles` record. After: nothing                             |
| The same route, the loader also pushes a promise (B, #1057)                                      | HTML: the settled push. Hydration: **without it**. After: the HIT run's settled and promise pushes                                                 | HTML, hydration: the record. After: the record plus the promise                           |

A HIT of a `Prerender` route with `ppr` freezes at the same point: its tail
replays the prerender store's handles in `yieldFromStore`, then resolves the
render barrier. That store's entry is written at build time, when no loader
runs, and the capture of a `Prerender` route writes no doc record (the
prerender store supplies its handler layer), so before #1057 the loader-owned
pushes the prelude rendered were stored nowhere, and a pinned loader does not
run on the HIT to push them again. Now the capture stores them in a `handles`
snapshot record, in the doc record's format (`ShellSnapshotHandlesValue`,
`rsc/shell-capture.ts` `captureAndStoreShell`), and `yieldFromStore` restores
it after the prerender store's handles with the same rule as a doc record:
`setRecordAuthority(loaderPins(...))`, then `restoreHandles` with the owners.
So the last two rows follow the record rows above them exactly; only where
the data is stored differs. An entry stored before the record (v0.21) has
none and serves as the `origin/main` column says. Pinned through
`serveShellRequest` in `serve-shell-request-prerender.rsc-test.tsx`, which
`serveShellRequest` can drive since it serves a `Prerender` route from the
artifact `router.matchForPrerender` bakes, and in a browser by the `#1057`
tests of both push-ownership suites (a shell captured at runtime and the one
`vite build` bakes, dev and production).

### What is built

Three pieces, in three commits, so that any can change without the others.

**The capture renders from what its record keeps** (rule 3):

- `resolvedHandleStream(handleStore, recordedOnly)`
  (`handles/deferred-resolution.ts:102`). With `recordedOnly` the snapshot
  is cut down by `getDataForSegment(id, true)`, the same filter
  `captureHandles` writes the record with, so the two cannot disagree.
  `buildFullPayload` (`rsc/full-payload.ts`) passes it under
  `_shellCaptureRun`, which covers both producers (the runtime capture and
  the build-time one).
- The funnel keeps a deferred push as a promise of its value:
  `Promise.resolve(value).then(mask)` (`rsc/shell-capture.ts:2057`). The
  slot is out of the prelude either way now. It still matters for whatever
  reads the capture's store next: the wait in `settleCaptureRecord` sees a
  thenable again, not `undefined`.

Which pushes a record keeps is still the funnel's decision and only its:
the view follows the tag.

**The HIT hydrates from the record** (rules 1 and 2):

- `HandleStore.freezeDocumentSnapshot()` (`server/handle-store.ts`) fixes
  the document lane: `stream("settled")` yields the frozen state and nothing
  newer, and `streamLate()` starts from it, so a change made before the
  handler barrier is late too. The default stream, which a navigation reads,
  is untouched. The frozen state is served at once, without the timer tick
  the live lane uses to batch pushes (SSR and the pre-hydration drain block
  on this stream), and as the frozen object itself: its one consumer,
  `resolvedHandleStream`, builds a new object from a yield. A freeze that
  comes after the document stream was first read cannot reach that stream;
  in development the store reports it through `onError`.
- `serveShellHit` (`rsc/rsc-rendering.ts:1756`) freezes when the tail's
  render barrier resolves. That is the one point both hit paths share
  (`withCacheLookup` for a runtime record, `yieldFromStore` for the
  prerender store): the record is replayed and no loader has started. Match
  code is untouched.

Nothing in the second half knows what a deferred push is. It does not ask
who pushed or why: whatever changes the store after the freeze is late. The
client did not change either: it already drains `metadata.handles` before
`hydrateRoot` and applies `metadata.handlesLate` after the root commits
(`browser/rsc-router.tsx`).

**A reader hydrates with the document's handle data** (rule 4):

Rules 1 to 3 say what arrives "after hydration". That means after the ROOT
hydrates (`hydrationCommitted`, `browser/rsc-router.tsx`). A `useHandle`
reader inside a boundary that hydrates later, a PPR hole or any streamed
`<Suspense>`, used to initialize from the controller's live state. When the
late channel had applied an update by then, the reader rendered elements
its server HTML does not have.

That was older than #1035 and not specific to shells: on `origin/main` a
live-lane loader that pushes after an await, read inside its own
`loading()` boundary, failed hydration on a document MISS. The HIT rule made
it wider. A push made before the loader's first await used to be in a HIT's
hydration data and in the hole's resumed HTML; with rule 2 it is late like
the other. The router test-app had exactly that fixture
(`/shell-cache/live-dep`), and `e2e/shell-cache.test.ts` "live dep: a live
loader a running ssr false loader awaits keeps its live push on a HIT" went
red on the first two pieces alone. It is green again with this one,
unchanged.

- `EventController.freezeHydrationHandleState()`
  (`browser/event-controller.ts`) keeps the handle state the document was
  rendered with; `initBrowserApp` calls it before `hydrateRoot`.
  `getHydrationHandleState()` returns it once the live state has moved on,
  and `undefined` while the live state is still that state. A partial
  update merges into a copy of the containers, always, so no object the
  controller handed out is ever written to: not the frozen state, and not a
  history entry's data, which a back/forward restore installs by reference.
- `useHandle` (`browser/react/use-handle.ts`) reads it in a hydrating
  render. It tells one from a client render the way `useLocationState` does
  since #992: `useSyncExternalStore`, for its server snapshot. The mount
  effect, which was already there, moves the reader on to the live state.
- The server snapshot is the frozen state itself (`undefined` while the
  live state is still it), and the client snapshot is a constant
  `undefined`. The reader's initial state is
  `hydrationState ?? getHandleState()`. React re-renders a reader after it
  hydrated only when the two snapshots differ, which is exactly when
  something arrived late: a reader that hydrated with nothing late is not
  rendered again (the `hook-render-stability` pins did not move: 8 dev and
  8 production in the router app, 4 and 4 in cloudflare-basic).
- Because the client snapshot never changes and its function has one
  identity, the store is constant as far as React can tell. No handle
  update, a navigation's included, is a store mutation to it: there is no
  per-render store effect, and no transition render is redone
  synchronously because of this hook. An earlier version used "has the
  live state moved on" as the client snapshot, which flipped once per
  document and cost one such redo; do not go back to a snapshot that reads
  the controller on the client.

### Options decided against

Two other designs for #1035 were on the table. An independent consultation
that read this branch recommended the one above, complete, and both of
these were decided against. Do not build either without new information.

**A. Bake it: the capture awaits a deferred push and records the value.**
The capture would wait for the promise (bounded by `ppr.captureTimeout`),
render the prelude with the settled value and record it like a settled
push, so the value would be in a HIT's HTML as on a normal document.
Decided against, for three reasons:

- It makes "a promise from a loader is live" depend on timing. A promise
  that settles within `ppr.captureTimeout` would be baked, one that does not
  would stay live. The author cannot see which from the code.
- It contradicts the liveness rule that is already there. Loader DATA with
  a promise in it is a hole, and so is a promise nested in a loader's push
  (`mask-nested.ts`). Baking a top-level pushed promise would treat one
  shape differently from the other two.
- It freezes a value its author shaped as per-request into a shell every
  visitor shares. That is the cross-session leak the mask exists to prevent
  (the scar in `maskNestedContainerThenables`).

For the record, it was also not small: the tag (`loaderPush`, `owner`) is
decided at push time, before the value is known, so the store would have to
retag a slot once it settled; and the HIT's store keeps a pinned loader's
thenable pushes on the reasoning that a record could not hold them
(`holdsThenable`), which would then show a recorded value twice.

**C. A real hole: a pending promise in the slot at capture.** The consumer
would read the slot with `use()` under `<Suspense>`, the capture would
postpone that boundary, and the HIT's resume would fill it with
server-rendered HTML. Rejected: it changes what `useHandle` returns. A
handle value is resolved before any consumer sees it (resolve-by-default,
`handles/deferred-resolution.ts`), so every reader, `<Html.Meta />`
included, would have to learn to read a promise, and a reader without a
boundary would suspend the shell.

### A follow-up that is not done

The capture still waits for a deferred loader push it no longer renders.
`settleCaptureRecord` (`rsc/shell-capture.ts`) awaits every top-level
thenable in the capture's store before the record is written, under the
capture's one deadline. A loader push that does not settle within
`ppr.captureTimeout` therefore fails the whole capture ("produced no usable
shell ... did not settle within ppr.captureTimeout", probed), for a value
the shell does not contain. Before this work the wait had a reason: the
prelude rendered the value. Dropping it for loader-lane pushes is a
separate change, with its own question (a deferred HANDLER push is baked
and must keep waiting).

### Evidence

Red on `origin/main` (`ede1367f`), green now. Through `serveShellRequest`:

| Test ("a shell HIT hydrates from its record")                                          | Failed with                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| a deferred push is not in the shell (the loader's cache() entry is warm at capture)    | `expected [ 'settled-note-1', undefined ] to deeply equal [ 'settled-note-1' ]`                         |
| the same, the entry misses at capture                                                  | `expected [ 'settled-note-2', 'deferred-note-2' ] to deeply equal [ 'settled-note-2' ]`                 |
| a deferred push by a loader that runs at capture is not in the shell                   | `expected [ 'plain-settled@g1', 'plain-deferred@g1' ] to deeply equal [ 'plain-settled@g1' ]`           |
| a push that holds a promise is not in the shell                                        | `expected [ 'nested@g1' ] to deeply equal []`                                                           |
| a deferred push arrives after hydration (both variants)                                | hydration `[settled, deferred]`, nothing after; expected `[settled]`, then `[settled, deferred]`        |
| a deferred push by a loader without cache() arrives after hydration                    | hydration `[plain-settled@g1, plain-deferred@g2]`; expected `[plain-settled@g1]`                        |
| a push that holds a promise arrives after hydration                                    | hydration `[ 'nested@g2' ]`; expected `[]`                                                              |
| an entry without loader pins hydrates with the capture's push ...                      | hydration `[ 'eb-after@g2' ]`; expected `[ 'eb-after@g1' ]`                                             |
| ... whose run makes no push ...                                                        | hydration `[]`; expected `[ 'once-note@g1' ]`                                                           |
| a live-lane loader's push arrives after hydration ...                                  | hydration `[ 'handler-note', 'live-note@g2' ]`; expected `[ 'handler-note' ]`                           |
| `<path>`: the client hydrates with exactly what the shell was rendered from (6 routes) | e.g. `expected [ 'settled-note-1', 'deferred-note-1' ] to deeply equal [ 'settled-note-1', undefined ]` |

Five controls pass before and after: a HIT with settled pushes only, a
document MISS, a navigation replay, a document without `ppr`, and `/eb`'s
row of the last test.

In a browser, `expectShellHitHydratesFromRecord` (`tests/shared-e2e`) runs
in a dev and a `(production)` describe in both apps. On `origin/main` it
fails in all four with `expect(pushNoteRowsInHtml(...)).toEqual(["settled-note@g1"])`,
received `["settled-note@g1", ""]`. `expectReplayDeliversDeferredPush` now
installs the hydration guard, and with it fails on `origin/main` with
"Hydration failed because the server rendered HTML didn't match the client"
(dev) and React error #418 (production).

For rule 4, red with `origin/main`'s `use-handle.ts`:

| Test                                                                                                                             | Failed with                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `render-route-hydrate.test.tsx`, "#1035: a useHandle reader in a Suspense boundary that hydrates after a late handle update ..." | `recoverableErrors`: `expected [ Array(1) ] to deeply equal []` ("Hydration failed ..."), both StrictMode settings |
| `use-handle-hydration.test.tsx`, "a reader that hydrates after a late update hydrates with the document's values ..."            | the same assertion, "... the server rendered HTML didn't match the client"                                         |
| the same file, "applies the selector to the document's values on that render"                                                    | the same assertion, "... the server rendered text didn't match the client"                                         |
| `event-controller.test.ts`, "hydration handle state" (4 tests)                                                                   | `TypeError: ctrl.freezeHydrationHandleState is not a function`                                                     |

The first is the userland test: it goes through `renderRoute` with
`hydrate: true` and the `lateHandles` option this work added (handle values
applied once the root has hydrated, where production releases the late
channel). Without that option no test could put an update between the
root's hydration and a boundary's.

In a browser, `expectLateBoundaryHandleReaderHydratesClean` loads
`/ppr-push/live` (cloudflare-basic) and `/shell-push/live` (router test-app)
as a document MISS and as a shell HIT: a live loader that pushes after an
await, read inside its `loading()` boundary. On `origin/main` it fails in
both apps with two errors per run (the MISS and the HIT): "Hydration failed
because the server rendered HTML didn't match the client" in dev, React
error #418 (`args[]=HTML`) in production.

`expectPinlessHitKeepsRunPushWithRunData` (a shell without loader pins)
records the handle rows over time. That page does report a hydration error,
and it is the loader DATA, not the handle rows: dev names the element,
`<p data-testid="push-value">` with `+ pinned@g2` / `- pinned@g1` (the
documented drift of an entry without pins). The rows read
`["pinned-note@g1"]` in the HTML and when the root hydrated, and
`["pinned-note@g2"]` after. On `origin/main` the body fails with
`- "pinned-note@g1"` / `+ "pinned-note@g2"`: there the rows had already
changed when the root hydrated.

Below the path level: `server/__tests__/handle-store.test.ts`
(`freezeDocumentSnapshot`: the document lane, the late channel from the
frozen version, a placeholder replaced and dropped, the default stream
untouched), `handles/__tests__/deferred-resolution.test.ts`
(`recordedOnly`), and `rsc/__tests__/shell-capture-deferred-push.test.ts`
(the funnel's slot for a decoded promise, and the capture's payload through
`buildFullPayload`).

One thing changed in the tests that were here before. A HIT's Flight
payload now holds two handle states, the one it hydrates with and the late
one, so "the last row that carries the value" is no longer the state the
client ends with. The two `serve-shell-request` suites read that state
through `readHandles()` instead (`shownHandles`, `final`). What each test
asserts is the same. One assertion flipped: "a deferred push by a runs: 1
loader reaches the HIT" asserted that the prelude contained the deferred
value.

## Compatibility and risk

**Stored formats, change 1 (built).** Nothing stored changes shape, so no
version bump and no tolerant reader is needed. One existing field is read
for one more thing: whether a pin carries the `runs` bit at all.

- Shell entries: unchanged. `holes` and `runs` keep their meaning, and a
  v0.17 pin without the bits still reads as both. The presence of `runs`
  now also says the capture recorded every settled push of the pinned
  loader, which is true of every writer that writes the bit: the bit and the
  push funnel that sets it arrived together (v0.18, `40df8d26`), and
  `handleOwners` is one release older (v0.17, `7e238485`). A pin without the
  bit makes no such claim, so a record from before `handleOwners`, which
  holds no loader push and relies on the run to supply them, keeps doing
  that. An entry the old code
  wrote, read by the new code, takes the new rule on the next request: its
  pinned loaders restore on a navigation as they did on a document HIT, and
  an old entry without pins restores placeholders. A record written before
  `handleOwners` existed has no owners and restores as a plain replay, as
  before. An entry the new code wrote, read by the old code (a rollback),
  behaves as the old code did.
- Route `cache()` records: unchanged. The new code reads `handleOwners` as
  placeholders; the old code reads the same records with a claim.
- Loader `cache()` entries: unchanged. Change 1 changes what a HIT does with
  a record's placeholders, and reads one old key shape differently: a group
  keyed by a segment id (an entry written before owner keys) is the cached
  loader's own group now, where it used to be replayed under that segment id
  as if it were a loader id. A `"use cache"` entry that reads a
  `cache()`-bound loader before its binding now records the binding's
  replayed pushes under that loader (`${seq}:${loaderId}`) instead of as its
  own (`${seq}:`), because both replays are one function; both key shapes
  were already valid, for old and new readers. That last one is read from
  the code, not probed.

**Stored formats, change 2 (not planned).** Decided against on 2026-10-04 (issue #1002, closed as by design). The maintainer's rule: a loader that reads another loader with `ctx.use()` may run it live, and a handler's `ctx.use()` is where a loader read is baked. The arrangement is an edge case with a way around it (declare the cached loader first, or read it from the handler), and the change would be breaking for every app that has a reader ahead of a cached loader. The analysis below stays as the record of what the change would have been.

- Loader `cache()` entries: an entry the old code wrote while a reader had
  started the loader first has no `handles` (the test "the entry a reader-started run
  writes holds no handle pushes"). The old code hid that: the
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
say so. Change 2 would have added rows (a reader before the binding, on a document
request and on a navigation) and rewritten the "One value per loader per
request" guarantee there: no existing row encodes "a reader that ran before
the binding gets its own run".

**Behavior an existing app can observe.** Most of these are the rule being
applied; they are still changes. The last two "1, built" rows are not the
rule: one is an entry taken as it is (change 2 would have made it whole and is
not planned), the other is a corner that got worse.

| Arrangement                                                                                            | Was                                                             | Becomes                                               | Change         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------- | -------------- |
| Navigation replay, `ssr: false` loader that runs                                                       | live settled push; a deferred push from its entry lost          | the capture's settled push; the deferred push arrives | 1, built       |
| Document HIT of an entry without pins                                                                  | the capture's push next to fresh data                           | the run's push, none if the run made none             | 1, built       |
| Navigation replay of an entry without pins, the run makes no push                                      | the capture's push next to fresh data                           | no push                                               | 1, built       |
| ppr route under `cache()`, the loader's entry newer than the record                                    | the record's copy                                               | the entry's push                                      | 1, built       |
| Any replay, a pinned loader that pushes on the replay what it did not push at capture                  | that push, next to the pinned data                              | no push (a deferred push still arrives)               | 1, built       |
| A run that replaces recorded copies, a loader that pushes around a dependency's push                   | `[own, own, dependency]` (the record's order on a document HIT) | `[own, dependency, own]`, the push order              | 1, built       |
| The same after a `"use cache"` or loader `cache()` replay, on any route                                | `[own, own, dependency]`                                        | `[own, dependency, own]`                              | 1, built       |
| Replay without pins, the loader's `cache()` entry stored without its pushes                            | the record's copy                                               | no push for that loader                               | 1, built       |
| Document HIT of an entry that lost one pin of several, a dependency of a still-pinned loader that runs | the capture's push                                              | the live push (a navigation already showed it)        | 1, built       |
| A reader that ran before a `cache()` binding, entry HIT                                                | fresh value for the reader; the body ran every request          | the cached value; the body does not run               | 2, not planned |
| The same loader's pushes                                                                               | live                                                            | the entry's                                           | 2, not planned |
| The same loader's pushes when a parent started it                                                      | attributed to the parent's segment                              | attributed to the binding's segment                   | 2, not planned |
| Side effects in that body                                                                              | once per request                                                | once per MISS                                         | 2, not planned |

**Hot path, change 1.** A route without `ppr` pays one `isPprEntry` check in
`withCacheLookup` and allocates nothing, where `origin/main` allocated the
delivery literal on every cache-enabled request. A ppr route allocates one
closure (the thunk), and on a record hit a second one (the authority
function); the lanes are computed on its first question. After that hit the
store asks the function once per loader body around each push, a map lookup
each. `onHit` moves, it does not multiply. A cached unit's HIT builds one
map and one short array of the loaders it claimed. **Change 2 (not planned)**: the binding table is built lazily and only for a chain
`bindsLoaderCache` already flagged (memoized per entry); `useLoader` gains
one map lookup when the table exists; with the marker, a HIT of an entry that
pushed nothing compares one character instead of skipping the decode on an
empty string.

**Risk.** For change 1, the pin accessor is a small change over primitives
that have the most tests in this area (`handle-store.test.ts`,
`cache-record-loader-pushes.test.ts`, the restored-pushes block of
`serve-shell-request.rsc-test.tsx`); those pin #888, #929 and #936 and stayed
green. Two existing unit tests changed meaning, both in
`cache-record-loader-pushes.test.ts`. One served a document tail from a
snapshot without loader pins and expected the capture's pushes to stand next
to a loader that ran. That is the `maxSnapshotBytes` case; the test now seeds
the pin for the pinned contract and has a second block for the entry without
pins. The other restored a record stripped of `handleOwners` next to a
current pin and expected the run's pushes to be added; a record that old has
pins without the `runs` bit, and the test now seeds one of those. The seed's
key changed from segment id to loader id, which is internal: every reader of
it is `servedPins`. For change 2 (not planned), the binding-scope constraint above is the part with the
least existing coverage: today a binding always starts from a kickoff. The
semantic matrix must run for it (`segment-resolution/` is gated on it), and
"a cached hole a bake-lane loader starts first keeps its push in the captured
place" in `serve-shell-request.rsc-test.tsx` asserts the live push that rule
replaces.

## Delivery

The two changes are independent, so they ship separately.

**Change 1, done (closes #1001 and #1003, and replaces PR #1018 for those
two):** the pin accessor over a seed keyed by loader; `OwnedPushDelivery` as
one function of a loader's `RecordAuthority`; `withCacheLookup` stops reading
`docTail` and the lanes for pushes; `onHit` before the restore; placeholders
as their own slot kind; one replay (`appendHandles`) for every cached unit,
which takes the place of the placeholders of each loader it claims; the push
order of a run that replaces copies. With it: the paths nobody had filed that
the same change covers (a prefetch replay, the seeded fallback, an entry
without pins on a document HIT, a dependency without pins, a run that makes
no push, a pinned loader whose capture pushed nothing, a route record's copy,
a loader entry newer than a shell without pins), the
#1018 regression cases kept green, unit tests next to `handle-store.ts`,
`handle-snapshot.ts`, `shell-snapshot.ts`, `cache-lookup.ts` and
`loader-cache.ts`, browser e2e
for #1001, #1003 and the `maxSnapshotBytes` document HIT in both apps, dev
and production.

**Change 2, not planned.** Decided against on 2026-10-04 (issue #1002, closed as by design). The maintainer's rule: a loader that reads another loader with `ctx.use()` may run it live, and a handler's `ctx.use()` is where a loader read is baked. The arrangement is an edge case with a way around it (declare the cached loader first, or read it from the handler), and the change would be breaking for every app that has a reader ahead of a cached loader. The analysis below stays as the record of what the change would have been. What it would have
contained, kept for reference:

1. The binding table and `useLoader` routing; removal of the interceptor and
   the reader-first branches.
2. The entry marker, if open question 1 says so.
3. The six #1002 tests assert the new values (they already are plain `it`,
   pinning today's). Unit tests
   next to `loader-resolution.ts` and `loader-cache.ts`. Browser e2e for
   #1002 in both apps, dev and production. Docs, changelog (`### Breaking:`
   for the reader rule), matrix rows.

**Later (follow-ups; each extends the two changes, none deletes them):**

- The table covers every registered loader, with its bake key, so a reader of
  a pinned loader gets the pin: one value per loader on shell replays too.
  The pin question then moves from the restore into the resolver, and the
  accessor keeps one caller.
- The store's remaining copy primitives (`pushReplayed`, `pushPlaceholder`,
  `pushRestored`) fold into one push that takes the loader's source. The
  record side is already one statement (`RecordAuthority`); a cached unit's
  replay is not yet.
- A capture stops writing loader-owned pushes into a real route `cache()`
  record: an artifact that can only ever hold a copy.
- The shell record names the registered loader that ran a dependency, which
  replaces the all-pinned approximation for dependencies and turns the two
  dependency tests green. An additive field on the record.
- `getRequestContext().use()` joins the table.

## The evidence

The path-level evidence is
`serve-shell-request-push-ownership.rsc-test.tsx`, run from
`packages/rangojs-router` with
`./node_modules/.bin/vitest run --config vitest.rsc.config.ts src/testing/__tests__/serve-shell-request-push-ownership.rsc-test.tsx`:
`23 passed | 8 expected fail (31)` when change 1 landed, and
`45 passed | 8 expected fail (53)` with the #1035 tests (17 of them red on
`ede1367f`, 5 controls). On `origin/main`'s sources (the ten
changed source files checked out from `eed288b1`, the test file as it is)
the same command gives `15 failed | 9 passed | 7 expected fail`: the 14 below,
and one expected failure that passes there (the partial-pin dependency, see
the pending table).

Red on `origin/main`, green with change 1:

| Test                                                                                     | Failed on `origin/main` with                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a navigation replay keeps the captured push next to the pinned data (#1003)              | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (data `eb@g1`)              |
| a prefetch replay keeps the captured push next to the pinned data                        | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]`                             |
| a navigation whose explicit route cache() misses replays the shell record ...            | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (data `eb@g1`)              |
| an ssr: false loader on a layout: a HIT and a navigation replay keep the captured push   | `expected [ 'eb-after@g3' ] to deeply equal [ 'eb-after@g1' ]` (the navigation)            |
| a navigation replay delivers the deferred push ... (the entry misses at capture, #1001)  | nav: `deferred: []`, expected `[ 'deferred-note-2' ]`                                      |
| a navigation replay delivers the deferred push ... (the entry is warm at capture)        | nav: `deferred: []`, expected `[ 'deferred-note-1' ]`                                      |
| an entry whose pins maxSnapshotBytes dropped: a document HIT and a navigation replay ... | the HIT: `expected [ 'eb-after@g1' ] to deeply equal [ 'eb-after@g2' ]` (data `eb@g2`)     |
| without pins a dependency's push follows the fresh run of the loader that awaits it      | hit: data `baked-dep@g2`, push `dep-note@g1`, expected `dep-note@g2`                       |
| a run that makes no push leaves none ...                                                 | hit and nav: data `once@g2`, push `[ 'once-note@g1' ]`, expected `[]`                      |
| a loader's cache() entry takes the place of the record's copies, the dependency's ...    | data `owned-dep@g2`, push `dep-note@g1`, `owned-dep-note@g1`, expected both `@g2`          |
| a document MISS that hits the route cache() record and the loader's cache() entry ...    | `expected [ 'owned-note@g1' ] to deeply equal [ 'owned-note@g2' ]` (data `owned@g2`)       |
| a pinned loader whose capture pushed nothing: a push its run makes on a replay ...       | hit and nav: data `late@g1`, push `[ 'late-note@g2' ]`, expected `[]`                      |
| a loader that pushes around its dependency's push: its entry's HIT and its run ...       | the HIT: `[ 'order-a@g1', 'dep-note@g1', 'order-b@g1' ]`, expected the same three at `@g2` |
| a loader's cache() entry stored without its pushes shows none ...                        | data `owned@g2`, push `[ 'owned-note@g1' ]`, expected `[]`                                 |

The last three came with the review of change 1. The order test fails on
`origin/main` at its first assertion, the document HIT, on the record's
`@g1` values; with the navigation asserted first it fails there on the order
itself, `[ 'order-a@g2', 'order-b@g2', 'dep-note@g2' ]`. On the commit that
first built change 1 (`c5068792`) it fails on that order for the document
HIT as well, and the pinned-loader test fails with the assertion in the
table. The last row states a change, not a repair: see "A loader `cache()`
entry without its pushes" above.

Controls, green before and after: the document HIT with pins; the navigation
replay of a navigation-only entry (the #1018 regression: it fails on the
#1018 head `5ca6c967` with
`expected [ 'eb-after@g1' ] to deeply equal [ 'eb-after@g2' ]`); an explicit
route `cache()` hit on a navigation; a pin without the `runs` bit keeping the
push its run makes; a pinned loader a navigation does not revalidate; a
`"use cache"` entry's copy of a dependency's push showing once on a replay
without pins, whether the capture hit that entry or ran the dependency; a
handler on the binding's own route; the ppr reader declared after the hole.
A dependency next to its pinned loader is asserted in
`serve-shell-request.rsc-test.tsx` (the bake-lane block), on a document HIT
and on a navigation replay.

Still expected failures (`it.fails`), with the assertion each fails on:

| Pending test                                                                            | Fails with                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| the entry a request writes records the cached loader's pushes when a reader started ... | `expected '' to contain 'sch-note@g1'`                                                                                           |
| a sibling loader declared before the binding (a route without ppr)                      | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2`                                                         |
| a parent layout's loader reading a child route's cached loader                          | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2`                                                         |
| a parent layout's handler reading a child route's cached loader                         | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `layout-sch@g2`                                                         |
| a sibling loader declared before the binding on an intercept                            | `bodyRuns: 2`, data `sch@g1`, push `sch-note@g2`, reader `reader-sch@g2`                                                         |
| a ppr route: an ssr: false reader declared before the cached hole ...                   | `bodyRuns: 2`; hit and nav: data `sch@g2`, push `sch-note@g3`                                                                    |
| (unfiled) a dependency of a pinned loader, while another ssr: false loader lost its pin | data `holey-dep@g1`, push `dep-note@g2`, expected `dep-note@g1`. Passes on `origin/main`                                         |
| (unfiled) a dependency whose push the awaiting loader's cache() entry did not record    | data `owned-dep-once@g2`, push `dep-once-note@g1` and `owned-once-note@g2`, expected the second only. Fails on `origin/main` too |

The two files share their harness and the loaders both use
(`fixtures/shell-request-data.tsx`: `shellHarness`, `DeferredOwnedLoader`,
`OuterDepLoader`, `OnceNotedBakeLoader`), so a route in one cannot drift from
its twin in the other.

Below the path level, each changed module has its own tests:
`server/__tests__/handle-store.test.ts` (`setRecordAuthority`, placeholders
against replays in `settleLoaderRun` and `replacePlaceholders`, the push
order of a run over copies), `cache/__tests__/handle-snapshot-owned-pushes.test.ts`
(`restoreHandles` against each authority, `appendHandles` for a function and
for a loader's own entry, with, without and refused a claim),
`cache/__tests__/shell-snapshot.test.ts` (the seed keyed by loader, the
`complete` bit), `router/segment-resolution/__tests__/loader-pins.test.ts`
(`loaderPins`: the lanes, the dependency rule, a capture, the disarmed seed;
and the value and the pushes answered from one pin, including the
both-lanes loader where they differ on purpose),
`router/segment-resolution/__tests__/loader-cache-handles.test.ts` (a HIT and
a MISS over a record's copies, in one order),
`router/match-middleware/__tests__/cache-lookup-owned-pushes.test.ts`
(`withCacheLookup` on a document tail, a navigation replay, the seeded
fallback, an explicit hit and a plain request; a record without loader
copies; a route without `ppr`) and
`cache/__tests__/cache-record-loader-pushes.test.ts` (a pinned tail and a
tail without pins through `router.match`).

In a browser, `expectReplayKeepsCapturedPushWithPinnedData` (#1003),
`expectReplayDeliversDeferredPush` (#1001),
`expectPinlessHitKeepsRunPushWithRunData` and, for #1035,
`expectShellHitHydratesFromRecord` in `tests/shared-e2e/src/index.ts`
run in a dev and a `(production)` describe in both apps
(`packages/rangojs-router/e2e/shell-push-ownership.test.ts`,
`tests/cloudflare-basic/e2e/ppr-push-ownership.test.ts`). On `origin/main`'s
sources they fail in both apps and both modes with: expected
`pinned-note@g1`, received `pinned-note@g2`; `deferred-note@g1` missing;
expected `pinned-note@g2`, received `pinned-note@g1`.

## Open questions

Answered for change 1:

- Dependencies when the pins are partial (was question 2): "stands while
  every `ssr: false` loader is pinned" is accepted for now. Its two wrong
  cases are expected failures, and one of them is new on a document HIT.
- `/shared-dep` (was question 5): leave it as documented.
- The paths nobody filed (was question 7): fixed with change 1 where that
  change covers them.
- Browser e2e (was question 8): #1001 and #1003 in both apps, dev and
  production, plus the `maxSnapshotBytes` document HIT.
- A pinned loader whose capture pushed nothing: fixed. The pin's `runs` bit
  tells a current record from one written before captures recorded loader
  pushes, so no marker and no format change was needed.
- The order of a loader's pushes around a dependency's when its run replaces
  copies: the push order, `[own, dependency, own]`, on every path.

Open only if change 2 is ever revived (not planned, see "The #1002
decision"); none of them blocks anything today:

1. Old loader `cache()` entries: the completeness marker (one refill per key
   after the upgrade, no visible gap) or a changelog note (no refill, a
   missing push until the entry expires)? The recommendation is the marker.
   Change 1 raises the stake a little: an entry without its pushes now shows
   none on a replay without pins, where the record's copy used to cover for
   it.
2. A reader of a pinned loader: with the table, or later? It changes what
   such a reader sees on a HIT (the capture's value instead of a fresh one).
3. A cached loader a parent started pushes into the binding's segment under
   this design, which moves that push to where the binding-first order puts
   it. Confirm that is the wanted order.
4. `getRequestContext().use(Loader)`: route it through the table, and when?
