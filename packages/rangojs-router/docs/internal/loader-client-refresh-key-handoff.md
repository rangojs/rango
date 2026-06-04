# Loader Client Refresh Key Handoff

> **Status: Implemented.** Shipped as the `key` option on `UseLoaderOptions`
> (`src/use-loader.tsx`) backed by composite buckets + family index + ephemeral
> refcount in `src/loader-store.ts`. Covered by unit tests
> (`src/__tests__/loader-store.test.ts`) and e2e in dev + production
> (`e2e/loader-key-refresh.test.ts`, fixtures under `e2e/test-app/src`).
> Consumer docs live in `skills/hooks/SKILL.md` ("Scoping refetch with a
> `key`") and `skills/loader/SKILL.md`; the runtime contract is in
> `docs/internal/execution-model.md` ("Client Refresh Fan-out"). The rest of
> this document is retained as the design record; sections below are written as
> the original proposal.
>
> **Follow-up also shipped:** cross-loader refresh groups — the `refreshGroup`
> option (`string | string[]`, so one read can carry several tags) + the inverted
> `useRefreshLoaders()` hook, whose returned `refresh(groups)` takes one group or
> an array and refreshes the union (plain-GET refresh of many different loaders at
> once, GET-only, `AggregateError` on failure, never render-throws). Backed by a
> `groups` index + `refreshGroups()` in `loader-store.ts`; e2e `/key-refresh-group`
> and `/key-refresh-multitag`.

## Problem

`useLoader()` and `useFetchLoader()` currently have two client refresh modes:

- A plain `load()` on a route-registered loader broadcasts to every mounted
  reader of that loader.
- Any `load({ params })`, non-GET method, or body-bearing call stays local to
  the hook that issued it.

That leaves no middle ground. Consumers cannot scope a plain refetch to a subset
of readers, and they cannot intentionally share a parameterized GET result among
multiple readers that represent the same logical view.

This is independent from the route DSL `revalidate()` helper. `revalidate()`
selects server segments/loaders during navigation and action refreshes. This
change only controls client hook fan-out for client-initiated `load()` calls.

## Current Model

Client-side sharing is owned by:

- `src/use-loader.tsx`
- `src/loader-store.ts`

The shared store is keyed by `loader.$$id`. `use-loader.tsx` decides whether a
call uses that shared store with:

```ts
const shared = isPlainRefetch(loadOptions) && hasContextDataRef.current;
```

`isPlainRefetch()` returns `false` for explicit params, non-GET methods, or a
defined body. Those calls use per-hook local state instead.

Server loader cache keys are a separate concern in
`src/router/segment-resolution/loader-cache.ts`. The default cache key is
`loader:{loaderId}:{pathname}:{sortedParams}`, with `cache({ key })` as an
override. Do not wire the client refresh key into server cache identity.

This change is out of scope for the semantic matrix
(`e2e/semantic-matrix.test.ts`). Its loader rows cover server-cache behavior
(`loader without cache() runs fresh`, `loader with cache() returns cached
data`), not client `load()` fan-out, so no matrix rows change. Leave it alone;
adding client-fan-out rows there would dilute the server execution contract.

## Proposed API

Add a `key` option to both loader hooks:

```tsx
const cart = useLoader(CartLoader, { key: "cart-header" });
const search = useFetchLoader(SearchLoader, { key: `search:${query}` });
```

The name is intentionally React-like: same key means same client refresh
identity; different key means independent refresh identity. Document it as a
client refresh key, not a server cache key.

`key` collides nominally with three other concepts: React's `key`, the server
`cache({ key })` override in `loader-cache.ts`, and (loosely) `revalidate()`.
`group` and `scope` were considered to avoid this. We keep `key` for the
React-like mental model and symmetry with `cache({ key })`, and rely on docs to
keep the client-refresh meaning distinct. If review prefers disambiguation,
`group` is the fallback.

## Proposed Semantics

No `key` keeps today's behavior unchanged.

| Call                                          | No key                                                    | With key                                                                     |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `load()`                                      | Shared by `loader.$$id` if the loader is in route context | Shared by `loader.$$id + key`                                                |
| `load({ method: "GET" })` with no params/body | Same as `load()`                                          | Same as `load()`                                                             |
| `load({ params })`                            | Local to the calling hook                                 | Shared by `loader.$$id + key`                                                |
| `load({ method: "POST" })` or body present    | Local to the calling hook                                 | Local to the calling hook for the first pass                                 |
| Loader not in route context                   | Local to the calling hook                                 | Shared by `loader.$$id + key` (ephemeral, refcounted — see Bucket Lifecycle) |

Initial route context remains keyed by `loader.$$id`. A keyed hook should seed
from the route's `loaderData[loader.$$id]` exactly like an unkeyed hook, then
diverge after the first keyed client `load()`.

There are two distinct reset boundaries depending on whether the loader is
route-registered:

- Route-registered loaders reset on **route context change**. On navigation or
  server revalidation, fresh `loaderData[loader.$$id]` resets all client buckets
  for the loader family so stale keyed data cannot survive a route data change.
  This is the existing trigger at `use-loader.tsx:262-272`.
- Unregistered loaders (`useFetchLoader` of a loader not on the route) have no
  route context, so `contextData` is permanently `undefined` and that effect
  never fires. Their keyed buckets reset on **subscriber refcount** instead —
  see Bucket Lifecycle.

## Implementation Notes

Likely type changes:

- Extend `UseLoaderOptions` in `src/use-loader.tsx` with `key?: string`.
- The hook signatures already accept `UseLoaderOptions`, so this should flow
  through both `useLoader()` and `useFetchLoader()`.

Likely store changes:

- Keep `LoaderStore` entries keyed by an internal bucket string.
- Add a loader-family index, for example `Map<string, Set<string>>`, where the
  family id is `loader.$$id` and each value is a concrete bucket key.
- Add `clearFamily(loaderId)` to clear all buckets for a loader id and invalidate
  in-flight requests for every bucket.
- Keep `clear(bucketKey)` for direct bucket clearing if still useful in tests.
- Add an ephemeral/refcount path for unregistered buckets:
  - `subscribe(bucketKey, cb, { ephemeral })` — the hook passes
    `ephemeral: !hasContextData`. Track per-entry whether it is currently
    ephemeral; flip it to sticky as soon as any non-ephemeral subscriber
    attaches (see the registered/unregistered mixed-subscriber edge).
  - On the last unsubscribe of an ephemeral entry, schedule a deferred clear
    (`queueMicrotask`/`setTimeout(0)`) and cancel it if a subscriber reattaches
    before it runs. If the entry is mid-flight (`snapshot.isLoading`), defer the
    clear until `finishData`/`finishError` and re-check the subscriber count.
  - Registered (sticky) entries keep today's behavior: the entry survives the
    last unsubscribe and is reset by `clearFamily`/route-context change.

Likely hook changes:

- Compute a `bucketKey` from `loader.$$id` and `options.key`.
- Subscribe to `bucketKey`, not always `loader.$$id`.
- Reserve/commit shared requests against `bucketKey`.
- Keep request fetch transport unchanged: `_rsc_loader` still sends
  `loader.$$id`, never the client refresh key.
- Use `loaderStore.clearFamily(loaderId)` when context data changes.
- Change the sharing predicate so explicit `key` allows parameterized GET
  sharing:

```ts
const hasKey = optionsKeyRef.current !== undefined;
const shared =
  hasContextDataRef.current &&
  (isPlainRefetch(loadOptions) || (hasKey && isParameterizedGet(loadOptions)));
```

Keep non-GET/body calls local unless the contract is deliberately expanded.

### Preserve the throwOnError originator scoping

The subtlest invariant in `use-loader.tsx` is the render-time throw at
`use-loader.tsx:445-461`. A shared error is thrown only by the hook that
initiated the failing `load()`; sibling readers expose it via `.error` without
throwing:

```ts
if (
  sharedSnapshot.error &&
  lastSharedRequestIdRef.current !== null &&
  sharedSnapshot.requestId === lastSharedRequestIdRef.current
) {
  throw sharedSnapshot.error;
}
```

This must keep working per bucket. Once `reserveRequestId` / `beginRequest` /
`finishError` are issued against `bucketKey`, `lastSharedRequestIdRef` simply
tracks the request id of the most recent shared load this hook issued into its
own bucket, so the originator-only-throw contract extends naturally to keyed
buckets: same-`key` siblings read the error via `.error` but do not throw; only
the initiator throws. This is easy to regress when threading the bucket key
through, so pin it with a test (see the keyed throwOnError row below).

## Resolved Decision: unregistered keyed loaders share

`useFetchLoader(Loader, { key })` **does** share when the loader is not
registered on the current route. An explicit `key` is an explicit request to
share, with or without route context. Two components calling
`useFetchLoader(SearchLoader, { key: "search:react" })` for an unregistered
`SearchLoader` see the same data, loading state, and error state, and a `load()`
from one refreshes the other.

Without a `key`, unregistered calls stay local exactly as today — this is
unchanged, and it is what prevents two unrelated components that merely
reference the same loader from accidentally sharing through the global store.
Sharing for unregistered loaders is opt-in via `key` only.

### Bucket Lifecycle

The hard part of this decision is reset lifecycle. Unregistered buckets cannot
use the route-context-change trigger (their `contextData` is always
`undefined`). They are **reference-counted by mounted subscribers** instead:

- A bucket is created on first subscribe and lives while it has at least one
  subscriber.
- When the last subscriber unsubscribes, the bucket is cleared (entry dropped,
  in-flight request invalidated).

This is intentionally different from registered buckets, where the store keeps
the entry alive after the last subscriber leaves (so an in-flight `load()` can
still commit on remount, per the comment in `loader-store.ts`). For unregistered
buckets, the refcount IS the lifecycle, so two refinements are required to avoid
clobbering legitimate flows:

- **Deferred clear, cancelled on resubscribe.** Clear on a `queueMicrotask` /
  `setTimeout(0)` boundary and cancel it if a new subscriber attaches first.
  This survives React StrictMode's mount-unmount-mount and transient
  unmount/remount during a transition.
- **Defer clear past an in-flight load.** If `snapshot.isLoading` when the last
  subscriber leaves, don't clear yet; let the request commit, then clear if
  there are still no subscribers. Mirrors the registered-bucket intent of not
  dropping a result a remounting consumer would want.

Why refcount and not navigation:

- A persistent component outside the outlet (e.g. a header running
  `useFetchLoader(CartLoader, { key: "cart" })` for an unregistered loader)
  **keeps** its shared bucket alive across navigations because it never
  unmounts. This is the desired behavior — the shared cart count should not
  blank out on every navigation.
- A route-scoped component unmounts on navigation, so its keyed bucket is
  reclaimed and cannot leak into the next route.

Both fall out of refcounting with no navigation signal in the store, preserving
the store's deliberate navigation-agnostic design.

### Edge: bucket subscribed by both registered and unregistered hooks

Registration is per-hook (`hasContextData` is derived from each hook's context
chain), so in principle one `loader.$$id + key` bucket could have a registered
subscriber in one part of the tree and an unregistered subscriber elsewhere. A
bucket must be treated as ephemeral (refcounted) only while **no** current
subscriber is route-registered; once any registered subscriber attaches, the
bucket becomes sticky and resets via the route-context path instead. Never
refcount-clear a bucket with a registered subscriber — that would risk dropping
an in-flight commit a remounting registered consumer expects.

## Tests To Add Or Update

Update existing shared-refetch coverage:

- `e2e/loader-shared-refetch.test.ts`
- `e2e/test-app/src/urls/shared-refetch.tsx`
- related shared-refetch client components and loaders in `e2e/test-app/src`

Required e2e coverage in both dev and production:

- Existing plain `load()` still broadcasts to all readers of a route-registered
  loader.
- Existing `load({ params })` without `key` still stays local.
- Same `key` readers share `load({ params })` result, loading state, and error
  state.
- Different `key` readers do not see each other's `load()` result or spinner.
- Same `key`, `throwOnError: true`: only the hook that initiated a failing
  `load()` throws; co-keyed siblings expose the error via `.error` without
  throwing. This is the keyed analogue of the existing `error: throwOnError`
  and `error mixed` rows in `loader-shared-refetch.test.ts`.
- Navigation/server context refresh clears all keyed buckets for the loader.
- Non-GET/body calls remain local even with `key`.
- Unregistered loader, same `key`: two `useFetchLoader` readers of a loader NOT
  on the route share data, loading, and error, and one `load()` refreshes both.
- Unregistered loader, different `key`: readers stay independent.
- Unregistered loader, no `key`: readers stay local (unchanged from today).
- Lifecycle (persistent): an unregistered keyed reader rendered outside the
  outlet (e.g. a header) keeps its shared value across a navigation.
- Lifecycle (route-scoped): an unregistered keyed reader inside the route does
  not leak its fetched value into the next route after navigation.

Add unit tests around `LoaderStore`:

- Composite bucket subscriptions only notify matching bucket listeners.
- `clearFamily(loaderId)` clears every bucket registered for that loader id.
- `clearFamily(loaderId)` invalidates in-flight requests for every bucket.
- Clearing one family does not clear buckets for another loader id.
- Ephemeral bucket: last unsubscribe schedules a deferred clear; a resubscribe
  before the timer cancels it (StrictMode / transition remount).
- Ephemeral bucket mid-flight: last unsubscribe does not clear until the in-
  flight request commits, then clears only if still subscriberless.
- Mixed subscribers: a bucket with one registered (`ephemeral: false`)
  subscriber is sticky and is not refcount-cleared when an ephemeral subscriber
  unmounts.

## Docs To Update With Implementation

- `skills/hooks/SKILL.md`: shared refetch behavior and examples.
- `skills/loader/SKILL.md`: brief note linking hook `key` to client refresh
  fan-out, explicitly separate from `revalidate()` and `cache({ key })`.
- `docs/internal/execution-model.md`: client `load()` fan-out rules.
- `docs/internal/feature-map.md` only if the public hook option tables are
  maintained there.

## Verification

For the implementation PR, follow the repository rule and run before pushing:

```bash
pnpm run typecheck
pnpm run test:unit
pnpm run lint
pnpm run format
```

Also run the full suite summary from the repo root:

```bash
pnpm test 2>&1 | tail -80
```

Because this changes loader hook behavior, run the relevant e2e tests in both
dev and production modes. If new route files are added or renamed in the test
app, regenerate and commit `router.named-routes.gen.ts`.
