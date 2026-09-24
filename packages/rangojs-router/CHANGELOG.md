# Changelog

## Unreleased

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

### Added: `router.debugManifest()` on the public `Rango` type ([#874](https://github.com/rangojs/rango/pull/874))

`debugManifest()` was typed only on the internal router interface, so calling
it needed a cast. It is now on `Rango`, and its return type
`SerializedManifest` is exported from `@rangojs/router`. It also threw
`Duplicate route name` for any router that uses `include()`, because lazy
include placeholders carried the parent `urls()` handler and re-registered its
routes. Placeholders are now skipped, so routes mounted with `include()` are
absent from the result.

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
  ([#906](https://github.com/rangojs/rango/issues/906)).
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
- The `server-actions` skill documents the default CSRF origin check (the
  Origin/Referer vs Host rule, the 403 rejection, and what it does not cover);
  the `response-routes` skill says response routes are outside it and shows a
  `requireSameOrigin` middleware
  ([#881](https://github.com/rangojs/rango/pull/881)).

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
