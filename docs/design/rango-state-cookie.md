# Rango State: Cookie Storage & a Single Invalidation API — Design

If you're about to touch the rango state mechanism — the little value that keys
prefetch caches and gets rotated on mutations — start here. This doc captures a
design decision made before implementation: moving the state's storage from
localStorage to a session cookie, and collapsing the cache-invalidation surface
to a symmetric pair of verbs — `invalidateClientCache()` and
`keepClientCache()` — plus one router option. It records not just what
we decided but the arguments, because several of the "obvious" alternatives
(Vary on the cookie, encrypting the value, a custom response header, separate
client/server functions) look attractive and are wrong in ways worth
remembering. It also carries the hazards earlier drafts of this design walked
straight into — they're called out inline as scar tissue so you don't
rediscover them in production.

Status: **shipped** (PR #560). Cookie storage lives in
`src/browser/rango-state.ts` (+ `src/browser/cookie-name.ts`); the public pair
is `invalidateClientCache()` / `keepClientCache()` (server seat:
`src/server/cookie-store.ts`; client seat: `src/browser/invalidate-client-cache.ts`).
Sections below keep the design narrative and scar-tissue hazards that still
apply; treat pre-implementation "today" language as historical where it
contradicts the as-built model.

## As built (cookie model)

The state is a per-client value of the form `{buildVersion}:{timestamp}`, stored
in a **session cookie** named by the server-resolved name
(`{prefix}_{routerId}`, default prefix `rango-state`) and managed by
`src/browser/rango-state.ts`. An in-memory mirror is a write-through fallback
only when `document.cookie` is unreadable; when the jar is readable, the
per-request cookie read wins (that read is the cross-tab sync channel). Boot
calls `cleanupLegacyStorage()` and drops any leftover `rango-state` /
`rango-state:*` **localStorage** keys from the pre-cookie era (superseded;
see History below).

The client still sends the value as the `X-Rango-State` request header on every
prefetch and navigation fetch, and the server answers with
`Vary: accept, X-Rango-State, X-RSC-Router-Client-Path`. The browser's HTTP
cache therefore keys responses by (URL, state value): rotate the value and
every previously cached response misses cleanly.

Three caches are in play — the state value keys the first two; the third is
invalidated through a different door. The headline draft of this design only
handled the first two and shipped a stale-back-button bug as a result (scar
tissue that still applies):

- the **in-memory prefetch map** (`src/browser/prefetch/cache.ts`), whose
  wildcard and source-scoped keys both embed the state value —
  `rangoState\0/target` and `rangoState\0sourceHref\0/target`;
- the **browser's private HTTP cache**, via the `Vary` mechanism above.
  Prefetch responses carry `Cache-Control: private,
  max-age={prefetchCacheTTL}` (default 300 seconds). Only prefetch responses:
  the header is gated on the `X-Rango-Prefetch` request header plus partial
  plus non-intercept — an ordinary navigation partial carries no
  `Cache-Control` at all;
- the **history segment cache** (`historyCache` in
  `src/browser/navigation-store.ts`), which holds back/forward payloads.
  This one is **not** state-keyed — rotating the state value does nothing to
  it. It is invalidated only by going through the navigation store
  (`clearCacheInternal` / `markCacheAsStaleInternal`). Forget this and your
  "data changed" signal leaves a stale page one Back button away.

Live paths that rotate / clear:

| Trigger                     | Path                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                      | version prefix changes; `initRangoState` mints fresh at boot (`rango-state.ts`, from `rsc-router.tsx`)                                                                    |
| Server action               | `server-action-bridge.ts` → deferred invalidate unless the action called `keepClientCache()`                                                                              |
| `invalidateClientCache()`   | public API (both seats) → rotates cookie / marks caches stale; replaces the removed `useClientCache().clear()` hook                                                       |
| Cross-tab broadcast receipt | a sibling tab's `BroadcastChannel` "invalidate" message → `markCacheAsStaleInternal`, gated on shared segment IDs                                                         |
| External cookie rotation    | sibling tab / server `Set-Cookie` / cookie clear detected on the next `getRangoState()` read → external-rotation observer                                                 |
| Dev HMR                     | a version change → `navigationBridge.updateVersion()` → `store.clearHistoryCache()`                                                                                       |

Note that `clearPrefetchCache()` is the function that clears the in-memory map,
discards in-flight prefetches, and calls `invalidateRangoState()`. The
navigation-store functions wrap it and add the history-cache handling and the
cross-tab broadcast on top.

One property to internalize: the timestamp makes every client's value
effectively unique, so `Vary: X-Rango-State` only ever helps each client's
_private_ browser cache. A shared cache (CDN) would either refuse these
responses outright — most CDNs treat a `Vary` on a custom request header as
uncacheable, and these responses are `Cache-Control: private` anyway — or, if
it ignored `Vary`, serve one client's variant to everyone. There is no
cross-client-hit story here. The load-bearing protection against a shared cache
mishandling this is `Cache-Control: private` plus the never-a-shared-cache-key
guardrail below, not `Vary` semantics.

### History / superseded

Pre-cookie storage was **localStorage** under `rango-state:{routerId}` (legacy
fallback `rango-state`). That model is gone; only the one-shot cleanup at
`initRangoState` remains. The public `useClientCache()` hook was removed in
favor of `invalidateClientCache()` / `keepClientCache()`.

## The gaps this design closes

**Lifecycle gap: the cache key outlives the session it caches for.** This is
the lead reason for the cookie, and it's about what users and operators expect
of cookies. Clear your cookies today — sign-out flows that wipe the jar,
"clear cookies on close" browser settings, a manual clear — and the session
dies but the rango state in localStorage survives. The browser's HTTP cache
still holds responses from the signed-in session, keyed by (URL, old state),
and the old state is still being sent: those signed-in payloads keep getting
served for up to `prefetchCacheTTL` after the session is gone. Storing the
state in a session cookie couples the two lifecycles: clearing cookies takes
the state with it, the next read mints fresh, and every previously cached
response becomes unreachable in one stroke. The cached bytes still sit in the
browser's HTTP cache, but nothing can key into them again.

Be precise about what this half solves: it covers the **clearing** direction
(sign-out by cookie wipe, session end). The **mutation** direction — you sign
in, you add an item to a product list, and the next product-details click must
show the new data — is not solved by where the state is stored. That's the job
of rotation: automatic for server actions (the bridge already does it), and via
the API below for everything else.

**Mutation gap: non-action mutations have no invalidation entry point.** A
plain `fetch()` to an API route, a third-party SDK call, a websocket "data
changed" push, a login handler — none of these are server actions, so nothing
rotates the state or touches the caches. Today there _is_ a client-side API
(`useClientCache().clear()`, `src/browser/react/use-client-cache.ts`), but it
is a React hook — unusable from a module-level socket callback or any
non-component code — and there is no server-side counterpart at all. This
design replaces the hook with one function callable from both seats.

**Explicit non-goal: push invalidation.** Everything here is pull-based. The
server's only mechanism is a per-response `Set-Cookie`, so it rotates exactly
the one client that receives that response, on receipt. There is no shared
server-side epoch, so a _different_ client does not "find out" about a
mutation on its next request — its caches rotate only if your app code calls
the helper during _its_ request too. "Webhook fired, invalidate every client
now" is not solvable with cookies or headers; it needs the shared epoch under
Deferred.

## The core split: cookie as storage, header as transport

The decision that everything else hangs off: the cookie **replaces
localStorage as the storage location**, and the `X-Rango-State` request header
**stays the cache-keying transport**. The `Vary` header and the prefetch key
shapes do not change.

Why not just `Vary: Cookie`? Because it varies on the _entire_ `Cookie` header:
any unrelated cookie churn — session refresh, analytics, consent banner —
busts the cache, and shared caches treat `Vary: Cookie` as effectively
uncacheable. The header must stay the precise, single-value cache key.

Why a cookie at all, instead of a custom response header the client intercepts?
Four reasons, in order of weight:

- **Session-lifecycle coupling**, as above. No header scheme gives you
  "clearing cookies resets the cache key" — only living in the jar does.
- The server rotates state with the cookie API we already ship —
  `cookies().set(...)` from `src/server/cookie-store.ts` — and the browser
  applies `Set-Cookie` on a same-origin fetch response automatically. That
  includes fetches the router never sees: a plain `fetch()` your app code makes
  to a response route still lands the rotation in the jar, where the router's
  next read picks it up. A custom response header on that same response would
  be invisible — nothing router-side handles the response. (The
  auto-application has a precondition: the request's credentials mode must not
  be `omit`. It holds today because the navigation, action, and prefetch
  fetches pass no `credentials` option — `navigation-client.ts:209`,
  `prefetch/fetch.ts:151` — so they default to `same-origin`. That default is
  now load-bearing; see the invariant in the Security model.)
- It covers **non-cacheable** document responses (POST results, redirects,
  `no-store`/`private` GETs), which a custom RSC-response-header scheme would
  not. This does _not_ mean Set-Cookie on cacheable document HTML — that's
  forbidden; see the Written-by row and finding #3.
- Cross-tab state-value sync gets simpler: a per-request `document.cookie` read
  replaces the cached-value-plus-`storage`-event machinery in
  `rango-state.ts`. (The richer cross-tab invalidation — the `BroadcastChannel`
  in `navigation-store.ts` — is untouched and stays; see the cross-tab
  section.)

A useful side effect of the split: network-level cookie stripping (corporate
TLS-intercepting proxies) cannot break the client-side mechanism, because the
cookie never needs to reach the server — `document.cookie` is local. The only
thing such a proxy neuters is server-driven rotation, which degrades to the
bounded staleness described under Degradation.

## The API: two verbs, one noun

Two exported functions — `invalidateClientCache()` and its action-side
counterpart `keepClientCache()` — and one router option. Everything else —
cookie name resolution, value format, rotation mechanics, the directive
transport — stays internal. Earlier drafts had three names for the invalidate
half alone (`useClientCache().clear()`, a non-React `clearClientCache()`, a
server `invalidateClientCache()`); the near-identical client/server pair was a
guaranteed auto-import mixup, and three names for one consumer intent is
exactly the API complexity we're trying not to ship. The surviving surface is
one noun (the client's caches) with two verbs: force a miss, or keep them
warm.

### `invalidateClientCache()`

Exported from the root entry only, with the implementation selected by export
conditions — the same mechanism `cookies()` already uses, except the default
build gets a real implementation instead of a throwing stub:

- **`react-server` condition** (`src/index.rsc.ts`): the server
  implementation. Writes a fresh rotated `Set-Cookie` for the responding
  client.
- **`default` condition** (`src/index.ts`): the client implementation. Goes
  through the navigation store and invalidates immediately. If `document` is
  undefined — the SSR pass of a client component also resolves `default` — it
  no-ops with a dev-mode warning rather than throwing, because a render-time
  call during SSR should not take down the page.

The contract, in one sentence: **calling it anywhere makes the current client
behave as if a server action had just completed.** Import it from
`@rangojs/router` in a handler, a middleware, a server component, a client
component, or a plain browser module, and the environment-appropriate
mechanics fire:

| Seat                                             | Mechanism                                                                                                                                                                 | Timing                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Client component / browser code                  | `store.markCacheAsStaleAndBroadcast()` — history cache marked stale (SWR), prefetch map flushed, in-flight prefetches aborted, state rotated, `BroadcastChannel` notified | immediate                                                                                                                      |
| Handler / middleware / action / server component | rotated `Set-Cookie` on the response                                                                                                                                      | on receipt; caches miss from the client's next fetch onward, history cache marked stale by the jar-divergence observer (below) |
| SSR render pass                                  | no-op, dev warning                                                                                                                                                        | —                                                                                                                              |

```ts
// Client seat: a mutation the router can't see.
import { invalidateClientCache } from "@rangojs/router";

socket.on("catalog-updated", () => invalidateClientCache());
```

```ts
// Server seat: a non-action handler that mutates.
import { invalidateClientCache } from "@rangojs/router";

export const handler = async (ctx) => {
  await db.orders.create(/* ... */);
  invalidateClientCache();
  return { ok: true };
};
```

**Client seat details.** It wraps the store layer, not `clearPrefetchCache()`
directly — `clearPrefetchCache()` alone leaves the history segment cache
untouched and broadcasts nothing, which is the stale-Back-button bug from the
three-caches section. It uses the **mark-stale (SWR)** path, not the hard-clear
path the deleted hook used: that is what makes the "as if a server action
completed" sentence literally true (`server-action-bridge.ts` uses the same
`markCacheAsStaleAndBroadcast()`), and it is the gentler behavior for the
websocket/REST cases this exists for — Back renders the cached entry instantly
and revalidates, instead of refetching with a loading state. This is a
recorded behavior delta versus `useClientCache().clear()`; since the hook is
removed in the same change, no published contract survives to be broken.

The client implementation reaches the store through a module-level handle
registered at boot. One trap to step around: `navigation-store.ts` already
exports an `initNavigationStore()`/`getNavigationStore()` singleton pair
(`navigation-store.ts:812-833`) that looks purpose-built for this — **it is
dead in real apps**. The boot path (`rsc-router.tsx:170`) calls
`createNavigationStore()` directly, so `getNavigationStore()` throws in every
running app; its only callers are unit tests. Either make boot register
through `initNavigationStore` (reconciling the test-only singleton) or use a
fresh handle module — but do not reach for `getNavigationStore()` as-is. If
the function is called before the store is registered (pre-boot), it falls
back to `clearPrefetchCache()` alone. Be precise about what that fallback
covers: it clears the in-memory prefetch map, but the `invalidateRangoState()`
rotation inside `clearPrefetchCache()` (`cache.ts:362`) is **not durable**
pre-boot — the cookie name is still unresolved (it arrives in payload metadata,
consumed at boot), and boot's keep-vs-mint (`rango-state.ts:73-92`) overwrites
whatever pre-boot wrote before any fetch consumes it. So the in-memory map
clear is the only lasting effect, and that is enough at that point: there is no
history cache to mark and no sibling state worth broadcasting yet. If a
pre-boot rotation ever must survive, queue the intent and apply it once
`initRangoState` has resolved the name.

**Server seat details.** It reuses the same cache-context guard `cookies()` and
`headers()` use: `assertNotInsideCacheContext()` in
`src/server/cookie-store.ts`, which combines the `INSIDE_CACHE_EXEC` taint
(`src/cache/taint.ts`) with `isInsideCacheScope()`. (That's the same pair
`setStatus` applies, but `setStatus` reaches them through a closure private to
`createRequestContext`; a standalone root-entry helper must use the
`cookie-store.ts` entry point, not those.) Note `isInsideCacheScope()` returns
false inside loaders, so — exactly like `cookies().set()` — rotation from a
loader running inside a cached document is permitted; that's intentional,
loaders are the dynamic holes of a cached document.

Two places where it must _not_ simply mirror `cookies()`, both **[resolve
before implementing]**:

- **Idempotency is not inherited — implement it.** `cookies().set()` reaches
  `ctx.setCookie()`, which does `headers.append("Set-Cookie", …)`
  (`request-context.ts:732`) with no name-based dedup; two calls emit two
  `Set-Cookie` headers (and, with a per-call `Date.now()`, two distinct
  timestamps). The "one `Set-Cookie`, no matter how many calls" guarantee in the
  table below is therefore not free — mint the rotated value once behind a
  request-scoped "already rotated" flag and write the header once (the same
  request-scoped-flag mechanism `keepClientCache()` already uses). Pin it with a
  twice-in-one-request unit test.
- **Out of request scope it must no-op, not throw.** The literal `cookies()`
  entry begins with `getRequestContext()`, which _throws_ when there is no
  request context (`request-context.ts:431`). To stay inert when called outside
  a request, the helper must read through the non-throwing
  `_getRequestContext()` (`request-context.ts:444`) and apply
  `assertNotInsideCacheContext()` only when a context is present. Document this
  the same way for both server helpers (`keepClientCache()` already specifies the
  inert no-op; the `invalidateClientCache()` semantics table below is silent on
  the out-of-request case).

Semantics consumers must understand — the server seat is **per-client and
lazy**:

| Scenario                                               | Effect                                                                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action handler calls it                                | Redundant but harmless. Actions already rotate the caller's state client-side (`server-action-bridge.ts`); the extra `Set-Cookie` is one duplicate rotation, costing at most one extra miss. |
| Non-action handler (e.g. response-route POST) calls it | The intended use. The responding client rotates on receipt of the `Set-Cookie`; its history cache is marked stale by the jar-divergence observer at its next read.                           |
| Other clients with warm caches                         | Unaffected. Rotating them requires your app code to call it on _their_ requests too — there is no shared epoch (see Deferred).                                                               |
| A client served entirely from its own browser cache    | Unaffected until something forces a round trip (bounded by `prefetchCacheTTL`).                                                                                                              |
| Called twice in one request                            | One `Set-Cookie`, one rotation.                                                                                                                                                              |

**Why one name with two mechanics is safe.** The unifying contract is the
outcome — "this client's caches miss from now on" — and the timing difference
(immediate vs. on-receipt) is inherent to the seat, not an API wart: a server
cannot reach into a browser's memory mid-request, and a browser doesn't need a
cookie round-trip to clear its own store. An `invalidateClientCache()` snippet
moved between seats keeps its meaning. (That portability is specific to
`invalidateClientCache()`, which is a real function in both export conditions;
its sibling `keepClientCache()` is server-only and no-ops on the client, so the
same move does not round-trip — see its section.) The doc table above is the
whole story a consumer needs.

### `keepClientCache()` — the action-side counterpart

Server actions invalidate automatically — that stays the default, and it is
the right default. But "every action mutates route-visible data" is a
heuristic, and some hot actions falsify it: a debounced draft autosave, an
analytics event, a save that turns out to be a no-op. Each of those currently
pays the full price — prefetch map wiped, state rotated (busting the Vary-keyed
HTTP cache), sibling tabs broadcast at, and a revalidation refetch of the
current route. `keepClientCache()` is the server-side directive that says:
this action changed nothing a route renders; leave the client's key and caches
alone.

```ts
import { keepClientCache } from "@rangojs/router";

export async function saveDraft(formData: FormData) {
  "use server";
  const changed = await drafts.persist(formData);
  if (!changed) keepClientCache();
  return { saved: true };
}
```

Per-response, not per-action-definition, deliberately: only the execution
knows whether anything changed — the no-op save above is the canonical case,
and a static "this action never invalidates" registration could not express
it. Mechanics mirror its sibling: exported from the root entry; the
`react-server` implementation sets a request-scoped flag that becomes an
internal response header the bridge reads; the `default` condition is a no-op
with a dev warning (there is no client seat — there is nothing to suppress
from the client side); idempotent within a request (one header regardless of
call count). Like the invalidate server seat, the inert-outside-an-action
behavior requires reading request scope through the non-throwing
`_getRequestContext()`, not the throwing `getRequestContext()`.

Two safety properties for the internal directive header **[resolve before
implementing]**: name it explicitly (so the strip site is unambiguous), and
ensure it is **stripped before the response reaches the client and never
cached**. It is the mirror image of Finding #3 — if this header leaked into
`document-cache.ts` or an L2 store and were replayed, it would _suppress_
invalidation for every replayed client. The same response-store chokepoint that
strips the rango-state `Set-Cookie` should drop this header too.

**The bridge change this forces — and why it is an improvement anyway.** Today
the bridge invalidates _eagerly at action start_
(`server-action-bridge.ts:164`), before any response exists — a response-borne
directive would arrive after the prefetch map is wiped and the state rotated,
able to rescue only the revalidation refetch. An earlier draft concluded from
this that a server-side opt-out was impossible and the knob had to live
client-side. The actual conclusion: the eager _clear_ must become an eager
**fence**, with the decision deferred to the response.

- **At action start (fence):** suspend prefetch-cache consumption and treat
  popstate reads as stale-while-revalidate, without persisting any flags.
  Nothing is wiped, rotated, or broadcast. The fence is refcounted across
  concurrent actions; each action's response decrements its own reference
  exactly once, and the fence lifts only when the count reaches zero. Two things
  the eager clear gave us for free and the fence must reproduce deliberately
  **[resolve before implementing]**:
  - _Bypass the HTTP cache during flight._ Today's eager clear rotates
    `X-Rango-State` (`clearPrefetchCache()` → `invalidateRangoState()`,
    `cache.ts:362`), so a navigation to a previously-prefetched URL during
    flight sends the new value and **misses** the Vary-keyed browser HTTP-cache
    entry. The fence rotates nothing, so that same navigation sends the _old_
    value and can be served the stale pre-mutation prefetched bytes straight
    from the HTTP cache (`navigation-client.ts:209-212` sends the header with no
    `cache:` option, and nothing else busts it). "Navigations during flight
    fetch fresh" is therefore true only for the in-memory map; to hold for the
    HTTP cache too, the fence must force navigation/prefetch fetches during
    flight to bypass it (`cache: "no-store"` or a one-shot busting param), or
    rotate on fence-entry and restore the prior value on the `keepClientCache()`
    decision.
  - _Own an ephemeral popstate-stale signal._ The popstate restore path reads
    staleness only from the persisted `entry[2]` bit
    (`navigation-bridge.ts:453`, SWR gated at `:515`). The fence persists no
    flag, so a popstate under an active fence would compute `isStale = false`
    and serve cache as fresh — the stale-Back-button class this doc warns
    about. The popstate `isStale` must OR in a `fenceActive()` predicate
    (`cached.stale || fenceActive()`), and the SWR revalidation must fire when
    `fenceActive()` even if `entry[2]` is false. `navigation-bridge.ts` is
    therefore part of the implementation surface (added below).
- **At response, no directive:** perform today's full invalidation — mark
  history stale, clear the prefetch map, rotate the state, broadcast — then
  the usual revalidation refetch. Same end state as today, shifted to response
  time. This reproduces the existing post-commit broadcast (`:656`); see the
  race note below for why "today" already broadcasts twice.
- **At response, directive present:** drop this action's fence reference (the
  fence lifts only when the count hits zero). No rotation, no wipe, no
  broadcast, no revalidation refetch _from this action_. The jar is untouched,
  so sibling tabs' divergence observers correctly see nothing. The decision is
  per-response and independent of fence _lifetime_: a concurrent directive-free
  action still performs its own full invalidation, which overrides a sibling's
  keep — see the Case table.
  - _Two repair refetches are exempt from "no revalidation refetch."_ The
    `hmr-missing` and `consolidation-needed` terminals refetch **ungated on
    keepCache**: they repair a missing/partial segment tree rather than
    revalidate, and a keep action that resolves last must discharge a
    directive-free sibling's consolidation duty (gating would break the
    keep-overlapping-directive-free row). The accepted edge: an _all-keep_
    concurrent batch still consolidates here with no directive-free sibling, a
    refetch the directives nominally said to skip. It is bounded (one repair),
    never serves stale UI, and is preferred over dropping a real sibling's
    consolidation.
  - _End-state delta on three rare terminals._ For `navigated-away`
    (same-key), `hmr-missing`, and `consolidation-needed`, the awaited
    `refetchRoute` caches fresh segments and the latched `finalizeAction` then
    re-marks them stale, where main left those entries fresh. The cost is at
    most one redundant background SWR refetch on the next popstate to a
    rarely-hit entry — never a stale view. The single-latch shape structurally
    forces this ordering; it is accepted over reordering the fence release
    around each awaited refetch.

**Every terminal, not just the happy path.** Main's eager clear ran for _every_
action at start, so the guarantee was "however an action ends, it has already
invalidated." Deferring to the response must preserve that across _all_ exits —
not only the `normal` and `navigated-away` terminals, but redirect (both the
Flight `metadata.redirect` and the `X-RSC-Redirect` simple-redirect, whose
Flight stream never settles so a finally after the await never runs), the
`X-RSC-Reload` version-mismatch terminal (`handleReloadHeader` navigates away
via the same never-settling promise — the third terminal whose finally never
runs, so finalizeAction must be called in its `onReload` callback), error,
abort, the intercept `navigated-away` branch, and `concurrent-skip` /
`consolidation`. Implement it as **one latched finalization** — invalidate once
unless keep, then release the fence — invoked from the action's `finally` _and_
explicitly before each never-settling navigate-away return (simple-redirect,
router-id mismatch, version-mismatch reload). A per-branch gate at
each terminal (the shape that first shipped) silently drops the redirect/error/
abort/intercept/concurrent paths and leaks the fence on the never-settling
terminals; the single latch is the only shape that holds the invariant.

The deferral is not merely neutral — it removes a transient pre-commit refresh.
Be accurate about today's behavior, because it broadcasts _twice_, not once:
eagerly at action start (`server-action-bridge.ts:164`, pre-commit) **and**
again at the response in every terminal path (`:656` normal, `:546`/`:559`
navigated-away, `:571`/`:592`). So a sibling sharing a segment can refetch off
the start broadcast, hit the server before the mutation commits, and briefly
hold pre-commit data — but today's second, post-commit broadcast re-marks it
stale, so it self-heals on its next access. The window actually bites only a
`crossTabAutoRefresh`-enabled sibling, which can fire an immediate refresh off
the start broadcast that races the commit. Deferring the whole invalidation to
the response eliminates that pre-commit window; it does **not** add the only
post-commit signal — that signal already exists at `:656`, and the response-time
invalidation must reproduce its end state (re-mark stale _after_ the fresh
segments are cached, then rotate and broadcast). In-flight prefetches, aborted
today, may instead complete under the fence; they are kept or discarded by the
response decision and never served before it.

| Case                                                                | Behavior                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action without the directive                                        | full invalidation at response — same end state as today                                                                                                                                                                                                                                                                                                                      |
| Action calls `keepClientCache()`                                    | no rotation, no wipe, no broadcast, no _revalidation_ refetch; this action's fence reference is dropped. Exception: the `hmr-missing`/`consolidation-needed` _repair_ refetches stay ungated on keep (they fix a missing/partial tree, and a keep action resolving last must discharge a directive-free sibling's consolidation) — see the keep bullet under fence-and-defer |
| Action calls both `keepClientCache()` and `invalidateClientCache()` | invalidation wins, with no special-casing: the directive suppresses only the _automatic_ invalidation, while the explicit `Set-Cookie` still lands in the jar and the divergence observer does the rest                                                                                                                                                                      |
| `keepClientCache()` action overlapping a directive-free action      | the directive-free action's full invalidation still fires at _its_ response; keep protects against this action's own automatic invalidation, not against a concurrent real mutation. The keep row's "no rotation/wipe/broadcast" is a per-action guarantee, not a global one                                                                                                 |
| `keepClientCache()` outside an action request                       | inert no-op (dev warning): there is no automatic invalidation to suppress                                                                                                                                                                                                                                                                                                    |
| Progressive-enhancement form post (no JS)                           | inert: the response is a fresh full document; no client cache machinery is in play                                                                                                                                                                                                                                                                                           |

This touches action execution semantics, so it is **semantic-matrix
territory**: the matrix must stay green for directive-free actions (the
timing shift must be observationally equivalent), and new rows must pin the
directive cases
(`pnpm --filter @rangojs/router exec playwright test semantic-matrix`).

### `useClientCache()` is removed

`useClientCache()` and its `ClientCacheControls` type are deleted, not
deprecated — the pre-release API-hygiene rule (no transitional public API
before first stable external adoption) exists for exactly this. The hook is a
single-method wrapper whose one capability is now a one-line import. The same
PR must migrate and update every reference, per the docs-sync rule. Treat a
fresh `grep -rn 'useClientCache\|ClientCacheControls'` as the completeness gate
— the list below is a hand audit, and a hard delete that misses a re-export
breaks the build:

- `tests/vite-rsc-demo/src/handlers/kanban/KanbanErrorBoundary.tsx` (the one
  dogfood usage). It imports `useClientCache` from `@rangojs/router/client`
  alongside `ErrorBoundary`/`useRouter`, whereas `invalidateClientCache()` lives
  on the **root** entry — so this is not an in-place symbol swap: add an
  `import { invalidateClientCache } from "@rangojs/router"` and keep the
  `/client` import for the others;
- `src/client.tsx` exports **and** the separate barrel re-export in
  `src/browser/react/index.ts` (it re-exports `useClientCache` +
  `ClientCacheControls` directly from `./use-client-cache.js`; deleting the
  module without editing this barrel is a dangling export that fails typecheck),
  plus the "not re-exported here" comment in `src/client.rsc.tsx:53`;
- the two stale `useClientCache().clear()` comment references in
  `src/browser/navigation-store.ts:133` and `:140`;
- `skills/hooks/SKILL.md`; `docs/internal/feature-map.md` — drop the hook's
  hooks-table row **and** add `invalidateClientCache`/`keepClientCache` to the
  root (`.`) entry export enumeration plus the `stateCookiePrefix` option (and,
  while touching it, fix the stale "page visibility events" wording for
  `invalidateRangoState` — the real mechanism is the `storage` event);
  `docs/internal/feature-file-map.md` — drop the `use-client-cache.ts` row and
  add `cookie-name.ts` + the new store-handle module; `docs/README.md` —
  register this design doc in the Design Notes hub;
- `src/__tests__/use-client-cache.test.ts` (delete) and
  `src/__tests__/documentation-imports.test.ts`. The latter is not just a
  deletion: it maps documented imports to entry paths (`useClientCache:
"@rangojs/router/client"` today), so it must _gain_ positive entries mapping
  `invalidateClientCache` and `keepClientCache` to `@rangojs/router`, and the
  root `package.json` export must resolve both under the `react-server` and
  `default` conditions — otherwise the new SKILL.md examples fail this very test.

### `stateCookiePrefix` — router option

A router config option, declared alongside `prefetchCacheTTL` in
`src/router/router-options.ts` and delivered to the client over the same
plumbing (`router.ts` → payload metadata in `src/rsc/types.ts` /
`src/rsc/rsc-rendering.ts` → client boot in `src/browser/rsc-router.tsx`):

```ts
/**
 * Prefix for the rango state cookie name. The resolved name is
 * `{prefix}_{sanitizedRouterId}`. Sanitized to cookie-name-safe characters
 * ([A-Za-z0-9_-]); an empty result falls back to the default.
 *
 * @default "rango-state"
 */
stateCookiePrefix?: string;
```

Why a prefix and not a full-name override: the `_{sanitizedRouterId}` suffix is
what keeps sibling apps on one origin from clobbering each other; a full-name
override would silently break multi-app namespacing. The prefix covers the real
use cases — cookie naming policies, consent-manager classification lists that
pattern-match names, avoiding a collision with an existing `rango-state`
cookie — without opening that hole.

One sharp edge in the `{prefix}_{sanitizedRouterId}` join **[resolve before
implementing]**: `_` is the separator _and_ a legal character in both the prefix
charset (`[A-Za-z0-9_-]`) and real router ids — the counter fallback is literally
`router_{n}` (`router.ts:210`). So the name space is not injective: prefix
`rango-state` + id `router_0` and prefix `rango-state_router` + id `0` both
resolve to `rango-state_router_0`, silently sharing a cache key and defeating the
namespacing the suffix exists for. Either pick a separator excluded from the
sanitization charset, or sanitize both sides and document the resolved name as
`sanitize(prefix) + SEP + sanitize(routerId)` with `SEP` reserved. (routerId is
already sanitized into `sanitizedRouterId`, so a non-token-char id is not the
concern here — the same-string collision is.)

A precision the localStorage scheme hides: server-side, a router _always_ has an
id. `routerId = userProvidedId ?? injectedId ?? router_N`
(`src/router.ts:209-210`) falls back to a global counter, so the resolved
cookie name is always `{prefix}_{sanitizedRouterId}` (e.g.
`rango-state_router_0` for a single-app counter-id router). The bare `{prefix}`
form exists only as a _client-side_ fallback for the edge case where a payload
arrives without `metadata.routerId`. (One caveat the counter inherits: in a
non-Vite environment without the injected `$$id`, the counter is import-order
dependent — `router.ts:205-208` — so a cookie name baked from it is too. Vite
builds inject a stable hash, so this only bites exotic setups.)

Name resolution happens once, server-side, at router init: the router composes
the final sanitized name and ships the resolved string in payload metadata. The
client does zero composition — it reads the resolved name from metadata. The
server helper reads the same resolved name off the router. One resolution
point, so the two cookie writers can't drift.

## Cookie contract

| Property   | Value                                                                                                                              | Why                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name       | `{prefix}_{sanitizedRouterId}`, default prefix `rango-state`; client-side fallback `{prefix}` only when metadata lacks a routerId  | Mirrors the localStorage key scheme; `:` is not a legal RFC 6265 token character, hence `_`; the routerId suffix namespaces sibling apps                                                                                              |
| Lifetime   | Session (no `Max-Age` / `Expires`)                                                                                                 | State never needs to outlive the caches it keys (default `max-age=300`); the lifecycle-coupling rationale above; sidesteps Safari ITP (Intelligent Tracking Prevention); cleanest consent class                                       |
| Value      | `encodeURIComponent(version) + ":" + timestamp`                                                                                    | Encodes only the build-derived version (which is arbitrary); the `:` separator and numeric timestamp stay raw, so the `{version}:{timestamp}` shape survives on the wire — and `:` is legal in a cookie value, so this is well-formed |
| Attributes | `Path=/; SameSite=Lax`, plus `Secure` on https only                                                                                | Path covers the whole app; the rest below                                                                                                                                                                                             |
| Written by | Client (`document.cookie`) at boot and on rotation; server only via `invalidateClientCache()`, and only on non-cacheable responses | No router-authored `Set-Cookie` on cacheable GET document HTML — edge-cached HTML can't carry per-client cookies (finding #3)                                                                                                         |

The reasoning behind the rows people will want to relitigate:

**Session lifetime.** The state keys two cacheable surfaces with a horizon: the
in-memory prefetch map (dies with the page) and HTTP cache entries with a
default 5-minute `max-age`. A persistent cookie would preserve cross-restart
cache hits only inside that window — essentially worthless. Losing the state
early is always safe: a fresh mint differs from any value still keying a live
cache entry, so everything misses cleanly. The only correctness requirement is
that the value not change spuriously mid-session, which a session cookie
trivially satisfies. Session scope is also what makes the lifecycle coupling
work — "delete session cookies on close" resets the state exactly when it
resets the session — and it makes Safari ITP irrelevant (its 7-day cap applies
to JS-written _persistent_ cookies) while keeping the cookie in the most
defensible privacy class: the value embeds a per-client timestamp, which as a
persistent cookie would function as a soft cross-visit identifier and get
flagged in cookie audits. One behavior delta versus localStorage: a browser
restart now mints fresh and goes cold, where localStorage survived restarts.
With a 5-minute `max-age` those entries were cold anyway. Chromium and Firefox
with restore-on-startup enabled commonly keep session cookies across restarts,
so you'll often retain the warm state regardless; Safari does not restore
them — accepted, because the entries were already past their TTL.

**Boot keep-vs-mint.** The "warm across reloads" guarantee depends on the boot
path _keeping_ an existing cookie whose version prefix matches the current
build — today's `initRangoState` behavior (`rango-state.ts:73-83`). If boot
minted fresh on every load, every reload would bust the HTTP cache. This is a
named unit contract below, not an incidental.

**Attributes in full.** `Path=/`, not `Path={basename}`: the routerId suffix
already namespaces sibling apps, so a basename-scoped path would fragment the
contract and add nothing — and path-scoped `document.cookie` visibility is a
footgun. `SameSite=Lax` sends the cookie on top-level navigations, which is all
we need. `Secure` only on https: unconditionally setting `Secure` makes the
`document.cookie` write silently fail on plain-http internal/dev deployments.
No `__Host-`: it mandates `Secure` (and Chrome rejects `__Host-` even on
`http://localhost`, where it accepts a plain `Secure` cookie), so it would
break plain-http dev for no payoff — this is a cache key, not a credential. Not
`HttpOnly`: the client reads and writes it.

**No encryption, no signing.** There is nothing to hide — the build version
already ships to every client in payload metadata, and the timestamp is minted
by the client (or, under server rotation, by the server's own helper) and
carries no secret either way. There is nothing to trust — the server never
parses the value; its only touchpoint is emitting `Vary`, and the cache keyed
on it is the browser's private one, so a tampering user can only mis-key their
own cache. And the client must be able to mint and rotate the value in JS, so
any scheme where the client holds a key is theater: the client (and therefore
any XSS) is the value's legitimate author. The same argument rules out
`HttpOnly`.

**Uniqueness, stated precisely.** The mint is `Date.now()`
(`rango-state.ts:85, 90, 126`) — wall-clock, not monotonic. The property the
design actually needs is only "the new value differs from the current one,"
which holds except for two mints inside the same millisecond or a backward NTP
step landing on a value still keying a live cache entry. The rewrite should add
a one-line guard — `next = max(Date.now(), prev + 1)` — so a same-millisecond
re-rotation is never a silent no-op. Don't claim monotonicity; claim "differs
from current," and enforce it.

That guard is **same-machine only**, and the server seat adds a second mint
site, so there is a gap it does not close **[resolve before implementing]**: the
divergence observer fires only when a jar read _differs_ from the in-memory
mirror, and the value carries no client/server discriminator
(`{version}:{timestamp}`). If a server `Set-Cookie` mints a timestamp equal to
the client's current value (same version, same millisecond — plausible on fast
paths or coarse clocks), the jar value equals the mirror, the observer never
fires, and the history cache is never marked stale despite an intended server
rotation. Close it at the server mint: derive the timestamp from the inbound
`X-Rango-State` header — `timestamp = max(serverNow, clientTimestamp + 1)` — or
embed a server-side discriminator so a server rotation can never collide with the
client's current value. Pin it with an observer unit test where the server value
equals the mirror.

## Cross-tab sync: no regression, strictly stronger

A hard requirement of this design: **none of Rango's cross-tab sync mechanics
may degrade.** Today two channels exist, and they do different jobs:

- the **`storage` event** in `rango-state.ts` (key-filtered per app,
  `rango-state.ts:49`) mirrors the state _value_ into sibling tabs, so their
  next fetch uses the rotated key. It never touches their history caches;
- the **`BroadcastChannel`** in `navigation-store.ts` pushes _invalidation_:
  after an action, sibling tabs sharing a segment mark their history caches
  stale (`navigation-store.ts:405`), with optional auto-refresh. It is gated
  on shared segment IDs — a tab on an unrelated route ignores the message and
  keeps its caches.

Under this design the `storage` event is deleted (no localStorage), and two
mechanisms take its place. The `BroadcastChannel` machinery is untouched.

**Per-request jar read.** The cookie jar is shared across tabs, so reading
`document.cookie` at each fetch _is_ the value sync — same effective timing as
the storage event, because the value was only ever consumed at fetch time.

**The jar-divergence observer.** The read layer keeps an in-memory mirror of
the last value it saw for _this app's_ resolved cookie name. When a read
returns a different value than the mirror — or no cookie at all — an external
writer rotated (a sibling tab, a server `Set-Cookie`, a cookie clear): update
the mirror (minting fresh if the cookie is gone) and **mark the history cache
stale** through the store handle before proceeding. Self-rotations update the
mirror synchronously and never trigger it. Comparing only this app's cookie
name preserves the multi-app isolation the storage listener's key filter
provides today (`rango-state.ts:49`).

Two properties the observer must hold so a single event doesn't become a refetch
storm:

- **Idempotent per observed value.** `getRangoState()` is read at _prefetch_
  start too (`prefetch/fetch.ts:155`), so one navigation plus a viewport of
  prefetch links produces a burst of reads in a single tick. The observer must
  mark stale **once per observed value change**, not once per read — the mirror
  updates on the first diverging read, so the rest of the burst already matches
  and stays silent. Pin it: the divergence unit test should assert N reads after
  one external rotation produce exactly one stale mark, not just test a single
  read.
- **A mint-on-missing-cookie is a self-rotation.** When N tabs are live and the
  jar is cleared, each reads "no cookie," mints its own timestamp, and writes to
  the shared last-writer-wins jar. Untreated, every tab then observes the
  _others'_ mints as divergences and re-marks stale, so one clear cascades into
  up to N−1 extra stale marks as tabs converge on the last writer. It is bounded
  and always errs toward freshness (extra misses, never stale reads), but it is
  avoidable: treat a mint a tab just performed in response to a missing cookie as
  a self-rotation (update the mirror, don't re-fire), collapsing a multi-tab
  clear to at most one stale mark per tab. Cover it with a multi-tab-clear e2e
  asserting a bounded refetch count.

The observer is not an optimization — it is what closes the two holes the
channel inventory above leaves open:

- **Server rotation reaches the history cache.** A `Set-Cookie` from
  `invalidateClientCache()` lands in the jar, but the history cache is not
  state-keyed and the bridge is not involved — without the observer, the
  rotation busts prefetches and the HTTP cache while Back serves the
  pre-mutation page. This is the doc's own three-caches lesson applied to its
  own server API, and an earlier draft missed it.
- **Cross-tab invalidation without shared segments.** Today a sibling tab on
  an unrelated route ignores the `BroadcastChannel` message and keeps a
  history entry that can be stale until TTL. Under the observer, tab A's
  rotation is in the shared jar; tab B's next fetch sees the divergence and
  marks its history stale regardless of segment overlap.

The resulting matrix — every row at least as strong as today:

| Event                                          | Today                                                                                                                                                | Under this design                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Action completes in tab A                      | A marks stale + broadcasts at action start **and** again post-commit (`:656`); B invalidates if segments shared; B's value syncs via `storage` event | the redundant pre-commit broadcast is gone — invalidation fires once, at response time (post-commit); B's value syncs via jar read at its next fetch; B's history _additionally_ marked stale by jar divergence even without shared segments (see the fence-and-defer notes under `keepClientCache()`) |
| `invalidateClientCache()` client seat in tab A | n/a (hook: hard clear + broadcast)                                                                                                                   | same row as an action — mark-stale + broadcast + jar divergence                                                                                                                                                                                                                                        |
| Server rotation (`Set-Cookie`)                 | n/a                                                                                                                                                  | every tab sharing the jar observes the divergence at its next fetch and marks its history stale — no broadcast needed                                                                                                                                                                                  |
| Cookies cleared mid-session                    | no effect — localStorage state survives, stale-keyed entries still hit                                                                               | each tab's next read finds no cookie, mints fresh, marks history stale; every previously cached response unreachable                                                                                                                                                                                   |

Two boundaries to keep the claims precise: the observer is pull-based (it
fires at a tab's next jar read — a navigation/prefetch fetch or a popstate
restore, which reads `getRangoState()` before the stale check — not instantly,
same as the value sync it replaces), and it marks stale without refreshing the
current view; the
immediate-auto-refresh behavior remains exclusive to the `BroadcastChannel`
path and its `crossTabAutoRefresh` gate. Neither is a regression — today's
`storage` event refreshed nothing either.

## Security model

The threat-model edges, examined and accepted:

- **XSS reading the value** learns a build version that is already in the HTML
  payload and a timestamp. No gain.
- **A user tampering with their own value** mis-keys their own private cache.
  Self-harm; no privilege, no data, no cross-user effect.
- **Cookie injection from a sibling subdomain** could pin a victim's state and
  freeze rotation, producing TTL-bounded staleness. An attacker with that
  capability has strictly worse attacks available (fixating real session
  cookies), and signing wouldn't help — the client must hold the key.

Two invariants the implementation must hold, both load-bearing:

- **The fetches must keep a non-`omit` credentials mode.** Server rotation
  works only because `Set-Cookie` on a same-origin fetch response is applied
  automatically, which requires credentials mode ≠ `omit`. The navigation,
  action, and prefetch fetches pass no `credentials` option today (default
  `same-origin`). If anyone later adds `credentials: "omit"` as a hardening
  tweak, the server seat of `invalidateClientCache()` silently stops working
  with no error. Treat the default credentials mode on those fetches as part
  of this contract.

- **`X-Rango-State` must never become a shared-cache key _while clients mint
  the value_.** The design is safe because the only Vary-keyed cache is the
  browser's private one. If the header leaked into a CDN or `CFCacheStore` (the
  Cloudflare edge cache store) key, a client could mint unlimited values and
  inflate cache variants at will — a cache-busting / cost-amplification vector.
  This holds in code today: the CF key is built by `keyToRequest`
  (`src/cache/cf/cf-cache-store.ts:1996-2003`) from base URL + version path +
  encoded key only, with no request headers, so `X-Rango-State` cannot reach the
  key. The scoping qualifier matters: the deferred server-authored epoch changes
  _who_ mints the value, and under a server-minted epoch this guardrail no longer
  applies (that's precisely what makes the epoch safe to key a shared cache on).
  Today: private cache only; shared-cache invalidation stays server-authored.

### Finding #3: `Set-Cookie` × shared response caches

This is the one hazard the cache-exec guards do **not** cover, and it can break
the "failure direction is always toward freshness" invariant, so it gets its
own section.

The cache-exec assertions guard _segment_-cache execution. They say nothing
about _response_ caches. `src/cache/document-cache.ts` caches whole responses,
and its `shouldCacheResponse` (`document-cache.ts:118-126`) gates only on status
200 + `Cache-Control` — it does **not** inspect `Set-Cookie`. So a handler on
an `s-maxage` document route that calls `invalidateClientCache()` has its
`Set-Cookie` stored in the response cache and **replayed to every client**.
That pins all of them to one shared state value, and worse, can roll a client
that has since rotated _back_ to a previously-used value — resurrecting its
Vary-keyed stale HTTP-cache entries. That is a staleness hazard moving the
wrong direction.

This pre-exists for any `cookies().set()` on a cached document route, but this
design ships a framework-blessed API whose whole job is setting a cookie from a
handler, so the collision goes from theoretical to likely. The fix lives in the
implementation surface and the test contracts: any shared _response_ store must
refuse to cache — or strip the rango-state `Set-Cookie` from — a response that
carries it.

Get the store inventory right, because an earlier draft of this section was both
too short and rested on an unverified platform claim:

- **`shouldCacheResponse` is the right primary chokepoint** — it gates every
  `putResponse` the document-cache middleware issues (the miss path and the
  background-revalidation path both pass through it) — but it is _not_ the only
  caller. `putResponse` is public on the store interface and is invoked directly
  by the CF tag-revalidation re-put paths (`cf-cache-store.ts:2675`, `:2798`,
  `:2918`), which bypass it. So the strip belongs in **both** places: refuse or
  strip in `shouldCacheResponse`, **and** strip the rango-state `Set-Cookie`
  inside each store's `putResponse` as defense-in-depth (use
  `getSetCookie()`/`delete`, not `forEach`), so the invariant holds regardless of
  caller.
- **Three response stores, not two.** The doc previously named only
  `document-cache.ts` and "any KV-backed L2" and omitted the default Node store.
  All three copy _every_ response header (including `Set-Cookie`) into the stored
  entry and replay it: (1) `MemorySegmentCacheStore` — the built-in store for
  Node/non-CF apps — copies headers via `response.headers.forEach`
  (`memory-segment-store.ts:295-297`); (2) the CF **KV/L2** envelope captures all
  headers, so `putResponse` filters per-client signals out of the envelope on
  the write side; (3) the CF **L1** (the user-space Workers Cache API)
  `cache.put` is _believed_ to throw on a `Set-Cookie` response, so an L1 entry
  fails to store — but that is **platform behavior assumed, not verified
  in-repo**, so don't lean on it. Make the in-repo strip the canonical guarantee
  for all three; don't make Cloudflare correctness depend on the runtime
  declining `Set-Cookie`.
- **Read side: anything found on read is contamination.** Because every write
  both refuses (`shouldCacheResponse`) and strips, no _legitimate_ stored entry
  carries a per-client signal — so any a read encounters came from a pre-fix
  build or a consumer-pinned `version` namespace that outlived the write fix.
  Two CF read chokepoints strip defensively so such an entry can never replay
  one client's `Set-Cookie` to another: `toClientResponse` (the L1 serve path)
  and the `kvGetResponse` `hd` filter (which also cleans the array
  `promoteResponseToL1` re-seeds L1 from). The `hd` filter lives _inside_ the
  corrupt-envelope `try`, so a malformed `hd` evicts rather than throwing
  through. All sites share `stripPerClientSignals`/`isPerClientSignalHeader`
  from `cookie-name.ts` (one `PER_CLIENT_SIGNAL_HEADERS` source).

## Degradation: same-tab experience never degrades

The hard requirement that shaped the fallback design. "Cookies blocked" must be
a performance footnote, not a breakage.

First, the precedence rule, because an earlier draft got it backwards and that
inverted the whole feature: **when `document.cookie` is readable, the
per-request cookie read is authoritative** — it _is_ the cross-tab sync channel
(there is no `storage` event anymore). The module-level in-memory value is a
write-through mirror, authoritative _only_ when the cookie is unreadable. Get
this backwards (in-memory wins, cookie is "persistence only") and a server
`Set-Cookie` lands in the jar but the client keeps sending the old header — the
"rotates on receipt" semantics quietly become false and cross-tab sync dies.
Relatedly: the per-request `document.cookie` read is required for correctness,
not a convenience. A future "optimization" that caches the read across requests
would reintroduce exactly the staleness this design removes.

| Condition         | Same tab / session                | Across reloads                              | Cross-tab                                                                                                                                                              |
| ----------------- | --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookies available | full speed                        | warm (cookie kept on matching-version boot) | value via per-request jar read; invalidation via jar divergence + `BroadcastChannel`                                                                                   |
| Cookies blocked   | **full speed** (in-memory mirror) | cold mint; ≤ `max-age`-old hits lost        | jar-based sync lost; **`BroadcastChannel` invalidation still works** (it's cookie-independent), so action-driven cross-tab invalidation of shared segments still fires |

What makes the first column unconditional: with cookies blocked the in-memory
mirror is the source of truth within a page session; the `X-Rango-State` header
is always sent, and the in-memory prefetch map never touches storage. Cookie
write failures are silently absorbed. The failure direction is always toward
freshness: divergent states produce extra misses, never stale reads — except
the narrow case of a tab that missed a `BroadcastChannel` message _and_ can't
read the cookie, which self-heals on its next action or reload and is bounded
by `prefetchCacheTTL`. Browsers also block site data wholesale, not cookies à
la carte, so any configuration that breaks the cookie was already breaking
localStorage; this design inherits the blast radius, it doesn't widen it.

When `prefetchCacheTTL` is `false`/`0`, the HTTP-cache surface disappears
entirely (`router.ts:219-222` sets no `Cache-Control`, though `Vary` is still
emitted and inert). The state then keys only the in-memory map and the history
cache, and every TTL-bounded window above collapses to the page lifetime.

Deliberately rejected: a silent cookie → localStorage → memory fallback chain.
It resurrects a dual-backend test matrix for users whose browsers almost
certainly blocked both. One persistent backend, one in-memory mirror.

## Why no storage config option at launch

We ship the cookie as a hard cutover with no `clientStateStorage` knob, on
three legs:

- **Safe migration needs no escape hatch.** Losing the old state is always
  safe (a fresh mint just misses cleanly), so a client on the old localStorage
  scheme simply mints a fresh cookie on first load — a one-time bust, no value
  porting.
- **A second backend doubles the test matrix.** Dev + production e2e for both
  modes, cross-tab for both, multi-app namespacing for both — for a fallback
  most affected users can't reach anyway.
- **The pre-release API-hygiene rule forbids it.** No transitional public
  config before first stable external adoption (see `CLAUDE.md`). A storage
  toggle is exactly the kind of transitional knob that rule exists to keep out.

The one real adopter who'd want localStorage back — a deployment that is
cookie-free by policy — is the named trigger to add the option later (Deferred).
The plumbing already exists (it's the `prefetchCacheTTL` path), so adding it
later is cheap.

## Implementation surface

- `src/browser/rango-state.ts` — the rewrite. Per-request `document.cookie`
  read replaces the cached-value-plus-`storage`-event machinery (delete the
  listener; the jar read becomes the value-sync channel). The in-memory value
  becomes a write-through mirror used only when the cookie is unreadable, and
  doubles as the divergence reference: a read that differs from the mirror (or
  finds no cookie) marks the history cache stale through the store handle.
  Boot keeps an existing matching-version cookie (port the `73-83` keep
  logic); mints fresh otherwise. Add the `next = max(Date.now(), prev + 1)`
  guard. On first boot under the cookie scheme, delete the legacy localStorage
  keys (`rango-state` and `rango-state:{routerId}`) — no value porting.
- A store-handle module (new, dependency-light) — registers the active
  navigation store at boot; consumed by the client seat of
  `invalidateClientCache()` and by the divergence observer. Do **not** use the
  existing `getNavigationStore()` (`navigation-store.ts:812-833`): the real
  boot path never populates it (test-only); either reconcile boot to register
  through it or keep it out of this design entirely.
- `src/browser/cookie-name.ts` (new) — value encode/decode
  (`encodeURIComponent(version) + ":" + timestamp`) and the attribute string,
  imported by `rango-state.ts` and the server helper. **Name resolution does
  not live here** — it's consumed once at router init (`src/router.ts`) and
  shipped in metadata; the writers consume the pre-resolved name. (Keeping name
  resolution out of the shared writer module is what makes "the client does
  zero composition" true.)
- `src/router/router-options.ts`, `src/router.ts`, `src/rsc/types.ts`,
  `src/rsc/rsc-rendering.ts`, `src/browser/rsc-router.tsx` — the
  `stateCookiePrefix` option, name resolution at init, and the resolved-name
  metadata plumbing, following `prefetchCacheTTL` end to end.
- `src/index.rsc.ts` — the server implementation of `invalidateClientCache()`,
  guarded via the `cookie-store.ts` `assertNotInsideCacheContext` pattern, and
  of `keepClientCache()` (request-scoped flag → internal directive response
  header; inert with a dev warning outside action requests).
- `src/index.ts` — the **client** implementation (a real function, not a
  stub): `document` guard (SSR no-op + dev warning), then the store handle's
  mark-stale path, with the pre-boot `clearPrefetchCache()` fallback. Bundle
  note: this gives the root entry's default build a real import into browser
  modules — keep the handle module dependency-light so tree-shaking holds. Wrap
  every dev-only warning branch in a build-time-foldable
  `process.env.NODE_ENV !== "production"` check so it drops from production
  bundles (CLAUDE.md Bundle Hygiene rule #2); `src/index.ts` is the default entry
  pulled into every client bundle. The existing bundle guard
  (`build-test-app.setup.ts`) only fails on `react*.development*.js` chunks — it
  cannot confirm the client invalidate path didn't drag the navigation store into
  the default-entry chunk, so verify that separately with the bundle-analysis
  skill and pin the ~50 KB gzip client baseline. Also hosts the
  `default`-condition `keepClientCache()` no-op (dev warning).
- Removal of `useClientCache` — `src/browser/react/use-client-cache.ts` and
  its exports in `src/client.tsx`, the comment in `src/client.rsc.tsx:53`, the
  vite-rsc-demo dogfood usage, `skills/hooks/SKILL.md`,
  `docs/internal/feature-map.md`, and the two test files named in the API
  section.
- `src/cache/document-cache.ts` — `shouldCacheResponse` (`:118-126`) must refuse
  (or strip) responses carrying the rango-state `Set-Cookie`, and the same strip
  must run as defense-in-depth inside each response store's `putResponse`: the
  CF KV envelope build (`cf-cache-store.ts:1691-1692`) and `MemorySegmentCacheStore`
  (`memory-segment-store.ts:295-297`), so the direct CF tag-revalidation re-puts
  (`cf-cache-store.ts:2675`/`:2798`/`:2918`) that bypass `shouldCacheResponse`
  are covered too. Drop the internal `keepClientCache()` directive header at the
  same chokepoint. (Finding #3.)
- `src/browser/server-action-bridge.ts` — the eager clear at action start
  (`:164`) becomes the fence-and-defer flow described under
  `keepClientCache()`; the bridge reads the directive header at response time
  to decide, and reproduces the existing post-commit broadcast (`:656`) end
  state on a directive-free response. This is the one behavioral change to
  existing machinery — gate it on the semantic matrix.
- `src/browser/navigation-bridge.ts` — the popstate restore path must OR an
  ephemeral `fenceActive()` predicate into the persisted `entry[2]` stale bit
  (`isStale = cached.stale || fenceActive()` at `:453`; the SWR revalidation
  block `:514-552` must fire when `fenceActive()` even if `entry[2]` is false),
  so a popstate during an active fence is served stale-while-revalidate with no
  persisted flag. Without this the fence reintroduces the stale-Back-button bug.
- Untouched: the `Vary` header, the prefetch key shapes, the
  `navigation-store.ts` `BroadcastChannel` machinery (the cross-tab
  no-regression invariant).

## Test contracts to pin

Per repo policy every e2e contract needs **dev and production** coverage, the
production describes must carry a `(production)` title (or use `prodDescribe`,
or they silently land in the dev bucket — this has bitten the repo), and the
coverage lives in the cloudflare-basic app and the e2e test app. Assign each
contract to its app(s) explicitly rather than leaving it implicit: the Finding
#3 / response-cache contracts only exercise a KV L2 in cloudflare-basic and the
in-memory store in the e2e app, and the multi-app routerId-isolation suite needs
a named host — a contract that silently lands single-app or dev-only passes
review while leaving a hole.

- Unit (`rango-state` suite): cookie read/write round-trip; in-memory mirror
  when `document.cookie` throws or writes are ignored; **boot keeps a
  matching-version cookie and does not mint fresh**; rotation preserves the
  version prefix; the same-millisecond `max(now, prev+1)` guard never produces
  a no-op rotation; prefix + routerId sanitization (including
  empty-after-sanitization fallback to the default); legacy localStorage
  cleanup on first boot; **divergence observer**: an externally changed jar
  value triggers exactly one history-stale mark via the store handle, a
  missing cookie triggers mint + mark, a self-rotation triggers nothing, a
  mint-in-response-to-a-missing-cookie is treated as a self-rotation (no
  re-fire), N reads after a single external rotation produce exactly one mark
  (idempotent across a prefetch read burst), a server value that _equals_ the
  in-memory mirror is still handled (the same-millisecond cross-boundary case),
  and a _different app's_ cookie name changing triggers nothing (multi-app
  isolation).
- Unit (prefetch): a prefetch's key is captured from the state at fetch start
  (`prefetch/fetch.ts:268-270`, `317-319`), so a state rotation mid-flight
  strands the completion under a retired key — the property that makes a bare
  rotation safe even without a generation bump (the generation check itself:
  `cache.ts:268`).
- Unit (entry conditions): the root entry resolves `invalidateClientCache` to
  the server implementation under `react-server` and the client implementation
  under `default`; the client implementation no-ops (with the dev warning)
  when `document` is undefined; `keepClientCache` resolves to the directive
  implementation under `react-server` and to the warning no-op under
  `default`. Positive export-surface contract: `documentation-imports.test.ts`
  resolves both new names from `@rangojs/router` (not just the absence of
  `useClientCache`).
- Unit (response-cache strip, Finding #3): `shouldCacheResponse` refuses a
  response carrying **any** `Set-Cookie` (or the directive header), and the
  `putResponse` strip drops `Set-Cookie` in the CF L1 headers, the CF KV
  envelope, and `MemorySegmentCacheStore`. The match rule is **strip-all**, not
  rango-state-name-specific: a shared store has no request context and cannot
  know the resolved cookie name, and a cacheable document carrying any
  per-client cookie is the hazard regardless of which cookie it is (shared via
  the `isPerClientSignalHeader()` helper). The internal `keepClientCache()`
  directive header is request-scoped, emitted at most once, and stripped / never
  cached (the mirror-image-of-Finding-#3 guard).
- Unit (credentials invariant): the navigation, action, and prefetch fetch
  inits carry no `credentials: "omit"` (inspect the `RequestInit`), so the
  server seat's auto-applied `Set-Cookie` keeps working — the canonical
  "silently stops working with no error" footgun, now guarded.
- E2E, client seat: `invalidateClientCache()` from browser code re-fetches a
  previously prefetched route; **Back after the call renders the cached entry
  and revalidates** (the SWR mark-stale contract — also pins the
  behavior delta from the deleted hook's hard clear); a sibling tab on a
  shared-segment route invalidates via `BroadcastChannel`.
- E2E, server seat: a non-action handler calling it rotates the responding
  client's state (assert the `Set-Cookie` and the subsequent header change);
  **Back after the response must not serve the pre-mutation page** (the
  divergence-observer contract — the test that would have caught the earlier
  draft's hole); **a second tab sharing the jar marks its history stale at its
  next fetch even without shared segments** (two pages in one Playwright
  context share the cookie jar).
- E2E, lifecycle: clearing cookies mid-session (via the browser context) makes
  the next navigation mint fresh and miss every previously cached response;
  **a multi-tab clear converges with a bounded refetch count** (at most one
  stale mark per tab, no cascade); cookie attributes match the contract table;
  the resolved cookie name arrives in payload metadata and the client does zero
  composition (pins the "one resolution point" claim); two same-origin apps with
  distinct routerIds keep independent state (a named multi-app suite — name its
  host app); `stateCookiePrefix` changes the cookie name end to end; **a cached
  document route that calls `invalidateClientCache()` does not get its
  `Set-Cookie` stored and replayed** (finding #3 regression — exercised against
  the CF KV L2 in cloudflare-basic **and** the in-memory `document-cache` path in
  the e2e test app, since each app uses a different store).
- E2E, action directive: an action calling `keepClientCache()` leaves a
  previously prefetched route served from cache after the action, keeps the
  `X-Rango-State` header value unchanged, issues no revalidation refetch, and
  broadcasts nothing; a directive-free action still invalidates end to end
  (the regression guard for the eager-clear → fence-and-defer timing shift),
  **and a navigation to a previously-prefetched URL during the action's flight
  fetches fresh from the server, not the stale HTTP-cache prefetch** (the fence
  HTTP-cache-bypass guard — catches the false "exactly the misses the eager
  clear gives them today" equivalence); a popstate during the flight serves
  cache and revalidates, and after a directive response drops the fence a
  popstate serves cache _without_ revalidating (proving no stale flag leaked);
  an action calling both `keepClientCache()` and `invalidateClientCache()`
  still rotates (the `Set-Cookie` path is not suppressible); a `keepClientCache()`
  action overlapping a directive-free action still invalidates (keep is a
  per-action, not global, guarantee).
- Unit (bridge): the fence suspends prefetch consumption for the duration of
  an action's flight; the fence is refcounted across concurrent actions — each
  response decrements once and the fence lifts only at zero, so a keep response
  does **not** lift the fence while a non-keep action is still pending; a
  directive-free response reproduces today's end state exactly (re-mark stale
  after caching fresh segments, matching the existing `:656` post-commit
  broadcast); a directive response drops the fence without persisting any marks;
  calling `keepClientCache()` twice in one action emits one directive.
- Semantic matrix: stays green for directive-free actions (the timing shift
  must be observationally equivalent), with new rows pinning the directive
  cases. Run it before and after the bridge change.
- Existing guards that must stay green: server-action invalidation still
  rotates state and marks the history cache stale; cross-tab `BroadcastChannel`
  invalidation still fires (the no-regression invariant); deploy version
  change still busts at boot; no `useClientCache` reference survives anywhere
  (the documentation-imports test enforces the export surface).

## Deferred, with triggers

| Deferred item                                                      | Trigger to build it                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `clientStateStorage: "localStorage"` option                        | a cookie-free-by-policy adopter appears                          |
| Cookie `Max-Age` derived from `prefetchCacheTTL`                   | an adopter runs a multi-hour TTL and misses cross-restart warmth |
| Shared epoch (global invalidation, CDN-shareable prefetch caching) | demand for webhook-driven "invalidate everyone"                  |

The epoch is the natural next step this design leaves open: if the server
authored the state value from shared storage (KV, DB) instead of clients
minting timestamps, all clients on epoch N would present the same header value
— turning `X-Rango-State` into a usable shared-cache key under server control
(which is exactly when the never-a-shared-cache-key guardrail stops applying),
and dovetailing with the server-side cache invalidation `CFCacheStore` already
does. Nothing in the cookie contract above blocks it.
