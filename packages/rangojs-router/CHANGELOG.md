# Changelog

## Unreleased

### Breaking: a PPR hole reads live data for a `"use cache"` entry the shell also read ([#958](https://github.com/rangojs/rango/pull/958))

When a `ppr` route's shell and one of its live holes (a loader under
`loading()` or an inline `<Suspense>`) read the same `"use cache"` entry,
a shell HIT used to hand the hole the value the capture read, so the hole
matched the shell until the shell expired. The hole now
reads the store on every HIT, like any other live read: once the entry
changes, the hole shows the new value while the shell keeps the value it was
captured with. Nothing changes for a route with its own `cache()` scope, a
store with a `keyGenerator`, a route whose handlers re-run on a HIT (a
handler that calls `ctx.use()` on a loader), or an entry an `ssr: false`
loader also reads: those keep the captured value for the hole too.

```tsx
async function getStock(sku: string) {
  "use cache: short"; // ttl 60
  return fetchStock(sku);
}
// The layout (shell) and the loader under loading() (hole) both read it.
// Before: after the entry refreshed, the hole still showed the captured stock.
// After: the hole shows the refreshed stock; the shell keeps the captured one.
```

Migration: if the hole must show the shell's value, pass it down from the
shell (a prop, or a handle the hole reads) instead of reading the entry again
in the live loader.

### A PPR shell entry stores only what a HIT reads ([#958](https://github.com/rangojs/rango/pull/958))

A shell entry's capture snapshot held every cache read the capture made. When
every HIT replays the handlers' output from the captured segment record, the
`"use cache"` items the handlers read to produce it are never read again; the
capture no longer stores them. A navigation-only entry (captured for partial
navigations) stores only its segment records. On `tests/cloudflare-basic`
`/ppr-large` the stored entry went from 3,272,863 to 1,647,811 bytes (snapshot
2,643,864 to 1,018,799), which a HIT reads and parses after its first byte. In
dev the same snapshot was 16,960,162 bytes, over the 8 MiB `maxSnapshotBytes`
cap, so it was not stored at all; it now is (1,374,662 bytes). Under
`debugPerformance` the `shell tail` line and `ppr-tail` row show what was
dropped next to what was kept (`records=segment:1 pruned=item:5`).

### Added: a per-isolate PPR shell memo in `CFCacheStore` and `VercelCacheStore` ([#959](https://github.com/rangojs/rango/pull/959))

A warm isolate serving the same PPR shell repeatedly re-read and re-parsed the
stored entry on every HIT. Both stores now keep the last fresh read of each
shell for `memo.shellMs` (default 2000; `{ shellMs: 0 }` turns it off) under a
`memo.shellMaxBytes` cap (default 16 MiB, least recently used evicted), and
serve the next HITs from memory. On a storefront-sized shell a `CFCacheStore`
memo hit's first byte is 0.2 ms instead of 8.3 ms (untagged) and 10.2 ms
instead of 17.3 ms (tagged) with Cloudflare's measured I/O latencies injected;
a `VercelCacheStore` memo hit is 0.1 ms instead of 10.8 ms and 6.9 ms instead
of 17.9 ms with a 6 ms runtime-cache read modeled. Under `debugPerformance`
both stores report the read as `ppr:shell-read (hit memo)` with a
`ppr:shell-memo` row (hit or miss, and the memo's size), and a
`VercelCacheStore` HIT now reports its store read and tag-marker read too.
`VercelCacheReadOutcome`, the outcome the `VercelCacheStore` `debug` option
receives, gains `"memo-hit"`.

The tag-marker check still runs on every HIT, and the isolate that runs
`updateTag()`/`revalidateTag()` drops its own memoized copies, so neither that
request nor a later one on the same isolate gets the invalidated shell. With
KV bound, a `CFCacheStore` memo in any isolate rejects it on the next request.
What another isolate can still serve for up to one window: the previous
capture of a key another isolate just recaptured; for `CFCacheStore` without
KV in purge mode, a purged shell (the purge reaches the stored entry, not
other isolates' memos), the mutating user's next request included when it
lands on another isolate; for `VercelCacheStore`, a shell invalidated from
another region (the tag markers are a regional `cache.set`; without the memo,
`expireTag` removed the entry everywhere within about 300 ms) or by a platform
`expireTag` issued outside rango. A purge-mode app that needs the mutating
user's next request to read its own write sets `{ shellMs: 0 }`.
`VercelCacheStore` keeps one memo per `cache` handle: create the
`getCache()` handle once per process, as the updated examples do, or the
memo never hits.

### Added: a PPR shell HIT broken into `debugPerformance` rows ([#955](https://github.com/rangojs/rango/pull/955))

Under `debugPerformance`, a PPR shell HIT reported one `ppr:shell-read` row.
With `CFCacheStore`, that read is now broken into `ppr:shell-match`,
`ppr:shell-head` and `ppr:shell-prelude` (with byte counts),
`ppr:shell-marker` (the tag-marker read and how long the commit waited on it),
and, for a KV hit after a Cache API miss, a `ppr:shell-l1-miss` row first.
Every store then shows `ppr:shell-open` (the integrity check and decode) and
`ppr:shell-commit` (chunk count and prelude bytes), both labelled `cpu`. The
work after the commit (snapshot read and parse, seed, tail) prints as one
`[RSC Perf] … shell tail:` line with snapshot bytes, records per family, and
CPU durations, and rides the next request's `Server-Timing` as `ppr-tail`, now
in production too when the HIT collected metrics. In production, nothing is
collected when `debugPerformance` is off.

### Fixes

- A PPR shell HIT whose capture snapshot is already in memory
  (`MemorySegmentCacheStore`, build-time shells, the new shell memo) no longer
  starts the resumed tail's work before the prelude is written: the tail waits
  one macrotask after the commit when the snapshot had already arrived (one
  still arriving on I/O yields on its own). With the shell memo on local
  workerd, a storefront-sized HIT's first byte over a trivial response went
  from 5.9 ms to 1.3 ms ([#959](https://github.com/rangojs/rango/pull/959)).
- A PPR shell HIT whose captured segment record fails to decode now schedules
  a recapture. The HIT reports `cache-corrupt` and re-renders the handlers;
  before, nothing replaced the entry, so every HIT repeated that re-render
  until the shell expired ([#958](https://github.com/rangojs/rango/pull/958)).
- A PPR shell capture no longer gives up while a client component in the
  shell is still loading its module. The capture aborted a fixed number of
  task turns after the page payload arrived, and a client component outside
  any Suspense boundary could still be loading then, so the attempt stored
  nothing and retried 400 ms later: about 400 ms more per `Prerender` + `ppr`
  URL that loaded a client module first (with `DEBUG=rango:prerender`,
  `vite build` logs `shell capture attempt 1/2 for <url> produced no shell`). On
  `tests/cloudflare-basic`, `/ppr-shell/prerendered/alpha` went from 495-501 ms
  to 112-119 ms, `/ppr-shell/passthrough/baked` from 447-452 ms to 38-39 ms, and
  the shell phase from 1329-1366 ms to 552-584 ms. A runtime capture in a cold
  isolate had the same race. Once its payload settles, the capture now waits,
  within `ppr.captureTimeout`, for the client module loads in flight in the
  isolate, including loads another render requested; live loaders
  and promises passed down from the server still postpone as holes
  ([#954](https://github.com/rangojs/rango/pull/954)).
- A `vite build` that rewrote a router's `named-routes.gen.ts` (the first
  build after adding, renaming or removing a route, or any build that found
  the file out of date) could skip every build-time PPR shell. The build-time
  server that runs route discovery and the shell phase watched the project,
  so the rewrite could reload its modules (when the router file's importers
  end at an entry nothing imports, as in a Cloudflare `worker.rsc.tsx`) and
  drop the route trie discovery had installed; the shell phase then matched
  each `Prerender` + `ppr` URL in declaration order. A wildcard such as
  `path("/*")` declared before the route won, every candidate logged
  `SHELL SKIP <url> - no router matched "<route>" (matched: <wildcard route>, ...)`,
  and the routes fell back to capturing the shell on the first request after
  deploy. The next build, with the file up to date, captured them. That
  server no longer watches files
  ([#951](https://github.com/rangojs/rango/pull/951)).
- A PPR shell HIT decodes its stored prelude once instead of twice, with the
  runtime's native `Uint8Array.fromBase64` where it exists (workerd: 0.05 ms
  instead of 0.75 ms per decode of a 614 KB prelude), and enqueues it in 32 KB
  chunks instead of one write. A streaming compressor handed one write
  compresses all of it before its first output byte; with 32 KB chunks, Node's
  zlib and workerd's `CompressionStream` emit their first bytes after one
  chunk (measured locally; Cloudflare's edge compressor was not measured).
  Partial navigation replay no longer decodes the document prelude it never
  serves. The no-shell warning names an async server component rendered
  without awaiting its data as a cause, and in dev it prints the component
  stacks still pending when the capture froze the shell
  ([#952](https://github.com/rangojs/rango/pull/952)).
- `CFCacheStore` stores a PPR shell prelude-first: a head, the raw prelude
  (no base64), then the capture snapshot, in both the Cache API and KV. A
  shell HIT reads the head and the prelude, runs the tag-marker read alongside
  the prelude read, and sends its first byte while the snapshot is still being
  read; only the resumed tail waits for it. On a storefront-sized shell (614 KB
  prelude, 2.5 MB snapshot) the first byte moved from 13.2 ms to 3.6 ms over a
  trivial response on local workerd, and from 21.0 ms to 8.3 ms (29.8 ms to
  17.5 ms when tagged) with Cloudflare's measured I/O latencies injected. The
  public `getShell`/`putShell` contract is unchanged. Shells move to a new key
  namespace; existing entries are already misses after a deploy (buildVersion)
  and age out. One failure mode changes: a truncated, corrupt, or slow
  (over `kvReadTimeoutMs`) snapshot used to make the read a MISS; it is now a
  HIT whose resumed tail runs without the snapshot's pins, and a truncated or
  corrupt entry is also evicted so the next request recaptures
  ([#953](https://github.com/rangojs/rango/pull/953)).

## 0.17.0 (2026-09-28)

### The default document restores scroll on back/forward ([#948](https://github.com/rangojs/rango/pull/948))

An app that passes no `document` to `createRouter` now gets
`<Html.ScrollRestoration />` from the router's default document, next to the
`Html.Meta` and `Html.Scripts` it already rendered. Back and forward return to
the scroll position each page was left at, saved per history entry in
`sessionStorage`, and the router sets `history.scrollRestoration = "manual"`.
New navigations still scroll to the top or the hash target.

To keep the browser's own back/forward scrolling, or to pass `getKey`, provide
your own `document`. With the default document, a second
`<Html.ScrollRestoration />` in a layout only logs
`[Scroll] Already initialized`.

### Back/forward scroll is left to the browser when it owns restoration ([#923](https://github.com/rangojs/rango/pull/923))

With a custom `document` that doesn't render `<Html.ScrollRestoration>`, the
browser restores back/forward scroll itself, but the router also called
`scrollTo(0, 0)` after every `popstate`. When the browser restored first, the
router's call won and back landed at the top of the page (reported in mobile
Safari). The router no longer scrolls on back/forward for an entry whose
`history.scrollRestoration` is `"auto"`. That also covers entries created
before `<Html.ScrollRestoration>` mounted. A bfcache restore no longer switches
`scrollRestoration` to `"manual"` in apps that never mounted
`<Html.ScrollRestoration>`, so the browser keeps restoring there too.

### Breaking: the document components move under `Html` ([#937](https://github.com/rangojs/rango/pull/937))

`MetaTags`, `Scripts` and `ScrollRestoration` are replaced by one namespace
exported from `@rangojs/router/client`: `Html.Meta`, `Html.Scripts` and
`Html.ScrollRestoration`, with the same props. The old component exports are
removed, with no aliases.

```tsx
// before
import { MetaTags, Scripts, ScrollRestoration } from "@rangojs/router/client";
<head><MetaTags /><Scripts /></head>
<body><Scripts position="body" />{children}<ScrollRestoration /></body>

// after
import { Html } from "@rangojs/router/client";
<head><Html.Meta /><Html.Scripts /></head>
<body><Html.Scripts position="body" />{children}<Html.ScrollRestoration /></body>
```

A server root layout can render `<Html.Meta />` as well as a client document,
and an app that never renders `<Html.ScrollRestoration />` does not bundle it.
The script renderer's dev warnings are now prefixed `[Html.Scripts]`.
`useScrollRestoration`, `ScrollRestorationProps`, the `Meta`, `Script` and
`Breadcrumbs` handles, and `ThemeScript` are unchanged.

### Back/forward keeps an entry's location state and scroll position ([#943](https://github.com/rangojs/rango/pull/943))

Going back to an entry the router's history cache no longer holds (it keeps 20
entries; also after a deploy or a cross-tab cache clear) refetches the page.
That refetch used to replace the entry's `history.state`, so
`useLocationState()` returned `undefined` for an entry that had state, and with
`<Html.ScrollRestoration>` the entry's saved scroll position was lost. It also saved
the page being left under the returning entry's key. The entry's history state
is now kept as the browser restored it, with any server-set state merged in.

With `<Html.ScrollRestoration>`, back and forward now also save the scroll position
of the page being left, so forward to a page you scrolled and then left with
back returns to where you were instead of the top.

### Breaking: `intercept()` `use()` rejects items an intercept never applies ([#872](https://github.com/rangojs/rango/pull/872), [#879](https://github.com/rangojs/rango/pull/879))

An intercept's `use()`, and the `.use` of a handler mounted with
`intercept()`, now throw at definition time for `revalidate()`,
`errorBoundary()`, `notFoundBoundary()`, `cache()`, `parallel()`,
`intercept()`, `include()`, and a `layout()` with `use()` items of its own. A
rejected helper that is called but not returned throws too. The error names
the intercept and says where the item goes. `middleware()`, `loader()` (which
keeps its own `revalidate()` and `cache()`), `loading()`, `transition()`, route
items, and a `layout()` used as modal chrome stay valid.

In 0.16.0 these items were dropped or misplaced without an error:

- `revalidate()`, `errorBoundary()` and `notFoundBoundary()` were stored on
  the intercept and never read, from the explicit `use()` and from the
  handler's `.use` alike.
- A nested `layout()`'s own `use()` items were dropped.
- `parallel()` and `intercept()` in an explicit `use()` registered on the
  enclosing layout.

`InterceptUseItem` no longer includes `revalidate()`, `errorBoundary()` or
`notFoundBoundary()`, so a typed explicit `use()` fails to compile with them.
A handler's `.use` is typed for every mount site, so there the check is
runtime only: a handler mounted with both `path()` and `intercept()` whose
`.use` returns `errorBoundary()` still works on the `path()` mount, but route
registration (`router.routes()`) now throws at startup.

Migration: put boundaries on the layout or path that declares the intercept
(its boundaries handle the intercept's handler and loader errors, see #878
below), `revalidate()` on the intercept's loader, and `cache()` on the target
route. For a handler shared between `path()` and `intercept()`, move the
boundaries out of its `.use` into the `path()` call's own `use()`.

```tsx
// before: throws at definition time
intercept("@modal", "product", <ProductModal />, () => [
  loader(ProductLoader),
  errorBoundary(<ModalError />),
]),
// after
layout(<ShopLayout />, () => [
  errorBoundary(<ShopError />),
  intercept("@modal", "product", <ProductModal />, () => [
    loader(ProductLoader),
  ]),
]),
```

### Breaking: `ctx.reverse` in middleware and response routes is typed global-only ([#873](https://github.com/rangojs/rango/pull/873))

`MiddlewareContext["reverse"]` and `ResponseHandlerContext["reverse"]` are now
the new exported `GlobalReverseFunction`. Both are built from the route map
alone at runtime, with no `include()` scope and no param auto-fill, so a
dot-local `ctx.reverse(".name")` always threw `Unknown route` on the request;
it is now a compile error. Response routes also lose a permissive fallback:
when no route in the generated map had a `search` schema, 0.16.0 typed their
reverse as `(name: string, ...)`, so an unknown name, a name held in a
`string`, or a call missing required params compiled. With a generated map
these are now checked against it, as middleware reverse already was. Without
a generated map, any name except a dot-prefixed literal is accepted. Runtime
behavior is unchanged. Pass the fully qualified name and every param.

### Breaking: a component that throws while a route is prerendered fails the build ([#917](https://github.com/rangojs/rango/pull/917))

A `Prerender()` route or `Static()` handler could return normally while its
tree held a component that threw during the build-time render, such as an
async server component whose fetch failed. Flight encoded that component as an
error row, the build logged `OK`, and the route served its error boundary
until the next build. The error now takes the same path as a handler throw:

- `prerender.onError: "fail"` (the default) fails the build and names the URL
  and the error.
- `"warn"` logs `WARN` and skips the URL.
- A `Skip` thrown by the component skips the URL.
- The router's `onError` receives it with phase `"prerender"` or `"static"`.

Intercept variants and handle values are checked the same way. In dev, the
`/__rsc_prerender` endpoint falls through to a live render for such a route
instead of serving a payload that holds the error row.

Migration: a build that passed with such a route now fails. Fix the component,
`throw new Skip()` for URLs that cannot render at build time, or set
`rango({ prerender: { onError: "warn" } })` to skip them.

### Breaking: a `middleware()` wrapper with no routes inside rejects `layout()` ([#922](https://github.com/rangojs/rango/pull/922))

`middleware(fn, () => [layout(...)])` with no route inside the callback now
throws when `router.routes()` runs, in a path's children and in a layout's
children alike. In 0.16.0 the nested `layout()` never rendered, while the
middleware ran for every route of the enclosing path or layout: a wrapper with
no routes scopes nothing. The error points to the flat form, which renders the
layout and runs the middleware for the same routes. A wrapper with routes
inside may still hold a `layout()`, and a routeless wrapper without one
(`middleware(fn, () => [loader(L)])`) is unchanged.

```tsx
// before: AccountNav never rendered; now throws at definition time
path("/account", AccountPage, { name: "account" }, () => [
  middleware(requireAuth, () => [layout(<AccountNav />)]),
]),
// after
path("/account", AccountPage, { name: "account" }, () => [
  middleware(requireAuth),
  layout(<AccountNav />),
]),
```

### Breaking: a `"use cache"` function that reads a `{ cache: false }` variable throws ([#935](https://github.com/rangojs/rango/pull/935))

`ctx.get()` of a `createVar({ cache: false })` variable, or of a value written
with `ctx.set(key, value, { cache: false })`, now throws inside a `"use cache"`
function, as it already did inside a `cache()` boundary. It throws whether the
read goes through `getRequestContext().get()`, a handler ctx or a response-route
ctx passed in. In 0.16.0 the read returned the value, the result was stored
under a key that did not include it, and later callers were served the first
caller's value until the entry expired. Ordinary variables stay readable. A
loader body the cached function consumes with `await ctx.use(Loader)` stays
exempt, as under `cache()`; a `"use cache"` function called from a loader does
not.

Migration: read the value before calling the cached function and pass it in as
an argument, so it becomes part of the cache key.

```ts
const Tenant = createVar<string>({ cache: false });

// before: the first tenant's nav was served to every tenant; now throws
async function getNav() {
  "use cache";
  return loadNav(getRequestContext().get(Tenant));
}
// after
async function getNav(tenant: string) {
  "use cache";
  return loadNav(tenant);
}
const nav = await getNav(ctx.get(Tenant)!);
```

### Breaking: `"use cache"` runs a call uncached when an argument cannot be serialized ([#934](https://github.com/rangojs/rango/pull/934))

A `"use cache"` function that took a `Request` served the first caller's
result to every later caller. The key encoder writes the same placeholder,
`"$T"`, for any value it cannot serialize, so
`getPage(new Request("https://a.example/"), "/")` and
`getPage(new Request("https://b.example/"), "/")` shared one entry. Functions,
class instances and symbols, top-level or nested, collided the same way. Now:

- A `Request` (such as `ctx.request`) keys by its URL: host, pathname and the
  user-facing search params, normalized as for `ctx`. Headers and cookies are
  not in the key.
- The request's `env` is left out of the key.
- React elements (`header`/`children` slots) and client or server references
  stay out of the key and the call stays cached, as before.
- Any other argument that cannot be serialized runs the call uncached and
  warns once per function in dev.

A call that passed a binding such as `env.DB`, a callback or a class instance
was cached in 0.16.0 and now runs every time. Pass `env`, or the serializable
values the function needs:

```ts
// before: keyed by id alone, whichever db was passed; now runs uncached
async function getProduct(db: D1Database, id: string) {
  "use cache";
  return db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
}
// after
async function getProduct(env: Env, id: string) {
  "use cache";
  return env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
}
```

### Breaking: a loader or middleware `ctx` passed to `"use cache"` is keyed and guarded like a handler `ctx` ([#946](https://github.com/rangojs/rango/pull/946))

A fetchable loader called with a request body shared one `"use cache"` entry
across every body. Its ctx is marked request-scoped, so a `"use cache"`
function taking it was keyed by route, params and search, never the body: in
0.16.0 two users' `load({ method: "POST", body })` calls with different bodies
got the first caller's result. A ctx carrying a `body` or form data now runs
the call uncached and warns in dev.

The loader ctx (`getProduct(ctx)` inside a loader) and the middleware ctx were
not marked request-scoped. In 0.16.0 a `"use cache"` call taking one was keyed
by the ctx's plain fields as the Flight encoder serialized them: the full URL
including internal `_rsc*` parameters (so a document load and a client
navigation of the same page used separate entries), pathname, params and the
env's plain values, but not the route name. Its `ctx.use(Handle)` pushes were
not recorded, so they were missing on every hit, and nothing guarded
`{ cache: false }` reads or middleware writes. They now behave like a handler
ctx:

- The ctx is left out of the key and its route fields are folded in: host,
  route name, pathname, params and search (a loader ctx also carries the
  response type). A loader ctx keys exactly like the handler ctx of the same
  request. A middleware ctx has a route name only once the route is matched.
- A loader ctx's `ctx.use(Handle)` pushes are captured on a miss and replayed
  on a hit into the loader's segment, once per request, as for a handler ctx.
- `ctx.get()` of a `{ cache: false }` variable through either ctx throws
  inside the function. A loader body the function consumes with
  `await ctx.use(Loader)` stays exempt.
- A middleware ctx's `set()`, `header()` and `ctx.headers` writes throw inside
  the function; their effect would be lost on a hit.

Request headers and cookies are not in the key, as with a handler ctx: a
function that reads them through `ctx.request` gets one entry per route. Read
those values outside and pass them in.

```ts
async function getProduct(ctx: { params: { id: string } }) {
  "use cache";
  ctx.use(Breadcrumbs)({ label: "Product" });
  return db.product(ctx.params.id);
}
export const ProductLoader = createLoader(async (ctx) => getProduct(ctx));
// before (0.16.0): keyed by the raw URL, so a navigation missed the entry the
// document load wrote, and the crumb was missing on every hit
// after: one entry per route, id and query; the crumb is replayed on a hit
```

### Added: `router.debugManifest()` on the public `Rango` type ([#874](https://github.com/rangojs/rango/pull/874))

`debugManifest()` was typed only on the internal router interface, so calling
it needed a cast. It is now on `Rango`, and its return type
`SerializedManifest` is exported from `@rangojs/router`. It also threw
`Duplicate route name` for any router that uses `include()`, because lazy
include placeholders carried the parent `urls()` handler and re-registered its
routes. Placeholders are now skipped, so routes mounted with `include()` are
absent from the result.

### Added: per-navigation loader seeds and held navigations in `renderRoute()` ([#893](https://github.com/rangojs/rango/pull/893))

`renderRoute().navigate()` from `@rangojs/router/testing/dom` committed
urgently and took no per-navigation data, so the 0.16.0 `useLoader().isLoading`
stale state could only be tested in e2e. `navigate(url, { loaders })` now takes
loader seeds for that navigation, merged over the render-time seeds, and a spec
with `transition` (`{}` mirrors a bare `transition()`) commits the navigation
through production's transition path. A reader held on screen then reports
`isLoading: true` on the old data while a pending Promise seed is unsettled,
and `false` with the new data in the commit that settles it:

```tsx
const { router } = await renderRoute(
  [{ path: "/products/:id", Component: ProductPrice, transition: {} }],
  { request: "/products/1", loaders: [[ProductLoader, { price: 10 }]] },
);
await router.navigate("/products/2", { loaders: [[ProductLoader, next]] });
// ProductPrice: isLoading true with price 10 until `next` settles
```

Without `transition`, the commit stays urgent and a pending read suspends to
its `<Suspense>` fallback. `useNavigation().state`, `useLinkStatus().pending`
and `useAction().state` stay `idle`, and production's same-structure hold
without `transition()` is not modeled.

### Fixes

- An intercept handler that throws or calls `notFound()` no longer fails the
  soft navigation with a 500 that bypasses every boundary. The modal slot
  renders the `errorBoundary()` / `notFoundBoundary()` of the layout or path
  that declares the intercept (or the nearest ancestor with one), with a
  500 / 404 status, as intercept loader errors already did. A thrown
  `Response` (`redirect()`) still short-circuits; an async handler under
  `loading()` still streams its rejection and is now reported to `onError`
  ([#878](https://github.com/rangojs/rango/pull/878)).
- A loader with its own `cache()` (`loader(Def, () => [cache()])`) skips its
  body on a hit, so the body's `ctx.use(Handle)` pushes (Meta title,
  breadcrumbs) were missing on every hit. The miss now records the pushes of
  the body and of loaders it awaits through `ctx.use`, and every hit, stale
  included, appends them to the owning segment. A stale revalidation's fresh
  pushes go only into the refreshed entry
  ([#877](https://github.com/rangojs/rango/pull/877)).
- A route under `cache()` recorded every handle push of its segments,
  including pushes from DSL `loader()` bodies. On a hit the record was
  replayed and the loader re-ran and pushed again, so a handle without
  key-based dedupe showed the value twice. DSL-loader pushes are now left out
  of the `cache()` record; handler pushes and pushes from a handler's
  `ctx.use(Loader)` are still recorded
  ([#880](https://github.com/rangojs/rango/pull/880)).
- A `"use cache"` hit replaced the calling segment's handle arrays, wiping the
  handler's earlier pushes and concurrent loader pushes, and the miss recorded
  every push made while the body ran. Each execution now records only its own
  pushes (nested cached functions roll up into the caller), and a hit appends
  them. A layout and a page calling the same cached function each keep their
  copy, and a stale hit's background refresh no longer leaks its pushes into
  the live response ([#882](https://github.com/rangojs/rango/pull/882)).
- The stale-route refresh and proactive caching swapped the request's handle
  store for a fresh one while they re-rendered in the background. The
  foreground was still producing the page (a stale hit re-runs its loaders;
  proactive caching starts while the body streams), so handle pushes made in
  that window went into the background render and were missing from the page.
  Both now render on a derived request context with its own store.
  `RequestContext._handleStore`, an `@internal` field typed through
  `getRequestContext()` from `@rangojs/router/rsc`, is now `readonly`
  ([#883](https://github.com/rangojs/rango/pull/883)).
- Intercept loaders honour the loader's own `cache()`:
  `intercept(..., () => [loader(Def, () => [cache()])])` re-ran the loader on
  every intercept navigation. A handler's `ctx.use(Loader)` stays a live read
  memoized per request; `cache()` belongs to the DSL `loader()` binding
  ([#884](https://github.com/rangojs/rango/pull/884)).
- Build-time PPR shell capture passed global and route middleware a
  `ctx.reverse` scoped to the previewed route (`include()` scope, param
  auto-fill), while live requests pass the global-only map reverse, so a
  `.name` call resolved at build and threw `Unknown route` live. Build capture
  now uses the same global-only reverse
  ([#876](https://github.com/rangojs/rango/pull/876)).
- PPR capture warnings (bake cost, no usable shell, identity refusal, rejected
  or redirecting loader) and the `cookies()`/`headers()` capture error still
  advised `loading()` or nested promises. They now state the lane rule: only
  `loader(Def, { ssr: false })` executes at capture, and every other loader is
  live and needs `loading()` or an inline `<Suspense>` above its reader
  ([#871](https://github.com/rangojs/rango/pull/871)).
- `import type { LoaderOptions } from "@rangojs/router"` failed for installed
  consumers: the root `types` condition resolves to the `react-server` entry,
  which did not export it ([#870](https://github.com/rangojs/rango/pull/870)).
- A layout above a `cache()` boundary was stored in the route's cache entry and
  replayed on every hit: it ran 0 times, its output was the miss render's, and
  a header it wrote was missing from every hit. The entry now holds only the
  boundary's subtree, and a hit renders the segments above the boundary on
  every request, document and partial alike, as the `cache()` docs describe.
  A `ppr` route keeps whole-chain coverage: its chain bakes into the shell
  ([#911](https://github.com/rangojs/rango/pull/911)).
- A `cache()` among a path's children, as in
  `path("/p", Page, { name: "p" }, () => [cache({ ttl: 60 }), layout(<Chrome />)])`,
  cached nothing, and a `layout()` declared after it never rendered. It now
  caches that path: the handler and the path's own layouts and parallels are
  stored and replayed, and everything above the path stays live. The same form
  caches a response route (`path.json(..., () => [cache({ ttl })])`), and
  `cache(false)` there opts the path out of an enclosing `cache()`. The path's
  handler now runs under the `cache()` guards, so a header write or a
  `cookies()` read in it throws
  ([#919](https://github.com/rangojs/rango/pull/919)).
- An async intercept handler that rejected while the intercept's async
  `layout()` or one of its loaders was still pending raised an
  `unhandledRejection`, which under Node's default
  `--unhandled-rejections=throw` can crash the process. The modal slot still
  renders the declaring layout's `errorBoundary()` with a 500, and the
  rejection is now handled ([#899](https://github.com/rangojs/rango/pull/899)).
- An intercept declared in a layout with no routes of its own ignored its
  ancestors' `errorBoundary()` and `notFoundBoundary()`: a handler throw or
  `notFound()` rendered the default "Internal Server Error" / "Not Found"
  fallback, and a loader error rendered no fallback. The boundary lookup now
  continues from the routeless layout to the layout that holds it and that
  layout's ancestors, which also gives the routeless layout's own loaders a
  boundary. A boundary on the routeless layout itself still wins, and the
  status stays 500 / 404 ([#903](https://github.com/rangojs/rango/pull/903)).
- A loader with its own `cache()` replays the handle pushes of the loaders it
  awaits through `ctx.use` (#877 above). When a sibling DSL loader or the
  handler also read that dependency, the dependency still ran live on a hit,
  so its push appeared twice (a crumb without `href`, or any handle that does
  not dedupe); on a stale hit the background refresh took the dependency's
  only run and the push could be missing. Each dependency's pushes now reach
  the page once per request: if the dependency runs live after the replay, its
  live value replaces the replayed one in place; if it ran first, the replay
  skips it. A replacement that lands after the document's handle snapshot
  reaches the client after hydration, like any late loader push. 0.16.0
  showed one push; this was a regression from #877
  ([#905](https://github.com/rangojs/rango/pull/905)).
- A `"use cache"` function records the handle pushes of loaders it reads
  through `ctx.use`. When the handler or a DSL loader also read that loader,
  a hit appended the recorded push and the loader ran live too, so the push
  showed twice (a crumb without `href`, or any handle that does not dedupe).
  On a stale hit the background refresh took the loader's only run, so the
  page kept the stale push. Each loader's pushes now reach the page once per
  request, as with a loader's own `cache()` (#905 above): a live run after
  the hit replaces the replayed value in place, a run before it makes the hit
  skip it, and a loader read only inside the function is replayed once. The
  function's own pushes replay as before. An entry written before this change
  does not record which loader pushed, so it replays in full, and still shows
  such a push twice, until it expires or its stale refresh rewrites it. This
  had happened since 0.16.0 ([#938](https://github.com/rangojs/rango/pull/938)).
- On a `ppr` route, a string, number or boolean handle value pushed during the
  shell capture by a loader that an `ssr: false` loader awaits through
  `ctx.use()`, or replayed from an `ssr: false` loader's own `cache()`, was
  recorded into the shell. A hit that replays the record ran that loader again,
  so `useHandle` returned the value twice and hydration did not match the
  prelude, which showed it once. These pushes are now left out of the record,
  as object values already were. An `ssr: false` loader's own settled pushes
  are still recorded (#875 above)
  ([#895](https://github.com/rangojs/rango/pull/895)).
- The stale-route refresh and proactive caching appended the re-render's
  `transition({ when })` predicates to the live request. When the refresh got
  there before the response's transition gate ran, the gate evaluated the
  predicate on the stale hit, where values set by the cached handler with
  `ctx.set()` are missing, so the stored transition could be dropped and the
  navigation streamed its `loading()` fallback instead of holding. With
  `debugPerformance`, a loader called from a handler during the refresh also
  showed up in the stale response's Server-Timing. Both background lanes now
  keep their own predicate list and record no metrics; a stale hit always
  replays its stored transition
  ([#892](https://github.com/rangojs/rango/pull/892)).
- The stale-route refresh and proactive caching wrote to the live request's
  response: `header()`, `setCookie()` / `deleteCookie()`, `setStatus()`
  (including the 500 or 404 an error or not-found boundary sets) and
  `onResponse()` callbacks. Depending on timing, a stale hit could go out with
  a header, a `Set-Cookie` or an `onResponse` transform from the refresh, or
  with status 500 when the refresh's handler threw. The background render now
  writes to a throwaway response that is never merged, so a stale hit matches
  a fresh hit. Writes inside the `cache()` boundary still throw in the
  refresh, as on a miss ([#901](https://github.com/rangojs/rango/pull/901)).
- A stale-route refresh whose handler threw or called `notFound()` wrote its
  error or not-found boundary render over the stale entry with a fresh `ttl`,
  so every hit served the error page until the entry expired or a later
  refresh succeeded. A background render that ends with a non-200 status is
  no longer written, as a miss never stores one: the stale entry keeps
  serving, and the next stale read after the store's revalidation marker
  lapses (30 s in `CFCacheStore` and `VercelCacheStore`) refreshes again.
  Proactive caching follows the same rule
  ([#904](https://github.com/rangojs/rango/pull/904)).
- A route under `cache()` whose handler resolved but whose tree held an async
  server component that threw during the cache write was stored with a Flight
  error row, and every hit rendered the error boundary until the entry
  expired, even after the upstream recovered. Flight reports such a throw
  through `onError` and completes, and the status stays 200, so the non-200
  gate did not see it. The entry is now not written, and the skipped write is
  reported to `onError` with phase `"cache"` and category `"cache-write"`. The
  next request renders fresh; on a stale-hit refresh the stale entry keeps
  serving ([#910](https://github.com/rangojs/rango/pull/910)).
- The same rule now covers a `"use cache"` result, a loader's own `cache()`
  value, and the handle values recorded with any of these or with a route
  `cache()`. A value holding an async component that threw or a promise that
  rejected was stored with an error row, so every hit rendered the error
  boundary or the replayed handle promise rejected (React error #441). The
  entry is now not written, and the failure is reported as `cache-write` on a
  miss or `stale-revalidation` on a stale refresh, which keeps the stale entry.
  A handle value that fails to encode refuses the whole entry, since a hit
  without its handle record would serve a page missing its title or
  breadcrumbs. A deterministic non-serializable value (a function or class
  instance) was stored and then failed to decode on every hit; it is now
  reported as `cache-write` on each miss and never stored
  ([#916](https://github.com/rangojs/rango/pull/916)).
- The document cache (`createDocumentCacheMiddleware`, `s-maxage`) and the PPR
  shell capture stored a render in which a component threw after the response
  started streaming, such as an async server component whose fetch failed, or
  a client component that threw during SSR inside `<Suspense>`. Flight and
  Fizz report such an error through `onError` and finish with an error row or
  an errored Suspense boundary, the status stays 200, and every hit served the
  error until the TTL expired. The document cache now skips the write
  (`cache-write`), and a stale refresh that errors keeps the stale entry; the
  shell capture stores nothing and backs the key off. The current response is
  unchanged. A Flight error the router already reported as `"rendering"` is
  not reported again, so the skip shows only as a `[DocumentCache]` or
  `[ShellCache]` log line. A loader error behind `loading()` never reaches
  `onError`, so that render is still stored. `renderHTML` now logs Fizz errors
  with `console.error(error)`, without React's dev "[Server]" badge
  ([#920](https://github.com/rangojs/rango/pull/920)).
- A `layout()` after a bare `cache()` in a layout's children, as in
  `layout(<AppShell />, () => [path("/a", A, { name: "a" }), cache({ ttl: 60 }), layout(<PromoBanner />)])`,
  never rendered on the routes before the `cache()`. It now wraps every route
  of the layout, as it does without the `cache()`: live on the routes before
  the `cache()`, cached with the routes after it. On a route after the
  `cache()`, a `parallel()` after it no longer runs twice on a miss and once,
  discarded, on a hit, and a `middleware()` after it no longer runs twice.
  Routeless entries nested in a routeless entry, such as a `layout()` in a
  `cache(o, () => [...])` or `transition(cfg, () => [...])` with no routes,
  render too ([#922](https://github.com/rangojs/rango/pull/922)).
- A `cache()` inside a routeless `layout()`, `middleware()` or `transition()`
  wrapper in a path, as in
  `path("/p", Page, { name: "p" }, () => [layout(<Chrome />, () => [cache({ ttl: 300 })])])`,
  cached nothing. It now caches that path, like a `cache()` among the path's
  own children (#919), and the path's handler runs under the `cache()` guards
  ([#922](https://github.com/rangojs/rango/pull/922)).
- A GET for a page with `?__prerender_collect` in its URL returned the route's
  serialized segments, handle data, route name and params as
  `application/json` instead of the page, in production as well as dev, and
  skipped SSR and PPR shell serving. Nothing has sent that parameter since
  prerendering moved to `matchForPrerender`, so the handler is removed. Such a
  request now renders the page like any other, and `__prerender_collect` is no
  longer excluded from cache keys
  ([#931](https://github.com/rangojs/rango/pull/931)).
- A PPR shell could be stored with a Flight error row in the snapshot record
  of an `ssr: false` loader, and every shell hit seeded the loader from it.
  The capture encodes each such loader value a second time to pin it, and did
  not check that encode for errors. A server component in the value that threw
  only on that run was stored, and so was a value Flight cannot encode (a
  function, a class instance, a promise inside a `Map` that rejects) at build
  time, where the capture refuses only on SSR errors. The capture now stores
  nothing, reports `cache-write` and backs the key off, the same as a shell
  component that throws (#920); a build-time capture skips the shell and the
  route keeps runtime capture
  ([#932](https://github.com/rangojs/rango/pull/932)).
- An `errorBoundary()`, `notFoundBoundary()` or `intercept()` declared in a
  routeless entry nested in another one was never found: a `layout()` after a
  bare `cache()` (for the routes before the `cache()`), or a `layout()` in a
  routeless `transition(cfg, () => [...])` or `cache(o, () => [...])`. A
  handler error, `notFound()` or server action error rendered an ancestor's
  boundary or the default fallback, and the intercept neither opened on a soft
  navigation nor was pre-rendered. These lookups now walk nested routeless
  entries in the same order as the first level: the entry's own, then its
  routeless entries in render order, then the parent. The build also
  pre-renders an intercept declared directly after a bare `cache()` once
  instead of twice for the routes after it
  ([#933](https://github.com/rangojs/rango/pull/933)).
- On a `ppr` route, a PPR shell hit restored the handle pushes an `ssr: false`
  loader made during the shell capture, and the loader's re-run on the hit
  pushed them again. A handle that does not dedupe by key, such as a custom
  handle or a crumb without an `href`, showed the value twice, and hydration
  did not match the prelude, which showed it once. The re-run's pushes now
  replace the restored ones in place, so each value appears once and the
  live value wins; a push that lands after the document's handle data was
  sent reaches the client after hydration. With the loader's own `cache()`,
  a hit on that cache no longer replays them a second time. The record gains
  an optional `handleOwners` field on `CachedEntryData`; a custom
  `SegmentCacheStore` that stores the whole entry keeps it, and a record
  without it restores as before. Shell entries from an earlier build are
  already recaptured by the build-version gate. This supersedes the #875
  known-limitation note under Docs below
  ([#936](https://github.com/rangojs/rango/pull/936)).
- A `"use cache"` hit can be asserted through the testing primitives. The
  `@vitejs/plugin-rsc/rsc` stub that `rangoTestAliases()` installs threw from
  its encoder and serializer, so a cached function run through
  `renderHandler` or `runLoader` with a seeded `cacheStore` never wrote an
  entry and ran on every call, although the testing skill said a seeded store
  asserts real cache behavior. Under the react-server condition (the Flight
  project) the stub now runs the vendored react-server-dom builds plugin-rsc
  wraps. The body runs once across calls, the value round-trips through
  Flight, and an error row is not stored. The write is a background
  (`waitUntil`) task the primitives do not await: a call before it lands joins
  the still-running execution, and a call after it reads the store. In the
  node project React's server build does not load, so calls still run
  uncached, and any other failure to load the Flight builds now throws.
  A function written with the directive also stayed a plain function in a
  test: `rango()` runs the `"use cache"` transform only in its `rsc`
  environment, and Vitest transforms in `ssr`. The new
  `rangoUseCacheTransform()` from `@rangojs/router/testing/vitest` runs the
  same transform in a Vitest project, with the ids `vite dev` emits; add it to
  the Flight project's `plugins` next to `rangoUseClientTransform()`
  ([#944](https://github.com/rangojs/rango/pull/944)).

### Docs

- READMEs, every shipped skill, `packages/rangojs-router/docs`, and the docs
  site were checked against source. Corrected examples include the intercept
  modal wrapper rendering `<Outlet />`, server `errorBoundary()` fallbacks
  receiving only `{ error }`, the i18n middleware no longer reading
  `ctx.params`, and `revalidate()` examples narrowing with
  `ctx.isAction() ? ctx.isAction(X) : undefined`. The docs site gains
  `testing` and `client-urls` guides
  ([#869](https://github.com/rangojs/rango/pull/869)).
- `useLoader().isLoading` on a held navigation follows the loader family
  (`$$id`), not the segment: a persisting layout that reads the same
  `createLoader` reports `true` too. Documented as designed in the `hooks` and
  `view-transitions` skills; the 0.16.0 entry below is amended
  ([#868](https://github.com/rangojs/rango/pull/868)).
- A bake-lane (`ssr: false`) loader re-runs on every PPR shell hit, and the
  hit also replays its captured handle pushes, so a handle that does not
  dedupe by key shows them twice. Documented in the `ppr` and `shell-manifest`
  skills and guides; `Meta` and `Breadcrumbs` dedupe and are unaffected. No
  runtime change ([#875](https://github.com/rangojs/rango/pull/875)).
  Superseded: the hit now replaces those pushes (see Fixes above).
- The `server-actions` skill documents the default CSRF origin check (the
  Origin/Referer vs Host rule, the 403 rejection, and what it does not cover);
  the `response-routes` skill says response routes are outside it and shows a
  `requireSameOrigin` middleware
  ([#881](https://github.com/rangojs/rango/pull/881)).
- The `intercept` skill and the `intercepting-routes` guide list `route` among
  an intercept's allowed `use()` items and say the boundary lookup from a
  routeless declaring layout continues upward. The `handler-use` skill
  documents that `intercept()` checks its explicit `use()` and the handler's
  `.use` together at runtime (#879), and that modal chrome is a `layout()` with
  no `use()` items of its own. `route-definition-rules.md` and the internal
  reference docs were corrected for drift found reviewing v0.16.0..main
  ([#903](https://github.com/rangojs/rango/pull/903)).

### Internal

- Playwright `globalTimeout` (10 min) applies only under CI; a local full
  dev + production run is no longer cut off behind a passing summary
  ([#866](https://github.com/rangojs/rango/pull/866)).
- Local e2e server reuse probes `GET /` for an app-specific marker and fails
  with the `lsof` listener instead of reusing a foreign process on the port
  ([#867](https://github.com/rangojs/rango/pull/867)).
- Origin-guard e2e (dev + production) sends a cross-site no-JS form post and a
  cross-site RSC action call to a real action: both get 403 and the action
  never runs; a same-origin control runs it
  ([#887](https://github.com/rangojs/rango/pull/887)).
- `@playwright/test` moves to `^1.62.0` in every workspace package that
  declares it (the lockfile resolves 1.63.0). 1.57 dropped empty multipart
  fields, so a posted server-action form lost its `$ACTION_ID_` field. The
  origin-guard no-JS case now runs urlencoded and multipart (dev +
  production). The router's `@playwright/test` peer range stays `^1.49.1`
  ([#890](https://github.com/rangojs/rango/pull/890)).
- Local e2e server reuse probes with `Host: localhost:<port>`, the Host the
  suites send, so this checkout's host-fixture servers from an earlier run are
  reused instead of rejected as foreign. The router and cloudflare-basic
  Playwright webServers call `./node_modules/.bin/vite` directly, so they also
  start in a git worktree with symlinked `node_modules`
  ([#891](https://github.com/rangojs/rango/pull/891)).
- Unit tests pin that a route handler under `loading()` that rejects after the
  200 has gone out is never written to the route cache, on the miss, stale
  refresh, proactive caching, partial navigation, parallel-slot and intercept
  lanes. No runtime change ([#908](https://github.com/rangojs/rango/pull/908)).

## 0.16.0 (2026-09-20)

### `useLoader().isLoading` is true for data held on screen while a navigation re-runs its loader

When a navigation keeps the current content visible while its loader re-runs
(a `transition()` same-route nav such as `/products/1 -> /products/2`, a
same-structure search/filter nav), the reader still showing the old data now
reports `isLoading: true` from the moment the new tree is committed until the
commit that swaps `data`, so a stale indicator can be rendered from it. The
flag never flashes back to `false` on the old data: every transition commit
announces the loader streams the committed tree is still receiving
(`announcePendingStreams` in `loader-store.ts`, called inside the
`startTransition` in `browser/partial-update.ts`), and the hook answers with a
`useOptimistic` pin that React reverts in the commit that brings the new data.
Loaders the navigation does not re-run keep their data and stay `false`. The
pin follows the loader family (`$$id`), not the segment: if the same
`createLoader` is also registered on a persisting layout, that layout's
`useLoader` reports true too — the loader is in flight, even though the
layout copy is not replaced. A fully-prefetched nav commits settled data and
flags nothing; a cold navigation that remounts the route is unchanged (the
read suspends to its fallback); an ephemeral `useFetchLoader` read outside
route context is never pinned. Pinned
dev and production in the test-app (`/swr-product/:id`, and `/tx-group-a/:id`
with a persisting layout loader) and cloudflare-basic (`/features/:slug`).

### A layout over a wrapper-form `transition()` block no longer wraps every sibling route

`layout(Shell, () => [transition(cfg, () => [routes])])`, the shape the
view-transitions guide recommends, was classified as an orphan (routeless)
layout because the orphan check could not see routes inside a transition
block. Orphans are pushed onto the parent's wrapper list and render around the
parent's entire content, so `Shell`, and any `loader()`, `middleware()` or
`loading()` on it, applied to every sibling route of its parent instead of its
own routes. The wrapper-form transition item now carries its children and the
check recurses through any item that does; the same change covers `cache()`
and `middleware()` blocks over a transition block, and a lazy `include()`
inside a transition block is now discovered. Child-form `transition(cfg)` and
routeless transition blocks are unchanged (still orphan wrappers).

### Streaming Suspense boundaries are no longer client-rendered by the theme provider's mount re-sync

Every page load re-rendered `ThemeProvider` from its mount effect (`mounted`,
system theme, stored-theme re-sync) and published a NEW context object even
when no field changed. A provider value change propagates to every dehydrated
Suspense boundary still waiting on the streamed document (React marks them
conservatively; it cannot see their consumers), and React then abandons the
server HTML for those boundaries and client-renders them from the Flight
payload. On a page whose shell hydrates before a `loading()` boundary
finishes streaming, that discarded the outlined server markup and, until the
boundary's `$RC` script ran, left a hidden duplicate of the content in the
document. The context value now keeps its identity across the re-sync when its
fields are unchanged, so a pending boundary stays dehydrated and adopts the
server HTML. `resolvedTheme` also no longer reports `"light"` before mount for
a concrete `defaultTheme` rendered without `initialTheme` (standalone
`ThemeProvider`, `renderRoute`); it reports the theme from the first render
instead of flipping at mount. Root cause of the dev-only `use-cache-inline-action` flake
(strict-mode locator hit both copies). Still open: when the re-sync genuinely
changes a field (dark system theme, a stored theme differing from the
server's), the value must publish and a boundary pending at that moment is
still client-rendered; wrapping the re-sync in `startTransition` was measured
and does not help (React retries on a hydration lane and client-renders
anyway). Unit: `theme-provider.test.tsx` "context value identity across the
mount re-sync". E2e (dev + production, test-app and cloudflare-basic):
`streamed-boundary-adoption.test.ts` pins that every server boundary marker
survives in the settled DOM.

### Dependencies: `@vitejs/plugin-rsc` `^0.5.35`

0.5.35 adds Node stream entry points (`/rsc/server.node`, `/rsc/client.node`,
`/ssr.node`, `/rsc/static.node`); the rest is dependency churn. Nothing in the
router adopts them: the Flight and SSR layers stay on the Web-stream entries in
every preset. The benchmark behind that decision (Flight unchanged, SSR gain
inside request noise once the Flight tee and `injectRSCPayload` stay Web
streams) is recorded in `docs/internal/why-web-streams-everywhere.md`.

## 0.15.1 (2026-09-14)

### `{ ssr: false }` loaders that redirect or notFound no longer 500 the document

A `loader(Def, { ssr: false })` settles before the document flushes, and its
read site decodes synchronously. When the loader threw `redirect()` or
`notFound()`, that decode threw inside the Fizz shell (flagged content renders
without a Suspense boundary, and a layout reader sits above every boundary),
so the document was a 500 with the dev overlay instead of the documented 200
plus client replace. The server tree builder now resolves the settled signal
itself, the same way the aggregate forceAwait/action path already did: a
redirect replaces the whole page with the redirect carrier (200 document, the
client replaces on hydration; any ancestor read is skipped), and a notFound
renders the not-found UI at the owning segment with the real 404 the flag
already guaranteed. A flagged loader error that has an `errorBoundary()`
fallback takes the same route (fallback planted, no shell throw). Build-shell
capture now refuses to bake a flagged loader that settled with a signal, the
same way it already refused a rejected one, so a redirect can never be frozen
into a shell every visitor shares. Pinned dev and production in the test-app
and cloudflare-basic (`client-urls-ssr-signals` fixtures: layout-owned,
route-owned, and layout-reads-child redirect readers, plus a notFound page).

## 0.15.0 (2026-09-13)

### Loader bodies must not carry `"use server"`

The Vite plugin now rejects an inline `"use server"` directive inside a
`createLoader()` callback, in dev and build:

```
[rango] createLoader() body at src/catalog.loader.ts:3 carries a "use server" directive. ...
```

The directive never meant "server only". It tells the RSC toolchain to hoist
the body and register it as a client-callable server reference, so every
loader written that way was also reachable as an action through
`?_rsc_action=<id>` with caller-supplied arguments. Loader bodies already run
only on the server, addressed by id, so the directive did nothing useful.
Every example in the docs, skills, and in-repo apps used to carry it; all of
them are updated. Migration is deleting that one line per loader. For a
build-time guarantee that a module never reaches the client graph, use
`import "server-only"`.

Two related contracts are now pinned by dev and production e2e in both the
test-app and cloudflare-basic (`client-urls-vars` fixtures): route
`middleware()` variables set with `ctx.set()` (a `createVar()` token or a
string key) are visible to `clientUrls()` group loaders on document loads and
partial navigations; and the `_rsc_loader` fetch lane (`useFetchLoader()`,
`load()`, `useRefreshLoaders()`) runs only global `router.use()` middleware
plus the loader's own `{ middleware }` list, never the route chain, so
`createLoader(fn, true)` sees none of those variables. The loader skill now
says so next to the `true` example.

## 0.14.0 (2026-09-13)

The instance a client route group renders optimistically now survives the
canonical commit: state entered while the server is still responding is kept,
effects run once, and same-route param navigations inside a group hold the
previous content until the new data lands. Minor bump for the changed
same-route behavior; no DSL change.

### Breaking: group-stable segment for `clientUrls()` ([#852](https://github.com/rangojs/rango/pull/852))

0.13.0 rendered the destination of an in-group navigation before the server
responded, but the canonical commit still mounted the destination as a new
segment, so the instance the user was already interacting with was replaced.
Every route of one group mount now shares a segment key, the group's routes
get one wrapper shape, and `ClientUrlsRoot` renders the same wrapper chain in
both states, so the commit reconciles into the same position.

- Text typed into a field during the wait survives the commit; the
  destination's mount effect runs once instead of twice.
- Same-route param navigations inside a group (`/items/1` -> `/items/2`) now
  hold the previous content until the new data lands instead of remounting
  with a fresh skeleton. `transition()` in a group configures the
  view-transition animation; it no longer changes whether content is held.
  Server routes outside a group keep the param-bearing key and the
  `transition()` opt-in.
- A navigation that presented optimistically commits in the transition lane,
  so a read that still suspends holds the presented content instead of
  flashing a fallback.
- `loading()` on a group route is now the `Suspense` boundary inside the
  client root rather than a segment-level `LoaderBoundary`; the fallback and
  the reads are the same. Server-side semantics are untouched: `loading()`
  still masks loaders for PPR shell capture and drives SSR.
- The streamed loader error boundary resets its caught marker when the route
  or params change. As a surviving instance it kept rendering a loader
  redirect for the previous route; a redirect, `notFound()`, or error fallback
  caught for one route no longer leaks into the next.

Hard loads, prefetch, intercept targets, redirects, and errors are unchanged.
Design and mechanics: `docs/design/client-urls-optimistic-destination.md`.

## 0.13.0 (2026-09-12)

Client route groups are instant by default: a cross-route navigation inside a
`clientUrls()` group now renders the destination component before the server
responds. `loading()` becomes the optional route-level boundary around that
render instead of the only way to present anything early. Minor bump: the DSL
is unchanged, but the runtime contract for `useLoader` and the route hooks
inside a group changes.

### Breaking: `clientUrls()` renders the destination optimistically by default ([#850](https://github.com/rangojs/rango/pull/850))

Before, an in-group navigation showed the destination's `loading()` if it had
one and otherwise kept the origin page on screen with `useOutlet().pending`
until the canonical response committed. Now the destination component
renders at once, in a transition lane:

- `useLoader()` on a destination loader suspends until the canonical commit
  instead of throwing "not found in context". It suspends into the route's
  `loading()` when declared, into the nearest inline `<Suspense>` inside the
  component otherwise, and a destination with no boundary at all keeps the
  origin visible exactly as before (React holds the previous content in the
  transition lane).
- `useParams`, `usePathname`, and `useSearchParams` inside the rendered
  destination describe the destination (the local match's params, the target
  pathname and search). Outside the optimistic branch — chrome above the
  group, the URL bar, history, `useNavigation`, `useLinkStatus` — they keep
  the committed location until the server confirms; a redirect or error
  discards the branch and its values.
- The canonical commit after an optimistic presentation is tagged with a
  dedicated transition type that router `<ViewTransition>` boundaries map to
  `none`, so a `transition()` route animates once, at the click, not again
  when the identical content commits.
- The optimistically rendered instance is replaced by the committed segment
  when the response lands: local state entered during the window does not
  survive and effects run once per instance. A group-stable segment that
  keeps the instance alive is the documented follow-up.

Unchanged: hard loads still await middleware and `loader(Def, { ssr: false })`;
same-route param and search navigations keep held data and the `transition()`
hold; fully prefetched clicks commit from cache; intercept targets decline
local presentation; middleware and loader redirects or errors replace the
optimistic branch. There is no per-route opt-out: a route whose shell must
not render before authorization belongs in `urls()`.

Placement rule: a `useLinkStatus` or `useNavigation` reader inside content
the optimistic layer swaps unmounts at click; keep such readers in chrome
that survives the swap. Design and rationale:
`docs/design/client-urls-optimistic-destination.md`.

## 0.12.4 (2026-09-11)

Bug-fix release: the async `include()` form now mounts a `clientUrls()` module
directly, so a server `urls()` wrapper module is no longer needed to code-split
a client route group.

### Fix: async `include()` resolves a `clientUrls()` module directly ([#848](https://github.com/rangojs/rango/pull/848))

`include("/portal", () => import("./portal.client.js"), { name: "portal" })`
rejected a module whose default export is a `clientUrls()` definition
("include() provider ... must resolve to a urls() value") at the first request
into the prefix and at build-time discovery, while the eager
`include("/portal", portalUrls)` form and static route-type generation both
accepted it. The provider resolver now adapts a `clientUrls()` source (the
definition object, or its server-side client reference) through the same
adapter the eager mount uses, and route names infer through the thunk. No
startup saving comes with the async form for a client group — a `"use client"`
module is only a reference stub in the RSC graph — so pick whichever keeps
your mounts uniform. The nested caveat is unchanged: a client group mounted
inside an async `urls()` module still needs explicit names on every segment.

- Covered by runtime, build-time, and public-testing-primitive unit tests, dev +
  production e2e in the test-app and cloudflare-basic, and a local HMR test that
  adds and removes routes in the async-mounted module.
- The cloudflare-basic router-chunk bundle ratchet is re-baselined from 43 KB to
  44 KB: main measured 44031B against the 44032B limit, and this change adds
  5 B of client-reference registration-order noise, no runtime.

## 0.12.3 (2026-09-10)

Docs-and-skill release for React 19.3, with no runtime change: the shipped
`view-transitions` skill now says the `<ViewTransition>` layer works on stable
React 19.3+ (it is feature-detected, so 0.12.2 already activates it there), and
documents the transient duplicate host during a transition commit and the
doubled hydration effects in dev StrictMode that come with 19.3.

### Dependencies: React 19.3 in the workspace catalog ([#842](https://github.com/rangojs/rango/pull/842))

`react` / `react-dom` move to `^19.3.0` for every app in this repo. The router's
peer range stays `>=19.2.8 <20`, so consumers on 19.2.8 are unaffected; 19.3
is now what the e2e suites run against. Two things change on React 19.3
itself, both feature-detected rather than gated on the version:

- `transition()` now wraps segment content in React's `<ViewTransition>` on
  stable React, because 19.3 exports `ViewTransition` / `addTransitionType`.
  On 19.2 that layer is still a no-op and only the `startTransition` content
  hold applies. The view-transitions guide, skill, and internal docs no longer
  say the animation layer needs an experimental build. Tests that assert on
  a `transition()` route with strict Playwright locators can now hit the
  transient duplicate host during a transition commit; both docs gained a
  testing note and `tests/cloudflare-basic/e2e/location-state.test.ts` shows
  the fix.
- In development with StrictMode on (the default), hydration effects now run
  twice as well as the render (React 19.3 double-invokes effects during
  hydration, react#35961). The `hook-render-stability` e2e contract is updated
  from one hydration commit to two; production and `strictMode: false` are
  unchanged.

## 0.12.2 (2026-09-05)

React Compiler is now documented and tested through `@vitejs/plugin-react`
6.1's native `compiler` option. The `react-compiler` skill shipped in this
package describes the one-flag setup and keeps the Babel wiring as a fallback.
No runtime changes.

### Docs: React Compiler via plugin-react 6.1's native `compiler` option ([#840](https://github.com/rangojs/rango/pull/840))

The documented React Compiler wiring is now `react({ compiler: true })` on
`@vitejs/plugin-react` 6.1 with its optional peer `oxc-transform-react`, in
place of the Babel pair (`@rolldown/plugin-babel` + `reactCompilerPreset()`).
The `react-compiler` skill and the docs guide cover the native option: the
client-only contract (`consumer !== "server"`), `logDiagnostics`, and the
version coupling between `oxc-transform-react` and plugin-react's peer range
(pin the range plugin-react declares; a newer binding fails npm's resolver).
The Babel wiring stays documented as a fallback. No router code changed;
Rango's compiler apps (e2e-basic, vite-rsc-demo, cloudflare-basic) run the
native option in dev and production e2e.

## 0.12.1 (2026-08-31)

Standalone Vite 8 consumers can assemble the Vercel function launcher without
esbuild, and consumer Flight tests that import `"use client"` islands no
longer need a direct `@vitejs/plugin-rsc` dependency.

### Fixed: bundle the vercel function launcher with rolldown ([#838](https://github.com/rangojs/rango/pull/838))

Vite 8 no longer ships esbuild, so a standalone `preset: "vercel"` consumer
failed at assemble with "esbuild ships with Vite". The launcher is now
bundled with rolldown (a production dependency of Vite 8), resolved through
the app's vite install. `srvx` and `@vercel/functions` stay inlined;
`./rsc/index.js` stays a runtime-relative external.

### Fixed: resolve plugin-rsc vendor from the router in rangoUseClientTransform ([#838](https://github.com/rangojs/rango/pull/838))

`rangoUseClientTransform()` injected
`@vitejs/plugin-rsc/vendor/react-server-dom/server.edge` into consumer
`"use client"` modules. Consumer apps do not depend on plugin-rsc, so
`renderServerTree` of an island failed to load. The vendor file is now
resolved from `@rangojs/router` and injected as a file URL.

## 0.12.0 (2026-08-28)

Adopts `@vitejs/plugin-rsc` 0.5.34 (`getClientEntryUrl`, split `/rsc/server`
and `/rsc/client` runtimes) and restores file-level `"use cache"` wrap when
Vite/oxc emit `directive: null` on a sibling handler. 0.5.34 is a hard floor
— upgrade the peer with the router.

### Fixed: hoist `"use cache"` when sibling handlers have `directive: null` ([#836](https://github.com/rangojs/rango/pull/836))

Inline `"use cache"` hoist against `@vitejs/plugin-rsc` 0.5.34: strip
`directive: null` fields Vite/oxc now emit on ordinary ExpressionStatements
before calling `transformHoistInlineDirective`. 0.5.34's `matchDirective`
does `stmt.directive.match(...)` after `"directive" in node`, so a file that
mixes a cached function with a sibling handler whose first statement is an
expression threw and the wrap was dropped (cache-tag / inline-handler e2e
never hit).

### Dependencies: `@vitejs/plugin-rsc` `^0.5.34` ([#836](https://github.com/rangojs/rango/pull/836))

Generated SSR entries use `getClientEntryUrl()` for `headScripts: "preinit"`
instead of the deprecated `loadBootstrapScriptContent`. RSC runtime imports
split onto `@vitejs/plugin-rsc/rsc/server` and `/rsc/client`. File-level
`"use cache"` leaves mixed `"use server"` exports for plugin-rsc — both the
hoisted `$$hoist_*` helpers and the `registerServerReference` rebinds of the
original export names.

0.5.34 is a hard floor: `@vitejs/plugin-rsc` is a singleton peer, and pnpm
resolves an in-range older install (0.5.31-0.5.33) with only a warning —
such an install then fails module linking at boot (`/rsc/server`,
`/rsc/client`, and `ssr`'s `getClientEntryUrl` do not exist there). Upgrade
the peer together with the router.

`SSRDependencies.loadBootstrapScriptContent` is now optional (a
`headScripts: "preinit"` entry uses `getClientEntryUrl` instead);
`createSSRHandler`/`createShellCaptureHandler` throw at construction when
neither bootstrap dependency is usable, instead of per-request.

## 0.11.0 (2026-08-18)

Client `revalidate()` now receives the same callable `isAction(...refs)`
matcher as the server predicate. This is a breaking type/shape change: the
old boolean truthiness check stays compiling but always takes the "is an
action" branch.

### Breaking: clientUrls `revalidate()` gets the callable `isAction()` matcher ([#834](https://github.com/rangojs/rango/pull/834))

`ClientRevalidateArgs.isAction` changed from a **boolean** to the same
callable `isAction(...refs)` matcher the server predicate receives. The old
truthiness idiom keeps compiling but silently inverts — a function is always
truthy — so audit any predicate written against the boolean form:

```ts
// before — boolean (now always truthy, silently returns false):
isAction ? false : defaultShouldRevalidate;
// after — call the matcher:
isAction() ? false : defaultShouldRevalidate;
```

Client predicate chains now also mirror the server's semantics exactly: a
boolean is a hard decision that short-circuits the chain, and a
`{ defaultShouldRevalidate }` verdict threads into later predicates.

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
