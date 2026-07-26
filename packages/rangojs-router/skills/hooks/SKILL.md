---
name: hooks
description: Client-side React hooks for navigation, loaders, and state in @rangojs/router. Use when a client component needs the current URL, params, search params, navigation state, or loader data — e.g. "how do I read the route param in a component".
argument-hint: [hook-name]
---

# Client-Side React Hooks

Import the hooks and components in this skill from `@rangojs/router/client`.
The root `@rangojs/router` entrypoint is for server/RSC APIs and shared types.

## Not this skill if…

- You want to fetch data — data fetching happens in server-side loaders: see
  `/loader`. Client hooks like `useLoader()` only consume what a loader
  resolved.
- You want to control when a loader re-runs after an action — that is
  `revalidate()` in the server DSL: see `/loader`.

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
  `.read()`/`.write()`/`.delete()`), `invalidateClientCache()`.
- [`./outlets.md`](./outlets.md) — `Outlet`, `ParallelOutlet`, `useOutlet`.
- [`./urls.md`](./urls.md) — `useParams`, `usePathname`, `useSearchParams`,
  `useHref`, `useMount`, `useReverse`.

## Hook Summary

| Hook                      | Purpose                                                        | Returns                                                            |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `useParams()`             | Route params                                                   | `Readonly<T>` (default `Record<string, string>`) or selected value |
| `usePathname()`           | Current pathname                                               | `string`                                                           |
| `useSearchParams()`       | URL search params                                              | `ReadonlyURLSearchParams`                                          |
| `useHref()`               | Mount-aware href                                               | `(path) => string`                                                 |
| `useMount()`              | Current include() mount path                                   | `string`                                                           |
| `useReverse()`            | Local reverse for imported routes                              | `(name, params?, search?) => string`                               |
| `useNavigation()`         | Reactive navigation state                                      | state, location, isStreaming                                       |
| `useRouter()`             | Stable router actions                                          | push, replace, refresh, prefetch, back, forward                    |
| `useSegments()`           | URL path & segment IDs                                         | path, segmentIds, location                                         |
| `useLinkStatus()`         | Link pending state                                             | { pending }                                                        |
| `useLoader()`             | Loader data (strict)                                           | data, isLoading, error, load, refetch                              |
| `useFetchLoader()`        | Loader with on-demand fetch                                    | data, load, isLoading, error, refetch                              |
| `useRefreshLoaders()`     | Refresh cross-loader group(s)                                  | `() => (groups: string \| string[]) => Promise<void>`              |
| `useHandle()`             | Accumulated handle data                                        | T (handle type)                                                    |
| `useAction()`             | Server action state                                            | state, error, result                                               |
| `useLocationState()`      | History state (persists or flash)                              | T \| undefined                                                     |
| `invalidateClientCache()` | Force client caches to miss (function, not a hook; root entry) | `void`                                                             |
