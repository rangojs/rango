---
name: hooks
description: Client-side React hooks for navigation, loaders, and state in @rangojs/router. Use when a client component needs the current URL, params, search params, navigation state, or loader data — e.g. "how do I read the route param in a component".
argument-hint: [hook-name]
---

# Client-Side React Hooks

The client-side API for reading router state in client components: navigation
state and actions, URL and params, loader data, handles, action status,
location state, outlets, and client-cache invalidation.

Import the hooks and components in this skill from `@rangojs/router/client`.
The root `@rangojs/router` entrypoint is for server/RSC APIs and shared types;
the exceptions used here are `invalidateClientCache()` (root only) and
`createLocationState()` (exported from both).

## Not this skill if…

- You want to fetch data — data fetching happens in server-side loaders: see
  `/loader`. Client hooks like `useLoader()` only consume what a loader
  resolved.
- You want to control when a loader re-runs after an action — that is
  `revalidate()` in the server DSL: see `/loader`.
- You want an action to leave the client cache alone — that is
  `keepClientCache()` inside the action: see `/server-actions`.

Each hook's full API and recipe lives in a companion file linked below. Read
the one for your case.

## Decision table

| I need...                                          | Hook                        | File                                                 |
| -------------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Reactive navigation state                          | `useNavigation()`           | [`./navigation.md`](./navigation.md)                 |
| Stable router actions (push/replace/refresh/…)     | `useRouter()`               | [`./navigation.md`](./navigation.md)                 |
| Current URL path & matched segments                | `useSegments()`             | [`./navigation.md`](./navigation.md)                 |
| Pending state inside a `<Link>`                    | `useLinkStatus()`           | [`./navigation.md`](./navigation.md)                 |
| Loader data (streams; suspends until it lands)     | `useLoader()`               | [`./data.md`](./data.md)                             |
| Loader data with on-demand fetch                   | `useFetchLoader()`          | [`./data.md`](./data.md)                             |
| Refresh multiple loaders across groups             | `useRefreshLoaders()`       | [`./data.md`](./data.md)                             |
| Accumulated handle data from route segments        | `useHandle()`               | [`./handle-and-actions.md`](./handle-and-actions.md) |
| Server action invocation state                     | `useAction()`               | [`./handle-and-actions.md`](./handle-and-actions.md) |
| Type-safe history state (persistent or flash)      | `useLocationState()`        | [`./state.md`](./state.md)                           |
| Force the client's caches to miss after a mutation | `invalidateClientCache()`   | [`./state.md`](./state.md)                           |
| Render child content in a layout                   | `Outlet` / `ParallelOutlet` | [`./outlets.md`](./outlets.md)                       |
| Access outlet content programmatically             | `useOutlet()`               | [`./outlets.md`](./outlets.md)                       |
| Route params from the current URL                  | `useParams()`               | [`./urls.md`](./urls.md)                             |
| Current URL pathname                               | `usePathname()`             | [`./urls.md`](./urls.md)                             |
| Current URL search params                          | `useSearchParams()`         | [`./urls.md`](./urls.md)                             |
| Mount-aware href inside an `include()` scope       | `useHref()`                 | [`./urls.md`](./urls.md)                             |
| Current `include()` mount path                     | `useMount()`                | [`./urls.md`](./urls.md)                             |
| Local reverse for an imported `urls()` routes map  | `useReverse(routes)`        | [`./urls.md`](./urls.md)                             |

## Companion files

- [`./navigation.md`](./navigation.md) — `useNavigation`, `useRouter` (incl.
  `revalidate: false`), `useSegments`, `useLinkStatus`.
- [`./data.md`](./data.md) — `useLoader`, `useFetchLoader` (shared refetch
  scoping, `key`, `refreshGroup` + `useRefreshLoaders`, load options, file
  uploads).
- [`./handle-and-actions.md`](./handle-and-actions.md) — `useHandle`,
  `useAction`. For the full server-action guide (defining actions,
  `useActionState`, `useOptimistic`, validation, revalidation, error
  handling, file uploads), see `/server-actions`; `useAction()` here is the
  Rango-specific hook for tracking actions called outside a
  `<form action={...}>` flow.
- [`./state.md`](./state.md) — `useLocationState` (persistent + flash state,
  `.read()`/`.read(location)`/`.write()`/`.delete()`, typed `state` on `router.push()` /
  `router.replace()`, serializability errors that name the failing field),
  state from another deploy (dropped by the router, no version to manage), the
  `createLocationState` options (`flash`; `clearOnReload` for state that must
  not come back after a refresh, such as a "load more" list),
  `invalidateClientCache()`.
- [`./outlets.md`](./outlets.md) — `Outlet`, `ParallelOutlet`, `useOutlet`.
- [`./urls.md`](./urls.md) — `useParams`, `usePathname`, `useSearchParams`,
  `useHref`, `useMount`, `useReverse`.

## Hook Summary

| Hook                      | Purpose                                                        | Returns                                                                         |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `useParams()`             | Route params                                                   | `Readonly<T>` (default `Record<string, string \| undefined>`) or selected value |
| `usePathname()`           | Current pathname                                               | `string`                                                                        |
| `useSearchParams()`       | URL search params (read + write)                               | `[ReadonlyURLSearchParams, SetSearchParams]` (RR-style tuple)                   |
| `useHref()`               | Mount-aware href                                               | `(path) => string`                                                              |
| `useMount()`              | Current include() mount path                                   | `string`                                                                        |
| `useReverse()`            | Local reverse for imported routes                              | `(name, params?, search?) => string`                                            |
| `useNavigation()`         | Reactive navigation state                                      | state, location, pendingUrl, isStreaming                                        |
| `useRouter()`             | Stable router actions                                          | push, replace, refresh, prefetch, back, forward                                 |
| `useSegments()`           | URL path & segment IDs                                         | path, segmentIds, location                                                      |
| `useLinkStatus()`         | Link pending state                                             | { pending }                                                                     |
| `useLoader()`             | Loader data (strict)                                           | data, isLoading, error, load, refetch                                           |
| `useFetchLoader()`        | Loader with on-demand fetch                                    | data, load, isLoading, error, refetch                                           |
| `useRefreshLoaders()`     | Refresh cross-loader group(s)                                  | `() => (groups: string \| string[]) => Promise<void>`                           |
| `useHandle()`             | Accumulated handle data                                        | T (handle type)                                                                 |
| `useAction()`             | Server action state                                            | state, actionId, payload, error, result                                         |
| `useLocationState()`      | History state (persists or flash)                              | T \| undefined                                                                  |
| `invalidateClientCache()` | Force client caches to miss (function, not a hook; root entry) | `void`                                                                          |

## Hydration

On a document load every router hook renders what the server rendered until
the document has finished streaming, wherever the component sits. A component
in a `<Suspense>` or `loading()` boundary that streams in after the rest of
the page hydrates with the document's pathname, params, search params and
segments, an idle `useNavigation()` and `useAction()`, a `useLinkStatus()` that
is not pending, the handle data the HTML was rendered from, and `undefined`
location state, even when a navigation or an action has started meanwhile. It
cannot mismatch its server HTML.

- Navigation state, params and action state: the component shows the live
  value right after it hydrates.
- Handle data a loader pushed late, and the entry's location state: both wait
  until the whole document has streamed and been revealed. Location state
  lands in the barrier commit (one transition that also hydrates every
  boundary still dehydrated); handle data lands in the release notification
  right after that commit. `useLocationState` readers re-render when the
  entry's state object changes; `useHandle` readers when their selection
  changes.
- A navigation that commits before then mounts its page with the live values
  from its first render. A boundary of the document that persists across that
  navigation and has not hydrated yet then hydrates against the live values;
  where they differ from its HTML, React reports the mismatch and renders that
  boundary on the client.
- A held navigation whose history entry commits during that window releases
  the store for the whole hold. A boundary of the old page that hydrates during
  the hold reads the destination's values and can mismatch its HTML; React
  then renders that boundary on the client.
