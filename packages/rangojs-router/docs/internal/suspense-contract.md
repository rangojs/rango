# The Suspense contract

If you are about to create, memoize or hand a promise to one of the router's Suspense
boundaries, or to touch `src/segment-system.tsx`, `src/route-content-wrapper.tsx`,
`src/segment-loader-promise.ts`, `src/segment-boundary-content.ts` or `src/use-loader.tsx`,
start here. Same if you are adding anything that needs to update the page after it
committed.

The promise this subsystem keeps: **what is on screen stays on screen.** A page the user
is looking at is never replaced by its own `loading()` skeleton while nothing in it is
pending, and never thrown away and mounted again by a commit that should have reconciled
it.

That sounds like something React gives you for free. It does not, and the reason is the
whole point of this document.

## What broke

Issue #1079. Click a prefetched link into a layout with `loading()`, then click a plain
link to a sibling. The layout you are looking at disappears behind its skeleton for
300 ms and comes back. Nothing was pending: the layout's content and loader data were in
hand before the commit.

The cause is one line of React semantics. `use(promise)` on a native promise React has
never seen cannot return in that render, even when the promise settled long ago: React
has to attach a `then` to learn the value, so it suspends for a microtask. Inside a
transition nobody notices, because React holds the old screen. On an urgent commit the
boundary shows its fallback, and React keeps a fallback it has shown for 300 ms.

The router handed the layout `Promise.resolve(node)`, a promise that is settled and
unread by construction (`getMemoizedContentPromise`, which #1080 removed). Every lane that
awaits the tree first (`forceAwait`: back/forward, stale revalidation, a fully
prefetched click) handed the node itself, so the bug only showed on the plain lane right
after an awaited one. It took a while to find for exactly that reason. #1080 fixed it by
handing every lane the settled value (rules 1 and 2).

## Why React will not tell you

You would expect React's dev warning, "A component was suspended by an uncached promise",
to catch this. It cannot. `trackUsedThenable`
(`react-dom-client.development.js:6262-6276` in react-dom 19.3.0) compares the thenable
at one `use()` call against the one it saw at that same call in a replay of the same
render attempt. Its state is cleared when the render finishes or unwinds. A boundary
that is handed a different promise through its props on the next render is, to React, a
new render reading a new value.

Measured before #1080 with the guard recording: the router's dev suite printed that
warning zero times across 1405 tests, while 25 of those tests handed content on screen a
settled promise it had not read. The warning stays on the console guard's deny list, because
the day it does fire something is badly wrong, but it is not what protects this
contract. The audit below is.

## The rules

### 1. One stable thenable per pending value

While a value is pending, every render hands the boundary the same thenable. A new
promise for the same value makes React start waiting again, and a boundary that was
about to reveal shows its fallback instead.

Where this is kept today: `getBoundaryContent` (`src/segment-boundary-content.ts:20`)
hands a component that is still a promise (a Flight-streamed segment) as that same
promise; `getMemoizedLoaderPromise` (`src/segment-loader-promise.ts:115`) hands one
aggregate per set of loader references while it is pending; the per-loader streams
`buildLoaderStreams` passes through untouched (`src/segment-system.tsx`). The three
places that read them are `Suspender` (`src/route-content-wrapper.tsx:178`),
`LoaderResolver` (`:330`) and the `useLoader` read site (`src/use-loader.tsx:226`).

A navigation to another URL hands new values, and that is not a violation: it is new
data. So is a replacement that is already settled in a form React can read (rule 2).

### 2. A settled value is handed in a form React reads synchronously

If the value is in hand, hand the value: the node, the array, or a thenable that already
carries `status: "fulfilled"` (a Flight chunk, or a promise React has read before). Do
not wrap it in `Promise.resolve`, and do not build a fresh `Promise.all` over settled
parts.

This is the rule #1079 broke, and what #1080 put in place on every lane. In the
browser, `getBoundaryContent` (`src/segment-boundary-content.ts:20`) hands a settled
component as the node itself; only the server wraps it, so Suspense still streams the
fallback in the document. `getMemoizedLoaderPromise` remembers the array once its
aggregate fulfils and from then on hands that array (`return entry.value ??
entry.promise`, `src/segment-loader-promise.ts:134`), so a later tree reads the loader
data without suspending. A boundary may get the promise in one tree and the settled
array in a later one: that is a different value at a different time (rule 6), not a
switch under a render.

One gap is left, and it is a timing one. `entry.value ?? entry.promise` is decided when
the tree is built. A tree built while the loader data is pending, and rendered only after
the aggregate has settled, still hands the loader boundary a settled promise React has
not read. On a refresh under load that is what happens: with 4x CPU throttling the shell
layout's loader data fulfilled 13 ms after the build and its boundary rendered 94 ms
after it, in 6 of 6 runs (0 of 64 unthrottled on a quiet machine); cloudflare-basic needs
8x throttling for the same 6 of 6. The refresh commits in a transition, so nothing shows;
on an urgent commit it would be the 300 ms fallback. The baseline carries it as an
intermittent I2 entry in each app, with that reason.

The fix direction, for a PR of its own: in `getMemoizedLoaderPromise`, the same `.then`
that sets `entry.value` also stamps `status: "fulfilled"` and `value` on the router's
promise. That is how the Flight client marks its chunks and how React's
`trackUsedThenable` marks a thenable it has read, so any later render, concurrent or
not, reads it synchronously, and the promise keeps its identity.

### 3. No fallback while nothing is pending

A fallback on screen means the boundary is waiting for something the router handed it:
its content, its loader aggregate, one of its loader streams, the payload still streaming,
or (dev only) a client reference still loading. A fallback with none of those is the bug.

A fallback over content that was on screen **while its data is pending** is not this bug.
An urgent commit does that on purpose: `transition({ when })` gated off re-suspends its
boundary so the click has visible feedback (#995). The audit counts those
(`shownWhilePending`) and does not report them.

### 4. The tree keeps its shape

A segment that keeps its React key between two renders keeps its wrapper chain, or React
unmounts and remounts it and every piece of state under it is gone. The chain and the
key rules are in [tree-structure.md](../tree-structure.md): read it before you add a
wrapper.

Two remounts are documented and exempt: a key that changes (a param change outside a
transition scope gives the route a new param-bearing key), and a segment replaced by
another type under the same id (an error or notFound segment takes its route's place,
with its own key rule and wrappers). A key whose shape alone changes, `id` in one render
and `id-params` in the next, is neither: it means `inTransitionScope` differed between
the two renders.

### 5. Only a navigation or an action hands React a tree

Anything that needs to update after the page committed goes through a store its readers
subscribe to, or through a pending promise read with `use()`. Nothing else calls the tree
update emitter. An inner update, like `useLoader().load()`, is an in-place update.

The allowed causes, and where each one emits:

| Cause                | What it is                                                     | Where it emits                                                                                          |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `navigation`         | a link click, `router.push` / `replace` / `refresh`            | `src/browser/partial-update.ts:476` (cached), `:506` (leave intercept), `:736` (partial), `:843` (full) |
| `popstate`           | back/forward restored from the history cache, or refetched     | `src/browser/navigation-bridge.ts:712`; a refetch goes through `partial-update.ts`                      |
| `stale-revalidation` | the background refresh after a back/forward onto a stale entry | `src/browser/partial-update.ts:736`, `:860`                                                             |
| `action`             | a server action's result, its error boundary, its refetch      | `src/browser/server-action-bridge.ts:663`, `:924`; `partial-update.ts` in `action` mode                 |
| `error`              | a failed request rendered into the tree                        | `src/browser/network-error-handler.ts:37`                                                               |
| `hmr`                | the refetch after a source edit (dev)                          | `src/browser/rsc-router.tsx:598`                                                                        |

The one subscriber is in `src/browser/react/NavigationProvider.tsx:433`: `store.onUpdate`
receives the update and calls `setPayload`.

What a new feature that needs a late update uses instead:

- **A store its readers subscribe to.** Loader refreshes go through `loaderStore.subscribe`
  (`src/use-loader.tsx:308`), handle updates through `eventController.subscribeToHandles`
  (`src/browser/react/use-handle.ts:110`). The reader re-renders where it sits.
- **A pending promise read with `use()`.** Hand the reader one stable promise when the
  page commits (rule 1); when it settles, React reveals the reader. That is how a
  streamed loader reaches its reader with no second tree update.

What the rule expects per user step, and what main does (measured in the router test-app
and in cloudflare-basic, dev, `tests/shared-e2e/src/suspense-cases.ts`):

| Flow                                                  | Expected by the rule                                                               | Main                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A link click (plain, same route, inside a transition) | 1 `navigation`                                                                     | 1                                                        |
| A click superseded by a second click                  | at most 1 per click                                                                | 2 (the first payload commits first)                      |
| `router.refresh()`                                    | 1 `navigation`                                                                     | 1                                                        |
| A server action                                       | 1 `action`                                                                         | 1                                                        |
| Back/forward onto a stored page                       | 1 `popstate`                                                                       | 1                                                        |
| Back/forward onto a page an action made stale         | 1 `popstate`, and 1 `stale-revalidation` only if the revalidation brings something | 1 `popstate` (the fixture's revalidation brings nothing) |
| Back that closes an intercept                         | 1 `popstate`                                                                       | 1                                                        |
| A document load and its hydration                     | 0                                                                                  | 0                                                        |
| A prefetch                                            | 0                                                                                  | 0                                                        |
| `useLoader().load()`                                  | 0                                                                                  | 0                                                        |
| A handle pushed after the page committed              | 0                                                                                  | 0                                                        |
| A `clientUrls()` navigation                           | 1 `navigation`, and one commit                                                     | 1 `navigation`, and 2 to 4 commits                       |

The last row is where main does not meet the target. A cross-route navigation inside a
`clientUrls()` group presents its destination at the click with a local state update
(`beginClientUrlNavigation`, `src/client-urls/navigation.ts`; the intent lives in
`ClientUrlsRoot`, `src/client-urls/client-root.tsx:126`), the router's tree update
commits it again when the server answers, and clearing the intent commits it a third
time. Its reader is handed a promise that never settles (`PENDING_FOREVER`,
`client-root.tsx:30`) and then the real stream. Measured in both apps and both modes:
3 commits of the destination and 2 of its reader behind an inline boundary, 2 behind
`loading()`, 4 and 4 for a same-route navigation; 2 promises handed to the reader in
each. Entering a group from outside is already one commit and one promise. The three
cases that miss are expected failures that name #1079, so they flip when the feature
moves onto the one-commit model.

### 6. Nothing a render reads changes while React renders

The router decides what a boundary gets when it builds the tree. After it hands the tree
to React, the only change is a promise settling, once. A segment object, a props object,
a loader map: none of them is written again. Why so strict? React may render a tree more
than once (a transition that suspends and retries, StrictMode, a boundary that reveals
later), and every render has to see the same inputs. A write after hand-over makes one
render of a tree read different values from another render of the same tree, and with
React Compiler a component may not even re-read them: the compiled `ParallelOutlet`
caches `renderSlotContent(segment)` on the segment's identity, so it keeps what it read
first.

When a later tree needs a different value, it gets a new object. A promise in one tree
and the settled value in a later tree is fine: a different input at a different time.
A switch within one render, or one that shows a fallback, is not.

The known violation on main: `renderSegments` writes `loaderIds`, `loaderDataPromise`,
`loaderStreams` and `awaitedLoaderIds` on a parallel slot's segment object in place
(`src/segment-system.tsx:769`, `:787-803`), and when the slot is reused from the cache
that object is the one the previous tree handed to React. `ParallelOutlet` reads those
fields during render (`renderSlotContent`, `src/client.tsx:40`). The audit reports a
write to a segment object after its tree was handed to React as I7. Measured with the
guard recording, twice: it fires in 15 dev tests, 7 in the router's suites and 8 in
cloudflare-basic, all on a parallel slot with a loader (`@zlbsSlot` in the held-boundary
fixture, `@cart` in mini, `@sidebar` in the blog), and only on `loaderIds` and
`loaderDataPromise`. Every one is in the baseline.

## How it is enforced

Four layers, cheapest first.

**A static tripwire.** `pnpm check:suspense-contract`
(`tools/check-suspense-contract.mjs`, CI lint job) fails when a file outside two short
lists calls the tree update emitter, or builds a router boundary or a value one waits
for, and when a file outside a third references an `Audited*` variant. It also fails
when an emit call is not preceded by its cause in the same synchronous stretch: a cause
named before an `await` is gone by the time the emit runs, so I6 would fire. It resolves
calls with the TypeScript checker, so an import or namespace alias
(`rcw.RouteContentWrapper`), a destructured binding (`const { emitUpdate: send } =
store`), an element access (`store["emitUpdate"](u)`), a function that forwards its
argument to the emitter, and a shorthand or computed-key write
(`Object.assign(segment, { loaderDataPromise })`) all count, while an app component's
own `onUpdate` prop does not. `Reflect.apply` and `.call`/`.apply` are out of its reach,
as its header says. It also fails when an audit module gains an import (see "a build
does not change" below). It pins the place, not the behaviour: a new entry means "read
this document and add a case first".

**The dev audit.** `src/suspense-audit.ts` (hooks in `src/suspense-audit-react.tsx`) watches
every boundary in a dev build and reports on `console.error` under `[rango][suspense]`.
Counters are on `window.__rangoSuspenseAudit`. It runs only where
`INTERNAL_RANGO_SUSPENSE_AUDIT` is set, which is this repo alone: the e2e webServers and
fixtures of the router test-app and cloudflare-basic, and the router's vitest config. A
consumer's dev server never sets it, so it builds the product boundaries and the audit
prints nothing. There is no public option. The variable reaches the client the way
`INTERNAL_RANGO_DEBUG` does: the discovery plugin bakes it into
`src/internal-suspense-audit.ts` (`src/vite/inject-client-debug.ts`). Set it on the
server process itself, not on the caller: turbo's strict env strips variables it does
not know.

| Invariant | Message            | Counter         | Fires when                                                                                                |
| --------- | ------------------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| I1        | `I1 swap`          | `swaps`         | a boundary on screen, waiting on a pending thenable, is handed another pending one for the same URL       |
| I2        | `I2 untracked`     | `untracked`     | content that has been on screen is handed a native promise React has not read, and React finds it settled |
| I3        | `I3 idle-fallback` | `idleFallbacks` | a boundary new to the page shows its fallback because React suspended on a router promise already settled |
| I3        | `I3 resuspended`   | `resuspended`   | a fallback replaces content on screen because React suspended on a router promise already settled         |
| I4        | `I4 remount`       | `remounts`      | a segment is unmounted and mounted again under the same key                                               |
| I5        | `I5 drift`         | `drifts`        | a segment keeps its key and changes its wrapper chain, or its key changes shape                           |
| I6        | `I6 uncaused`      | `uncaused`      | a tree update reaches React from an emitter that named no cause, or a cause outside the six               |
| I7        | `I7 mutated`       | `mutations`     | a property of a segment object is written after the tree holding it was handed to React (rule 6)          |

Four more fields are counts, not violations: `treeUpdates` (per cause), `handed` (the
distinct thenables each boundary or read was handed), `shownWhilePending` (rule 3's
by-design fallbacks) and `unattributedFallbacks` (below).

The audit must not change what the page does, so it never attaches a reaction to a
promise it is handed: a `.then` marks a rejected promise handled, and dev would stop
raising the unhandled rejection a build raises. It reads the `status` and `value` that
React's `use()` and the Flight client leave on a thenable instead. That is also how I2
is judged: a native promise React has not read is handed over, and two microtasks
later its status says React read it and found it settled.

I3 reports only a fallback the router owns: React suspended on a promise the router
handed unread, and found it already settled (the same detection as I2, at any boundary,
on screen or not). Every other fallback is the content's own: an app's `use()`, a
`React.lazy`, a client reference. That holds when the boundary also holds a promise
React has read, which every loader boundary does. Those fallbacks are counted in
`unattributedFallbacks`, not reported. A needless suspension is consumed by the fallback
it caused and forgotten once the content is on screen, so a later fallback of the app's
own is not blamed on it.

I4 and I5 compare with the tree React holds. A tree `renderSegments` builds is held
when an emit hands its root to React (`auditTreeUpdate(update.root)` in
`NavigationProvider`), and an HMR root, emitted as a promise, once React's `use()` has
read it. A tree that never reaches React, an aborted navigation's, is never compared
with. I7 snapshots every segment of a held tree and keeps the segment itself weakly:
when the next tree starts, every handed segment still alive (the history cache keeps
them after the tree on screen drops them) is compared with its snapshot, and again as
the tree reuses one, where `renderSegments`' own rewrites happen. The boundary maps are
keyed by names that carry params, so they keep the newest 500.

The audit is dev only, and a build does not change: `RouteContentWrapper`,
`LoaderBoundary` and `OutletProvider` are the product components, untouched. Their
audited variants (`AuditedRouteContent`, `AuditedLoaderBoundary`,
`AuditedOutletProvider`) are exports of their own, and `segment-system.tsx` picks one
where it creates an element, inside a `process.env.NODE_ENV !== "production"` test the
minifier folds away; a slot's boundaries (`client.tsx`) and the resolver's provider are
swapped for their audited variants after the fact, behind the same test. Every other
audit call sits behind it too.

You might wonder why not the obvious ways. Both were measured in cloudflare-basic's
client router chunk and both leave bytes behind. A dev branch inside the product
component costs 76 B gzip: React Compiler runs before `NODE_ENV` is folded and keeps the
branch's memo slots. One `export const X = dev ? Audited : Product` per module costs
27 B: the alias statements survive minification. And the server bundles are not
minified at all: they keep JSDoc blocks, so the dev-only declarations carry line
comments. With the current layout, cloudflare-basic, cloudflare-stress-demo and the
test-app build byte for byte as on main, server bundles included, apart from the cache
version table, which hashes the sources. `check:bundle-guards` fails if an audit module
reaches a client build.

One more way to lose that, and it is the quiet one: an import. The audit modules are
tree-shaken from a build, but their static imports still decide where the imported
module lands in the client router chunk, because `route-content-wrapper.tsx` imports
them early. Importing `handles/is-thenable.ts` into `suspense-audit.ts`, or
`NavigationStoreContext` into `suspense-audit-react.tsx`, moved existing code in
cloudflare-basic's router chunk and renamed its minified identifiers (+3 B raw, no new
code). So the audit inlines its thenable check, learns that a payload is streaming
from a probe `rsc-router.tsx` sets at boot (`setSuspenseAuditStreamProbe`), and the
static check allows the two modules only the imports they have today.

**The console guard.** `tests/shared-e2e/src/console-guard.ts` is installed by
`useFixture` in both apps, so every dev e2e test runs under it with no opt-in. A deny
list (the audit's six messages, React's hydration, key, update-while-rendering,
max-update-depth and uncached-promise warnings, and any router message at error level)
fails the test that printed one. A test that provokes a message on purpose declares it
with `expectConsole(page, { allow: [/.../] })`, and fails if the message does not appear.
Messages on neither list go to the test's annotations and to one `messages.jsonl` per
run.

What fails on main today and no test asks for is listed in
`tools/e2e-console-baseline.json`, one entry per test and rule, each with a reason:
messages no test declares (`Undeclared, cause: ...`), the intermittent I2 reports of
rule 2's timing gap, and the I7 reports of the slot writes under rule 6. `pnpm check:e2e-console-baseline` (CI lint job) fails on an
entry without a reason, or one whose full title path is not a test in that app's dev
project as `playwright test --list` enumerates it; the guard itself fails a test whose
entry no longer fires. A message that depends on timing goes into the baseline marked
`intermittent`, not behind a retry. A test that provokes an error on purpose (an error
boundary, a failed action, a redirect loop) declares it with `expectConsole` instead.

Before #1080 the baseline also held 36 I2 entries, in four lanes: an action commit
inside a transition (13 tests) and a same-route navigation inside a transition scope
(10), both invisible because the transition held; and the same two gated off by
`transition({ when })` (12 and 1), where the route's fallback covered the content for
300 ms. Every one was a route's content boundary handed `Promise.resolve(component)`.
#1080 took all 36 to zero, measured with the guard in both apps; the timing gap under
rule 2 is a different shape (a loader boundary, and only under load).

**The cases.** `tests/shared-e2e/src/suspense-cases.ts` and
`held-boundary-scenario.ts`, run by `suspense-cases.test.ts` and `held-boundary.test.ts`
in both apps, in a dev and a `(production)` describe. Each case asserts the flash probe
(DOM), the mounted instance of what is held, the audit at zero, and the tree updates each
step handed React. Cases that are red on main are expected failures listed by title with
`#1079`; they fail the run the day they pass, so the entry gets removed. The guard
does not mask that: when an expected failure's body passes, it puts its findings in the
test's annotations instead of throwing, and Playwright reports "expected to fail, but
passed". Two remain: the
`clientUrls()` one-commit cases (rule 5), and in a build a client component at the top of
a route's content whose module the click uses for the first time in the document: the
Flight client waits for that module's `import()` although its chunk is already fetched,
so the route's `loading()` shows for 300 ms (see below).

Unit level: `src/__tests__/suspense-audit.test.tsx` runs each invariant against real React
with StrictMode on and off, including a streaming navigation the audit must stay silent
on, and the #1079 shape itself (an awaited render, then an urgent render of the same
boundaries).

## Dev is not production

Two things a dev build does that a build does not. Both are encoded, and both decide
which assertions run where.

- **Client references load per render in dev.** `@vitejs/plugin-rsc` tags client
  reference ids freshly on each render, so the Flight client hands the first render a
  lazy that is still `blocked` on its import for a few milliseconds. A boundary new to
  the page shows its fallback, and React keeps it 300 ms. The audit looks for a blocked
  reference in what the boundary was handed and stays silent. Assertions that a **new**
  boundary shows no fallback are production only.
- **The document's own streamed fallback** stays at least 300 ms. The flash probe is
  installed after it is gone.

In the other direction, the audit's counters and the tree-update counts are dev only: a
build carries no audit. In production the cases assert the flash probe, the mounted
instances and the fixtures' own commit counters.

## Adding a producer

A producer is anything that creates a value a boundary waits for: a new lane in
`renderSegments`, a new kind of slot, a merge of loader results, a cache restore.

1. Decide what the boundary is handed when the value is pending (one thenable, stable
   across renders) and when it is in hand (the value). Both branches, on every lane:
   plain, awaited, action.
2. Check the wrapper chain is the same on every lane ([tree-structure.md](../tree-structure.md)).
3. Add a case to `suspense-cases.ts` that reaches it on screen: mounted, then re-rendered
   by an urgent commit with the value in hand. Run it in dev and production, in both
   apps.
4. Add the file to `PRODUCERS` in `tools/check-suspense-contract.mjs` with its reason.

If the feature needs to change the page later, do not emit a tree update. Use a store or
a promise (rule 5). If you believe it really is a new cause, add it to `TreeUpdateCause`
in `src/suspense-audit.ts`, to the table above, and to `EMITTERS` in the check.

## Reading an audit message

- **`I2 untracked at content:<id>`**: that segment's content was handed
  `Promise.resolve(node)` (or an equivalent) while on screen. Hand the node.
  `at loaders:<key>` is the loader aggregate; `at read:<loader id>` is a `useLoader` read.
- **`I3 idle-fallback`**: a new boundary suspended on something already settled. Usually
  the same fix as I2, one lane earlier.
- **`I3 resuspended ... with nothing pending`**: the 300 ms skeleton of #1079.
  A held boundary is handed its settled content and loader data since #1080.
- **`I5 drift at outlet:<id>: wrapper chain link N changed from A to B`**: two lanes build
  different trees for that segment. Make the wrapper unconditional.
- **`I4 remount`**: the consequence of a drift at or above the segment's outlet. A link
  that changes below the outlet (the loader error boundary, a ViewTransition, the
  content wrapper) remounts the content under it and is reported by I5 alone.
- **`I6 uncaused`**: something called the emitter without `auditTreeCause`. If it is one
  of the six causes, name it. If it is not, it should not be a tree update.
- **`I7 mutated at segment:<id>: <key> was written after ...`**: code wrote a field of a
  segment object that a tree React holds was built from. Build a new segment object
  with the new value instead, so the tree on screen keeps the one it rendered with.

## Running the suites

From `packages/rangojs-router` (and the same in `tests/cloudflare-basic`):

```bash
./node_modules/.bin/playwright test --project=dev suspense-cases.test.ts held-boundary.test.ts
./node_modules/.bin/playwright test --project=production --no-deps suspense-cases.test.ts held-boundary.test.ts
```

`RANGO_CONSOLE_GUARD=record` records without failing, `RANGO_CONSOLE_GUARD_DIR=<dir>`
chooses where `messages.jsonl` and `tests.jsonl` go, and
`node tools/check-e2e-console-baseline.mjs --from <dir>` compares a recorded run with the
baseline (`--write` rewrites it and leaves new reasons empty for you to fill).
`RANGO_SUSPENSE_MEASURE=1` prints the tree updates and commit counts of each case step
instead of asserting them. `INTERNAL_RANGO_DEBUG=1` makes the audit trace every
hand-over, mount and fallback. The webServers and fixtures set
`INTERNAL_RANGO_SUSPENSE_AUDIT=1` themselves; a dev server you start by hand needs it
too, or the audit is off.

## What the audit does not see

- I3 stays silent while a payload is streaming. The audit knows what the router handed
  a boundary; it does not know what inside the content waits on the stream. So a
  route-level `loading()` that shows while only readers behind their own `<Suspense>`
  are waiting is not an I3 report. The flash probe asserts it in a build instead: "a
  route whose loaders are all read behind their own boundaries" (green since #1080) and
  "a client component directly in a route's content" (red: the click is the first use of
  the component's module in the document, so the Flight client's `requireAsyncModule`
  blocks the element on plugin-rsc's `import()` promise for 3 to 6 ms with no request,
  and the route's boundary is the nearest one; 300 ms in both apps). The likely fix,
  not built, is candidate a of #1084 (`src/browser/settle-client-references.ts` on
  `experiment/vt-idle-transition`): settle the client references a payload names
  before its first commit.
- What a view transition does with a fallback. On a route with `loading()` and
  `transition()` whose loaders take longer than about 320 ms, React's own retry of the
  route's boundary commits while the fallback is still up, that commit starts a view
  transition, and the content lands about 250 ms after its data (#1078, #1084). No
  router hand-over is involved, so none of the invariants sees it.

- A fallback the content puts up itself: an app's `use()` or a `React.lazy` in a route's
  content shows the route's (or the loader boundary's) fallback without the router
  suspending React on anything. Counted (`unattributedFallbacks`), not reported.
- A remount below a segment's outlet has no mount record of its own (see I4 above). The
  cases use an instance marker in the fixture for that.
- Boundaries an app creates itself (`<Suspense>` in a page) are the app's. The audit
  covers the router's two boundary components and the `useLoader` read.
- A test file that does not call `useFixture()` has no guard, HMR projects are recorded
  and not enforced (they edit source under a running page), and a page from a manual
  `browser.newContext()` is covered only once the test calls `guardContext(context)`.
