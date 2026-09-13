# Client URL Groups: Optimistic Destination by Default

Status: shipped in 0.13.0 (phase one, PR #850) and the group-stable segment (phase two, below). Successor to the "Implemented Loading and Pending
Scope" section of [client-urls-instant-navigation.md](./client-urls-instant-navigation.md),
which records the shipped contract this design replaces. Public contract today:
[Client URL Routes](../client-urls.md).

## The problem, from the consumer's seat

`clientUrls()` exists so that navigation inside a group feels instant. Today it
is instant only when the destination declares `loading()`: then the skeleton
appears before any response. Without `loading()`, the current page stays on
screen with `useOutlet().pending === true` until the canonical response
commits. Pinned by the slow-middleware suites
(`e2e/client-urls-slow.test.ts`, `tests/cloudflare-basic/e2e/client-urls-slow.test.ts`):
behind a 5 s middleware, A -> B shows A for 5 s, then B with its data.

The group already ships every route's component to the browser and already
matches the destination locally. The only thing it withholds is rendering the
matched component before the data arrives. This design makes that the default:
on a cross-route navigation inside a group, the destination component renders
immediately; its loader reads suspend until the canonical commit; `loading()`
becomes the route-level boundary around that render instead of the only way
to present anything early.

Decisions taken with the maintainer (2026-09-12):

- No per-route opt-out. A destination whose shell must not render before
  authorization belongs in `urls()`, not in a group. `clientUrls()` means
  instant.
- Hard loads are unchanged. Document requests still await middleware and
  `loader(Def, { ssr: false })` before the shell streams. Only navigations
  become instant.
- App-level state waits for the server. History, the URL bar, `useNavigation`,
  `useLinkStatus`, and any route hook read from chrome outside the group
  commit only when the canonical response lands. This is how the browser
  learns the server did not redirect or reject.
- The optimistic subtree sees its own route. Inside the rendered destination,
  `useParams` / `useSearchParams` / `usePathname` reflect the destination,
  because a component rendered for `/items/:itemId` with the origin's params
  is incoherent. The values come from the local trie match, are scoped to the
  optimistic branch by a context provider, and are discarded with the branch
  on redirect or error, so nothing leaks into app state.

## What the browser shows, before and after

| Navigation inside a group                                      | Today                                                                      | With this design                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Cross-route, destination declares `loading()`                  | destination `loading()`                                                    | destination component; `loading()` is its Suspense fallback while a read suspends   |
| Cross-route, destination has inline `<Suspense>` at read sites | current page held, `pending=true`                                          | destination chrome at once, skeletons at the reads                                  |
| Cross-route, destination has no boundary of any kind           | current page held, `pending=true`                                          | current page held, `pending=true` (unchanged; see "Graceful degradation")           |
| Same-route param/search nav                                    | current content held, `pending=true`, `transition()` opt-in for param navs | held for every group route: the group-keyed segment reconciles in place (phase two) |
| Fully prefetched click                                         | commits from cache with no fallback frame                                  | unchanged; the optimistic branch is replaced by the commit in the same beat         |
| Middleware or loader redirect / error                          | optimistic branch discarded at commit                                      | unchanged                                                                           |
| Intercept target                                               | local presentation declined                                                | unchanged                                                                           |
| Hard load                                                      | shell after middleware and `ssr:false` loaders                             | unchanged                                                                           |

The same-route row is deliberately untouched: held data and `revalidate()`
predicates already keep that case content-stable, and re-rendering the
component with pending loaders would replace held content with skeletons,
which is the flash the hold exists to prevent.

## Mechanics

Everything below reuses a mechanism that already exists. File references are
to the current tree.

### 1. The destination's loaders suspend instead of throwing

`useLoader` throws only when a loader is absent from context
(`src/use-loader.tsx:571`). When the nearest `OutletContext` carries a pending
promise for that loader in `loaderStreams`, the hook already suspends on it
(`src/use-loader.tsx:204-210`, `use(walk.pendingStream)`); that is the shipped
streaming-loader lane. `OutletProvider` (`src/outlet-provider.tsx`) accepts
`loaderStreams` directly.

So the optimistic branch is an `OutletProvider` whose `loaderStreams` maps each
of the destination record's `loaderIds` (already in the projected definition,
`ClientUrlRouteRecord.loaderIds`) to a promise that stays pending for the life
of the branch. Nothing resolves it: the canonical commit mounts the
destination's own segment with real data and unmounts the branch. Loaders the
destination reads from outer server layouts (chrome loaders above the mount)
are found by the existing parent walk (`src/use-loader.tsx:154-192`), because
the branch's provider chains to the origin segment's providers, which share
those outer layouts.

### 2. Route identity is scoped to the branch

`useParams`, `useSearchParams`, and `usePathname` read the event controller
through `NavigationStoreContext` (`src/browser/react/use-params.ts:45`,
`use-pathname.ts:19`, `use-search-params.ts`). Those stay as they are for the
committed tree. The change is one context, `OptimisticLocationContext`,
consulted first by those three hooks: when a provider is present, the hook
returns the provider's value; otherwise it falls through to the controller.
`ClientUrlsRoot` provides it around the optimistic branch with the values from
the local match: `match.params` from the definition trie, the target URL's
pathname and search from the intent. `useMount` is unchanged: the mount is the
include prefix and is the same for every route of the group.

The intent (`src/client-urls/navigation.ts`, `ClientUrlNavigationIntent`) grows
from `{ routeId }` to `{ routeId, params, url }`. `beginClientUrlNavigation`
already has all three in hand.

### 3. Two updates at navigation start: urgent pending, transitional content

Today `beginClientUrlNavigation` sets the intent urgently and `ClientUrlsRoot`
swaps content in the same render. The new root separates them:

- `setIntent(intent)` stays urgent so `useOutlet().pending` flips at once for
  chrome (`aria-busy`, dimming).
- The content swap to the destination component happens inside
  `startTransition`. If the destination render suspends with no boundary of
  its own, React keeps the previous content visible for the duration of the
  transition; that is the "no boundary" row above and it is exactly today's
  behavior. If the destination has `loading()`, the root wraps the component
  in `<Suspense fallback={route.loading}>` and the skeleton shows at once. If
  the component has inline boundaries at its reads, its chrome shows at once.

The clear path is unchanged: `clear()` already runs inside `startTransition`
so the optimistic presentation entangles with the held canonical commit
(`src/client-urls/navigation.ts`, comment above `clear`).

### 4. Commit: the group-keyed segment reconciles in place (phase two)

Each projected route is still its own server segment
(`server-projection.ts` builds one `path()` per record), but every route of
one group mount carries the same `clientGroup` key — the include's URL prefix,
stamped through `PathOptions.clientGroup` (internal) onto the entry
(`urls/path-helper.ts`), the resolved segment (`segment-resolution/fresh.ts`,
`revalidation.ts`), and the segment cache codec. `renderSegments` keys those
segments by `cg:<group>` instead of `id-params` and gives them one wrapper
shape (an `OutletProvider` with a `StreamedLoaderErrorBoundary`, never a
`LoaderBoundary` or `RouteContentWrapper`; `loading()` is the `Suspense`
inside `ClientUrlsRoot`). `ClientUrlsRoot` itself renders an identical wrapper
chain in the optimistic and the canonical state, only prop values change.

So at commit React reconciles the destination's segment into the position the
origin's segment held, the same `ClientUrlsRoot` instance receives the new
`routeId`, and the optimistically rendered component keeps its instance: local
state entered during the window survives, effects run once. The commit rides
the transition lane (`partial-update.ts`, `optimisticPresented`), so a read
that still suspends holds the presented content instead of flashing a
fallback.

Scar from building this: anything that used to be reset by the per-route
remount now has to reset on its own. `StreamedLoaderErrorBoundary` is a class
component holding the caught marker (redirect, notFound, error fallback); as
a surviving instance it kept rendering `LoaderRedirect` for `/legacy` after
the redirect had already landed on `/state`, so the target never rendered
(also the vite-rsc-demo "moved product redirects" flakes). It now takes a
`resetKey` (`id-params`, the old remount cadence) and clears the marker in
`getDerivedStateFromProps` when it changes. Audit the same way before adding
any other stateful wrapper to the group route chain.

Consequence beyond the optimistic case: same-route param navigations inside a
group reconcile too (the key is param-agnostic by construction, since
different routes have different params), and the same-structure transition
commit holds the previous content until the new data lands. `transition()` in
a group is therefore the view-transition animation opt-in, not the hold.
Server-side semantics are untouched: `loading()` still drives PPR masking and
SSR, only the client tree shape for group routes changed.

### 5. Security boundary, reworded

The current note (`docs/why-rango.md:418`, `docs/client-urls.md` "Security
boundary") says the loading branch must not reveal protected data. With the
component rendering early, the same statement holds for a stronger reason:
the branch has no data at all, every read suspends. What it can reveal is
the destination's shell. A group is the wrong home for a route whose shell is
itself sensitive; that route is a `urls()` route. The note changes from "omit
optimistic loading for that route" to "define that route in `urls()`".

## View transitions and startTransition

Two swaps now happen per cross-route navigation: the optimistic swap at
navigation start and the canonical swap at commit. The user should perceive
one.

- **The optimistic swap is the animated one.** It runs in a transition lane
  (`useDeferredValue` on the intent inside `ClientUrlsRoot`, see mechanics 3),
  which is the lane React 19.3's `<ViewTransition>` animates and the lane the
  content hold needs. Routes in a `transition()` scope therefore get their
  configured enter/exit/update animation at the moment the user clicks, not
  five seconds later. On React 19.2 the lane still gives the hold; there is no
  animation layer, as today.
- **The canonical swap must be visually silent.** With per-route segments the
  commit unmounts the origin segment and mounts the destination's, and the
  `<ViewTransition>` wrappers `renderSegments` places around segment content
  (`src/segment-system.tsx`) would run exit/enter on content that looks
  identical before and after. The commit for a navigation that presented an
  optimistic branch therefore tags itself with a dedicated transition type
  (`addTransitionType("rango-optimistic-commit")`, React 19.3, feature-detected
  like the rest of the view-transition layer), and the router's wrappers map
  that type to `"none"` for enter, exit, and update. A navigation with no
  optimistic branch (server routes, first entry into a group, intercept
  targets) is untagged and animates at commit as today. Whether a branch was
  presented is known at the bridge: `beginClientUrlNavigation` returned a
  presentation.
- **`startTransition` around the commit is unchanged.** The existing
  `fullyPrefetched` / `isSameStructureNav` / `hasTransition` branches in
  `src/browser/partial-update.ts` keep their wrapping; the optimistic branch's
  `clear()` already runs inside `startTransition` so pending drops in the same
  commit as the content. What is new is only the transition type on the tagged
  commits.
- **Consumers' own `document.startViewTransition` calls** around a router
  navigation are unaffected: they observe one DOM change at click (the
  optimistic swap) and a DOM replacement at commit that paints identically.
  The follow-up group-stable segment removes the second DOM replacement
  entirely, which is the cleanest end state for both layers.

## Graceful degradation

The transition-wrapped swap is what makes "default" safe to ship. Components
written for today's contract, with no `loading()` and no inline boundaries,
keep today's behavior: previous content stays, pending flips. Only components
that declare a boundary somewhere see a difference, and the difference is the
one the group was built to deliver.

## Consumer-facing contract changes

- `useLoader` inside a client route component suspends on a not-yet-delivered
  destination loader instead of throwing. Outside a group, and outside the
  optimistic window, nothing changes.
- `useParams` / `useSearchParams` / `usePathname` inside the rendered
  destination reflect the destination during the window. Docs today say
  `useParams` holds the origin params during the optimistic window
  (`docs/client-urls.md` "Navigation authority"); that sentence becomes
  "in chrome outside the branch".
- `loading()` semantics: still the route-level early UI, now as a Suspense
  fallback around the destination component. Existing `loading()` declarations
  keep working with no edit.
- Hook placement guidance in `docs/design/client-urls-hooks-review.md` (status
  readers unmount at click when inside optimistically-swapped content) extends
  to the component itself.

Version: a minor bump. The DSL is unchanged; the runtime contract for three
hooks and `useLoader` inside groups changes.

## Tests

Unit (`src/client-urls/__tests__/client-root.test.tsx`):

- cross-route intent renders the destination component with a pending
  `loaderStreams` entry per `loaderId`; `useLoader` suspends into the
  destination `loading()` when declared;
- with no boundary the previous content remains (assert via `act` inside a
  transition);
- `useParams` / `usePathname` / `useSearchParams` inside the branch return the
  intent values; the same hooks rendered above the root return the committed
  ones;
- same-route intent still holds content (existing test stays green).

E2e, both apps, dev and production, extending the slow-middleware suites:

- A -> B: B's own chrome visible under `IMMEDIATE_MS`, its loader read behind
  an inline `<Suspense>` shows the skeleton, data lands after the middleware,
  URL commits with the data; a `useParams` probe inside B shows B's param
  before the commit while a `usePathname` probe in the nav bar still shows A.
- E without any boundary: current page held, pending true (today's row).
- C -> D loader redirect: D renders immediately, then the landing page.
- Prefetched B -> C: unchanged assertion.
- HMR and the existing `clientUrls vertical slice` suites stay green.

Semantic matrix: no row changes; middleware scope, handler-first ordering, and
PE/JS parity are about the server chain and hard loads, which this leaves
alone.

## Phase two: group-stable segment (shipped)

Mechanics 4 above. Unit pins: `segment-system.test.tsx` "keys clientUrls()
group routes by the group and gives them one wrapper shape";
`client-root.test.tsx` "keeps the optimistic instance across the canonical
commit". E2e: the slow-middleware suites type into B during the window and
assert the value after the commit; the transition suite's plain twin now holds
as well.

## Non-goals

- Same-route navigations: held data and `transition()` already cover them.
- Rendering the destination before the browser has the group at all (first
  entry from a server page remains a server navigation; prefetch covers it).
- Any change to middleware, `ssr: false`, or hard-load behavior.
- A per-route opt-out.
