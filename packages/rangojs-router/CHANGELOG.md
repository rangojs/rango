# Changelog

## 0.10.1 (2026-08-18)

Metadata and docs refresh for the public repository — no code changes
(source diffs since 0.10.0 are comment-only).

### Changed: package metadata and npm README ([#824](https://github.com/rangojs/rango/pull/824), [#830](https://github.com/rangojs/rango/pull/830))

- The published tarball now includes the MIT `LICENSE` file; 0.10.0
  declared MIT but shipped no license text.
- `repository`, `homepage`, and `bugs` point at
  <https://github.com/rangojs/rango> instead of the pre-transfer
  private repository path.
- The README frames stability as pre-1.0 semver 0.x and recommends
  `npm install @rangojs/router@latest`; the `experimental` dist-tag is
  documented as the way to track `main` between tagged releases.

## 0.10.0 (2026-08-13)

`loader(Def, { ssr: false })` now delivers its settled value in place on
document renders — the content sits at its document position, and handle
pushes land in the captured shell. A new `rango({ progressiveChunkSize })`
option controls Fizz outlining; unset, a matched flagged loader auto-raises
the budget so React does not park the awaited markup in a trailing
`<div hidden>` + `$RC()` reveal.

### Added: in-place delivery for `{ ssr: false }` loaders ([#823](https://github.com/ivogt/vite-rsc/pull/823))

Document renders await flagged loaders before first flush and hand
`useLoader` the settled result, not a fulfilled Flight thenable. Unflagged
siblings keep streaming. Shell capture bakes the same lane so title/meta
handle pushes are in the stored prelude, not only after hydration.

```tsx
path("/products/:category", ProductList, () => [
  loader(ProductListLoader, { ssr: false }), // in the SSR HTML, in place
  loader(RecommendationsLoader),             // still streams
]),
```

`loading(false)` routes get the same stamp after their pre-flush await.
Parallel slots that own `loading()` stay on the aggregate (that is what
pins the fallback); an all-flagged slot still settles to a decoded array.

### Added: `rango({ progressiveChunkSize })` and ssr:false auto-raise ([#823](https://github.com/ivogt/vite-rsc/pull/823))

The generated SSR entry forwards React Fizz's completed-boundary outlining
budget to live `renderToReadableStream` and PPR `prerender`. Resume
inherits the capture value from postponed state.

When the option is unset and the matched chain has a flagged loader,
`createSSRHandler` auto-raises to `Number.MAX_SAFE_INTEGER` so completed
content stays inline. An explicit value disables the auto-raise. Capture
never auto-raises. `Infinity` emits as `Number.POSITIVE_INFINITY` (JSON
cannot serialize it).

```ts
// vite.config.ts — pin the budget (also disables auto-raise)
rango({ progressiveChunkSize: Number.MAX_SAFE_INTEGER });
```

Custom SSR entries set `createSSRHandler({ progressiveChunkSize })` /
`createShellCaptureHandler({ progressiveChunkSize })` the same way.

No migration. Existing `{ ssr: false }` routes pick up in-place delivery
with no config; set the option only to pin or opt out of the auto-raise.

## 0.9.1 (2026-08-03)

Dev-only patch: Cloudflare dev no longer amplifies `clientUrls()`
route-shape edits into unbounded reload work. No API changes.

### Fixed: bounded HMR reload work for `clientUrls()` edits in Cloudflare dev ([#822](https://github.com/ivogt/vite-rsc/pull/822))

Editing a `clientUrls()` module's route shape in Cloudflare dev could drive
the dev server into runaway work — a large pilot app reached the V8 heap
limit and the Vite process died. Three paths were unbounded and are now
closed:

- A router generation probed for a newer discovery epoch rendered the full
  app per probe (every 25 ms). Any probed generation now answers with an
  empty response carrying its actual epoch.
- Repeat workerd reloads fired on every mismatched probe. They now use
  100 ms – 1 s exponential backoff, and stale probe response bodies are
  cancelled instead of buffered.
- The clientUrls importer invalidation restarted a full graph traversal at
  every importer (quadratic on large graphs) and ran redundantly on
  Cloudflare, whose rediscovery already invalidates wholesale. It now
  shares one traversal set and runs only where a local module runner
  exists.

Production builds are untouched — the probe header is inert there, now
pinned by e2e in both modes — and the Node dev path keeps its existing
invalidation behavior.

## 0.9.0 (2026-07-29)

One breaking change — the loader SSR-completeness opt-in is renamed to the
knob the API already had — and an SSR correctness fix for absolute-URL
`<Link>`s.

### Breaking: `loader(Def, { ssr: false })` replaces `stream: "navigation"` ([#820](https://github.com/ivogt/vite-rsc/pull/820))

```tsx
// before
loader(ProductLoader, { stream: "navigation" }),
// after
loader(ProductLoader, { ssr: false }),
```

Migration is a grep: `stream: "navigation"` → `ssr: false`. Passing the
removed option throws a targeted error naming the replacement, on both DSL
surfaces (`urls()` and `clientUrls()`).

Semantics are unchanged — this is one vocabulary, not new behavior:
`ssr: false` on a loader means the same thing it has always meant on
`loading(fallback, { ssr: false })`, read from the other end. The flagged
loader is awaited before first flush on document requests (its data, handle
pushes, and a thrown `notFound()`'s 404 status are deterministically in the
SSR'd HTML; no fallback paints for it), client navigations keep streaming it
behind the fallback, scoping stays per-loader, and under `ppr` it remains
the bake lane. `ssr: true` is accepted as the explicit default. Serialized
clientUrls projections are unaffected (the wire format did not change).

### Fixed: absolute-URL `<Link>`s hydrate cleanly; external links are external from the first byte ([#821](https://github.com/ivogt/vite-rsc/pull/821))

`Link` classified absolute URLs against `window.location.origin`; on the
server the `ReferenceError` was silently swallowed, so SSR HTML never
carried `data-external` and every absolute-URL `<Link>` was a hydration
mismatch — genuinely external links (CMS navs pointing at another site)
only became hard navigations after the client patched the attribute in.

The server now classifies against the request origin, threaded into the
SSR navigation store through the same channels as the search seeding —
document renders, ppr shell capture, and resume all agree with what the
browser will conclude. No consumer changes; deployments behind proxies
should forward `Host`/proto correctly (the same requirement redirects
already have). Build-time prerendered shells remain host-agnostic:
absolute links in their static parts keep the internal classification.

## 0.8.0 (2026-07-28)

Edge-only ppr: `CFCacheStore` no longer requires a KV namespace for shell
caching. No breaking API changes; two new store-surface additions
(`putShell`'s `"uncacheable"` result, `SegmentCacheStore.tagHistoryInert`).

### Highlights

#### Edge-only ppr — KV-less `CFCacheStore` stores shells L1-only ([#819](https://github.com/ivogt/vite-rsc/pull/819))

Previously a `CFCacheStore` without a KV binding silently disabled ppr:
`getShell`/`putShell` no-oped, the capture scheduler never rendered, and
every `ppr` route was a permanent `x-rango-shell: MISS`. Now the same
config captures and serves shells from the per-colo Cache API alone:

```ts
cache: (env, ctx) => ({
  store: new CFCacheStore({ ctx }), // no `kv` — shells are per-colo
}),
```

First request MISS + background capture, subsequent requests in that colo
HIT — the stored prelude flushes in the first bytes, `loading()` holes
stream live. Each colo warms its own shell; that is the edge-only trade
(no cross-colo KV promotion). `workers.dev`/`pages.dev` previews work too
(the store keys L1 under its internal fallback host there).

Tag eviction mirrors the data families' purge-mode stance. With
`tagPurge`, purge-by-tag evicts shell L1 entries (they already carry the
namespaced `Cache-Tag` tokens) and the per-request memo keeps
read-your-own-writes; without it, a tagged shell warns once that
invalidation cannot reach it and expires by ttl+swr. Untagged edge-only
ppr is warning-free. With KV bound, nothing changes — shells keep the
durable generation-marker check.

Three KV-less boundaries are hard, not degraded: tagged build-manifest
shells are declined outright (`SegmentCacheStore.tagHistoryInert` — the
immutable asset could never be evicted, so the route keeps
runtime-capture semantics); a tag set whose `Cache-Tag` header overflows
is acknowledged `"uncacheable"` from `putShell` and the capture scheduler
backs the key off instead of re-rendering per MISS; and
`tagInvalidationTtl` is dead config without KV — it no longer caps L1
retention and its KV-floor validation warning no longer fires.

### Internal

- New dedicated e2e config (`tests/cloudflare-basic/playwright.edge-only.config.ts`)
  boots the app with the KV binding dropped and pins MISS → capture → HIT,
  clean HIT hydration, and the tagged build-shell decline, dev + production.

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
