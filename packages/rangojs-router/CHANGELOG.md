# Changelog

## 0.7.0 (2026-07-28)

Shell caching comes to clientUrls groups, `stream: "navigation"` loaders
become shell material under ppr, and the dev-mode client-reference dedup
gets exports-map precision. No breaking API changes; one behavioral change
for `stream: "navigation"` loaders on ppr routes (below).

### Highlights

#### `ppr` on clientUrls group routes ([#817](https://github.com/ivogt/vite-rsc/pull/817))

Group routes can now declare shell caching exactly like server pages:

```tsx
"use client";
export default clientUrls(({ path, loader, loading }) => [
  path("/", ShopFront, { ppr: { ttl: 300, swr: 120 } }, () => [
    loader(FeaturedLoader),
    loading(<GridSkeleton />),
  ]),
]);
```

The option projects through the group's JSON projection onto the
materialized server route, so the whole runtime engages unchanged: the
group's static markup freezes into a per-URL shell — its `useSearchParams`
read included, since search is part of shell identity — `loading()`
subtrees stay the live holes, and a HIT flushes the stored prelude in the
first bytes and hydrates with zero errors. The navigation axis works too:
soft navigations into a warmed group route serve the stored navigation
payload (`x-rango-ppr-replay: HIT`) and viewport prefetches enqueue
navigation-only captures.

#### `stream: "navigation"` loaders bake into the shell ([#817](https://github.com/ivogt/vite-rsc/pull/817))

The flag's document promise — data, handle pushes, and status in the HTML
before first flush — previously degraded silently under ppr: the loader
was masked like any live loader and its data arrived in the resume stream,
never the prelude. The capture lane is now per loader: a flagged loader
executes at capture and its SETTLED return is shell material (frozen for
the shell's lifetime, snapshot-pinned so HIT hydration agrees
byte-for-byte), while nested promises in the return stay live holes —
promise shape is the liveness declaration — and unflagged siblings stay
fully dynamic. `loading()` becomes optional when every loader on a route
is flagged: nothing masks, so the shell captures complete.

This is a behavioral change if you already use `stream: "navigation"` on a
ppr route: the loader's settled data is now frozen per shell lifetime
(govern freshness with `ppr.ttl`/`swr`/`tags`) instead of streaming fresh
into the resume. Express per-request material as a nested promise or move
it to an unflagged loader.

#### Exports-map-precise client-reference dedup in dev ([#816](https://github.com/ivogt/vite-rsc/pull/816))

Deep third-party `"use client"` imports (`lib/context`, not re-exported
from the package root) lost their symbols in dev — the dedup rewrote the
module to the bare package root. It now resolves the module's precise
public subpath through the package's `exports` map (star patterns
included, every candidate verified by resolving back to the same file),
falling back to the documented root-barrel behavior only when no public
subpath maps. Context identity dedupes correctly for non-barrel packages.

### Fixes

- `Static()` / `Prerender()` handler values inside `clientUrls()` are
  rejected with a targeted message naming the wrapper and pointing at the
  `ppr` path option — build-time handlers are server-DSL surface and
  cannot mount in a client group ([#818](https://github.com/ivogt/vite-rsc/pull/818)).
- `expose-action-id` adopts plugin-rsc's public `getPluginApi` and
  tolerates both server-reference manager shapes, failing loudly if
  neither matches ([#816](https://github.com/ivogt/vite-rsc/pull/816)).

### Dependencies

- `@vitejs/plugin-rsc` `^0.5.31` (carries the pluggable server-function
  registration API), react/react-dom peers to `19.2.8`
  ([#816](https://github.com/ivogt/vite-rsc/pull/816)).

### Internal

- New e2e surfaces: head-script `preload` mode (dedicated config, both
  apps) and deep client-package resolution, dev + production.
- The clientUrls group DSL scope is settled: shell caching is the `ppr`
  option and the `stream: "navigation"` bake lane; build-time
  prerendering stays with the server tree around the include.

## 0.6.0 (2026-07-28)

This release ships three large pieces: client route groups (`clientUrls()`),
streaming loader data with an implicitly-suspending `useLoader`, and a
reworked search-params surface with a React Router-style setter. One breaking
change: the `useSearchParams` return shape.

### Highlights

#### `clientUrls()` — client route groups with instant navigation, server authority ([#812](https://github.com/ivogt/vite-rsc/pull/812))

A new DSL for defining a group of client-rendered routes inside a single
`"use client"` module and mounting it in the server tree with `include()`:

```tsx
"use client";
import { clientUrls } from "@rangojs/router/client";

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ShopLayout, () => [
    path("/", ProductGrid, { name: "index" }),
    path("/product/:slug", ProductDetail, { name: "product" }, () => [
      loader(ProductLoader),
      loading(<DetailSkeleton />),
    ]),
  ]),
]);
```

Navigation inside a group matches locally and presents instantly, while the
server keeps authority: mount-scoped middleware and guards still run on every
group navigation, loaders execute on the server and stream in, and thrown
`notFound()`/`redirect()` from a group loader behave like route authority
signals. Groups support projected per-loader `revalidate()` predicates,
module-local `intercept()` slots, a data-only `transition()` opt-in, and
per-loader `stream: "navigation"` for SSR-complete delivery. The group DSL is
deliberately minimal — error boundaries are plain React boundaries, and
parallel routes, caching, and middleware stay in the server tree around the
mount.

The full client-hook surface is settled for groups and pinned by tests:
`useMount`, `useHref`, mount-relative `useRouter().push("cart")` (relative
paths resolve against the include mount; absolute paths stay app-absolute),
the local `useReverse(routes)` form backed by per-module generated route
maps, `useLocationState` write lanes, and the rest. The review lives in
`docs/design/client-urls-hooks-review.md`.

#### Streaming loader data and implicitly-suspending `useLoader` ([#813](https://github.com/ivogt/vite-rsc/pull/813))

Loader data no longer gates rendering at the route boundary: loaders kick off
at match time and settle during Flight serialization, and `useLoader` reads
suspend at the read site to the nearest boundary — `loading()` or an inline
`<Suspense>`. `Outlet` gained a `fallback` prop as the layout-owned pending
boundary. Under ppr, value-slot loaders are live at capture: nothing from a
loader can bake into a shared shell, so per-request data stays per-request by
construction.

#### `useSearchParams` tuple with setter, and search as first-class state ([#815](https://github.com/ivogt/vite-rsc/pull/815))

`useSearchParams` now returns a React Router-style tuple:

```tsx
const [searchParams, setSearchParams] = useSearchParams();
setSearchParams({ category: "electronics" }, { replace: true, scroll: false });
setSearchParams((prev) => {
  prev.set("page", "2");
  return prev;
});
```

The setter replaces the whole search string (React Router semantics) and
navigates same-route, so loaders re-evaluate per their `revalidate()`
contract. Around it, search became first-class across the stack:

- During document SSR the hook carries the live request's real search values,
  and the browser's first render seeds from its own URL — hydration agrees,
  and search-derived branches SSR correctly instead of flickering in.
- Same-route search navigations hold previous content through the commit
  (like actions) instead of re-streaming the `loading()` fallback — filter
  UIs stop flashing skeletons.
- On ppr routes, search is part of shell identity: the shell key already
  embeds the sorted, `cache.searchParams`-filtered search, and the capture
  and resume renders now seed that same string — so a static part may read
  search and each query-string variant gets its own correct shell.

### Breaking changes

`useSearchParams` no longer returns a bare `URLSearchParams`. Destructure the
tuple:

```tsx
// before
const params = useSearchParams();
// after
const [params, setParams] = useSearchParams();
```

There is no transitional API; the old shape is gone.

### Fixes

- `redirect(url, { state })` thrown from a loader silently dropped its
  location state — streaming loaders settle after payload metadata is
  flushed, so the state never reached the wire. The state now travels on the
  loader-result marker and merges at the redirect target, so flash messages
  survive loader redirects ([#815](https://github.com/ivogt/vite-rsc/pull/815)).
- `rango generate` silently skipped modules containing only `clientUrls()` —
  the classify sniff matched the lowercase `urls(` token, which
  `"clientUrls("` does not contain. Per-module route maps now generate for
  default-exported group modules, enabling the local `useReverse` form
  ([#815](https://github.com/ivogt/vite-rsc/pull/815)).
- `revalidate()` can no longer blank an unrendered parallel slot: the
  new-segment seed is floored so a slot that never rendered keeps its
  fallback instead of emptying ([#814](https://github.com/ivogt/vite-rsc/pull/814)).
- Removed the dev warning claiming location state "will be lost" on full-page
  SSR redirects — loader redirects now deliver state on document loads, so
  the blanket claim was wrong ([#815](https://github.com/ivogt/vite-rsc/pull/815)).

### Internal

- Bundle guards: the client boot closure (bootstrap + react + router) is
  asserted free of app code, and a production probe pins that landing on a
  group route preloads its chunk in the first HTML bytes — no
  hydration-time chunk waterfall.
- The clientUrls hook-contract settlement review
  (`docs/design/client-urls-hooks-review.md`) covers the full
  `@rangojs/router/client` export surface; every row is settled and pinned.
