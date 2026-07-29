# Client URL Routes

`clientUrls()` lets the browser recognize selected client-component routes after
hydration. On a soft navigation, that local match can show the destination's
`loading()` UI immediately and set `useOutlet().pending` while the ordinary
partial Flight request is still running.

The browser match is presentation only. The server still matches the request,
runs middleware and route loaders, and returns the canonical partial Flight
response. Only that response commits the URL, history, and route content. Hard
requests use the same projected server routes, so SSR and hydration work without
a separate client-only entry path.

Composition is the baseline mounting model: a `clientUrls()` definition
participates in the canonical `urls()` tree through `include()`, exactly like a
server route module. The include supplies the URL and route-name prefixes,
surrounding layouts remain ordinary RSC layouts, and nested middleware, loaders,
boundaries, and route ownership derive from the server tree.

## End-to-end example

Define server loaders in a server module. The loader does not need to be
fetchable: projected client URL routes execute `createLoader()` definitions by
their generated ID through the server loader registry.

```tsx
// src/catalog.loader.ts
import { createLoader } from "@rangojs/router";
import { getProduct } from "./db.js";

export const ProductLoader = createLoader(async (ctx) => {
  return getProduct(ctx.params.productId);
});
```

Define the client routes in a module whose directive is `"use client"` and whose
default export is the `clientUrls()` result. Path and layout components must be
named component values.

```tsx
// src/catalog.client-urls.tsx
"use client";

import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { ProductLoader } from "./catalog.loader.js";

function CatalogLayout() {
  const { content, pending } = useOutlet();

  return (
    <main aria-busy={pending}>
      <nav>
        <Link to="/catalog">Catalog</Link>
      </nav>
      {content}
    </main>
  );
}

function CatalogIndex() {
  return <Link to="/catalog/products/espresso">Espresso machine</Link>;
}

function ProductPage() {
  const { productId } = useParams<{ productId: string }>();
  const { data: product } = useLoader(ProductLoader);

  return (
    <article>
      <h1>{product.name}</h1>
      <p>Product id: {productId}</p>
    </article>
  );
}

function ProductLoading() {
  return <p>Loading product...</p>;
}

export default clientUrls(({ path, layout, loader, loading }) => [
  layout(CatalogLayout, () => [
    path("/", CatalogIndex, { name: "index" }),
    path(
      "/products/:productId",
      ProductPage,
      {
        name: "product",
        search: { ref: "string?" },
        trailingSlash: "never",
      },
      () => [loader(ProductLoader), loading(<ProductLoading />)],
    ),
  ]),
]);
```

Patterns are definition-local. The `include()` mount below supplies the
`/catalog` URL prefix (the bare mount is the module index `/`) and the
`catalog.` route-name prefix; the browser strips the same mount prefix before
local matching, mirroring `useMount()` and client `href()`.

Mount the definition inside the canonical `urls()` tree with `include()` —
under an RSC layout, alongside server routes, wherever it belongs:

```tsx
// src/urls.tsx
import { urls } from "@rangojs/router";
import catalogClientUrls from "./catalog.client-urls.js";
import { CatalogRscLayout } from "./catalog-layout.js";

export const urlpatterns = urls(({ include, layout }) => [
  layout(<CatalogRscLayout />, () => [
    include("/catalog", catalogClientUrls, { name: "catalog" }),
  ]),
]);
```

```tsx
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document.js";
import { globalMiddleware } from "./middleware.js";
import { urlpatterns } from "./urls.js";

export const router = createRouter({ document: Document })
  .use(globalMiddleware)
  .routes(urlpatterns);
```

There is exactly one canonical `.routes()` call. A pure-client app may pass
the definition directly — `createRouter().routes(clientUrlPatterns)` is
shorthand that NORMALIZES to a root include
(`include("/", definition, { name: "" })`): same lazy materialization, bare
route names, basename inherited like any registration. It is sugar over the one
composition model, not a second registration path. For URL prefixes, wrapping
RSC layouts, or prefix-scoped middleware, mount through `include()` yourself;
client definitions follow normal include semantics — mount several, nest them
under layouts, scope `.use(prefix)` middleware to their prefix.

Pass the client module's default export, not a `clientUrls()` object built in a
server module: a direct object cannot cross the server/client boundary and fails
at render. The include materializes lazily from the discovery-installed server
projection, so a broken mounting surfaces as a clear error at evaluation time.

## Navigation authority

After hydration, a navigation to a different matching client route can render
its `loading()` value before the network response arrives. A wrapping client URL
layout sees `useOutlet().pending === true` for that optimistic branch. Without a
destination `loading()`, the current branch remains visible with its outlet marked
pending.

The local result cannot authorize the request, run or skip middleware, execute a
loader, commit history, or override a redirect or error from the server. The
existing navigation bridge still sends the canonical partial Flight request;
middleware scoped over the include prefix and projected loaders run on the
server, and the response remains authoritative.

`pending` is deliberately narrow in this release:

- it is `false` during SSR and before the client URL registry mounts after
  hydration;
- it covers ANY local match while its canonical navigation is unresolved —
  a different `clientUrls()` route record, or a parameter/search change that
  stays on the same record (a filter or tab nav, whose held content it is the
  only progress signal for — see the same-route commit below);
- it clears when that navigation commits, fails, redirects, is cancelled, or is
  superseded;
- it does not report prefetching, generic Suspense, ordinary server-route work,
  or unrelated actions.

Use `useNavigation()`, `useLinkStatus()`, loader state, or your own Suspense
boundary for those other scopes.

## Same-route search navigations hold previous content

A navigation that mounts no new segments commits inside `startTransition`,
the same treatment actions get (`isSameStructureNav` in
`src/browser/partial-update.ts`). Where this is visible: SEARCH-only
navigations — filters, tabs, query-driven pagination. Search is never part
of a segment's key, so the route subtree reconciles; the re-run loaders
stream as always, but React holds the currently visible content until their
data lands instead of re-suspending the already-revealed boundary into its
fallback. Without the hold, a category-filter click replaced the visible
product grid with its skeleton for the loader's full duration. During the
hold the wrapping layout sees `useOutlet().pending === true` (the urgent
intent set at navigation start), so `aria-busy`-style dimming covers the
wait; the pending flag and the fresh content land in one commit.

Two boundaries, both deliberate:

- **Param navigations without `transition()` are unchanged.** A param change
  remounts the route subtree (the param rides the segment key —
  `segment-system.tsx`), and a freshly mounted boundary reveals its fallback
  even inside a transition: fresh skeleton, fresh component state.
  `transition()` remains the opt-in that drops the param from the key and
  extends the hold to param navs.
- **Cross-route navigations are unchanged.** Mounting new segments commits
  urgently, so destination fallbacks stream in like a first load and the
  click has immediate visible feedback.

Pinned dev+prod in `tests/vite-rsc-demo/e2e/client-shop-filters.test.ts`
(hold + pending on a filter nav); the param-nav remount default and the
`transition()` opt-in stay pinned in `e2e/same-route-nav.test.ts` and
`e2e/client-urls.test.ts`.

## Outer layouts and middleware across group navigations

The common mounting shape puts server structure and guards AROUND the group:

```tsx
export const urlpatterns = urls(({ include, layout, middleware }) => [
  layout(<AdminRscLayout />, () => [
    middleware(requireAdmin),
    include("/admin", adminClientUrls, { name: "admin" }),
  ]),
]);
```

Middleware and layout handlers ride DIFFERENT schedules, and conflating them
is the common misread:

| Runs on…                   | Hard load | Within-group navigation                         | Nav with all loaders held               | Action                                     |
| -------------------------- | --------- | ----------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `AdminRscLayout` handler   | yes       | no — its segment HOLDS (partial rendering)      | no                                      | no by default (`action:parent-chain-skip`) |
| `requireAdmin` middleware  | yes       | **yes — every canonical request**               | **yes**                                 | yes (wraps the revalidation render)        |
| Group loaders              | yes       | per-loader `revalidate()` decision              | skipped (the decision crossed the wire) | per-loader decision (`isAction`)           |
| Optimistic loading/pending | n/a       | renders BEFORE the response — presentation only | same                                    | n/a                                        |

Two consequences worth stating plainly:

- **Middleware does NOT run "on first encounter" only.** Every navigation
  inside the group — including a tab/param switch whose loaders all hold —
  still sends the canonical partial Flight request (that request is what
  commits URL, history, and content, and it carries the client revalidation
  DECISIONS). Middleware in the matched chain wraps every one of those
  requests, so `requireAdmin` re-authorizes each navigation and its
  `ctx.set()` variables are fresh for the group's loaders on every pass. The
  instant feel comes from held data and optimistic presentation, not from
  skipping the server.
- **The outer layout handler does not re-run on within-group navigations.**
  Partial rendering diffs below the common ancestor, so the server layout's
  rendered segment is preserved client-side; on actions the parent chain
  skips by default. If the layout renders request-derived data that must
  refresh with the group, use middleware `ctx.set()` (fresh every pass) or a
  shared revalidation contract — not the layout handler's own body.

The one window that precedes middleware is the optimistic branch (destination
`loading()` / `useOutlet().pending`) — presentation only, never
authorization; see the security boundary below.

Pinned dev+prod in `tests/vite-rsc-demo/e2e/client-shop-guards.test.ts`: the
demo's `/client-shop` mount is wrapped in exactly this shape
(`src/urls/client-shop-guard.tsx` — a monotonic middleware header per
request, a layout run-count DOM stamp), and the suite asserts the header
advances on a within-group navigation AND on a held-loader tab switch while
the layout stamp holds.

## Client hooks inside a group

Group components are ordinary client components, so every hook from
`@rangojs/router/client` is CALLABLE — but the group model changes what some
of them mean. The working set below is pinned dev+prod by the hook probe
(`e2e/test-app/src/urls/client-urls.tsx` `ClientUrlsHooksProbe` +
`e2e/client-urls.test.ts` "hook probe" tests):

- **Core reads** — `useOutlet`, `useLoader`, `useParams`, `useHandle`,
  `useSearchParams` — first-class (the rest of this doc). `useHandle` is
  READ-ONLY in groups: handle writes come from loaders
  (`ctx.use(Meta)({ title })`) — there is no `handle()` DSL item. The
  built-in handles (`Meta`, `Breadcrumbs`, `Script`) all ride that same
  lane; their renderers (`MetaTags`, `Scripts`) are document-head
  components that live in the root layout, not in groups.
- **`<Outlet>` (the component)** reads the same context as `useOutlet` —
  inside a group layout it renders the identical `content`. Its named-slot
  form (`<Outlet name="@x">`) is inert in groups (group outlet providers
  carry no parallel slots — same reason `ParallelOutlet` is out); its
  `fallback` prop is a plain Suspense boundary and works as anywhere.
- **`useMount`** returns the include mount (`/admin` for
  `include("/admin", …)`); **`usePathname` is ABSOLUTE** — mount included —
  never the definition-local path the group's patterns matched. Don't
  compare it against your own `path()` patterns under a non-root mount.
- **`useHref`** is the correct way to build group-local links:
  `groupHref("/items/1")` composes the mount wherever the group is mounted.
  Hand-written absolute `to=` strings also work but hardcode the mount.
- **`useSearchParams` carries real values during SSR**: the live
  request's search seeds the SSR store, so search-derived branches SSR
  correctly and hydration agrees (the browser seeds from its own URL). On
  ppr routes search is part of SHELL IDENTITY: the key embeds the sorted
  search and the capture/resume renders seed that same string, so static
  parts may read search — each query-string variant gets its own shell.
  Two edges: a param excluded by `cache.searchParams` is absent in shell
  renders (exclusion declares "does not affect markup"), and `.toString()`
  renders sorted order while the browser holds the raw URL order.
  The setter works in groups as anywhere (same-route write, content-hold).
- **`useNavigation` / `useLinkStatus`** report the CANONICAL navigation
  (global pending), which fires for group-internal navs too. Caveat: a
  reader inside content the optimistic layer swaps (a destination WITH
  `loading()`) unmounts at click time — put status readers in chrome that
  survives the swap.
- **`useFetchLoader`** works unchanged: the fetch lane addresses a
  `createLoader(fn, fetchable: true)` definition by id, with no route or
  group mechanics involved. It deliberately does NOT consult `revalidate()`
  predicates — those govern nav/action re-runs of held data; an imperative
  `load()` is an explicit freshness request.
- **`useAction`** tracks a group action's lifecycle exactly as outside
  groups: idle → loading while the action POST is in flight → idle.
- **Errors**: wrap throw-capable components in the client `ErrorBoundary`
  (or any React boundary) — the group chrome stays intact. There is no
  `errorBoundary()` DSL item by design; the server-tree boundary around the
  mount owns the route-level envelope.
- **Prefetch tiers** (`prefetch="viewport"` / `"hover"` / `"none"` on
  `Link`) work inside groups unchanged — the demo's `/client-shop` grid
  (viewport) and related products (hover) are the pins.

Orthogonal — identical in and out of groups: `useNonce` (SSR-only value),
`useTheme` and the rest of the `./theme` surface (`ThemeProvider` /
`ThemeScript` sit above the router tree; groups inherit the context like
any client component), `invalidateClientCache` (acts on the GLOBAL history
cache / prefetch map through the registered store — no context or mount
involved; `keepClientCache` is a server-action directive and a warn-only
no-op in the browser), and the definition factories (`createLocationState`
on the browser client entry; `createLoader` / `createHandle` / `isHandle`
exist only under the react-server condition — define loaders and handles
in server or shared modules, not browser-only code). `MountContext` is the
raw context behind `useMount` — an advanced escape hatch; the hook is the
API. `initBrowserApp` / `Rango` (`./browser`) bootstrap the app above
everything and are out of group scope entirely.

Not meaningful inside a group (structural, not missing wiring):
`ParallelOutlet` (groups have no parallel slots), `useSegments` (the whole
group is one server segment — its answer inside a group does not reflect
the group's own nesting), `ScrollRestoration` / `useScrollRestoration`
(module singleton — render once in the root layout; mounting in a group
tears down stored positions on group unmount), `MetaTags` / `Scripts` /
`NavigationProvider` (document-head / app-root components).

Programmatic navigation is mount-aware through RELATIVE paths:
`router.push("cart")` (no leading slash) resolves against the include
mount, while absolute paths stay app-absolute — the mount is scoped, so
`push("/x")` is never auto-prefixed. The URL-less router methods are
mount-independent: `refresh()` refetches the CURRENT route,
`forward()` is history traversal, and `back()` traverses history with a
first-entry guard whose fallback lands on the APP root (basename, not the
mount — consistent with absolute semantics). `useParams` reports the COMMITTED
match: during the optimistic window (destination `loading()` presenting) it
still holds the ORIGIN params, like `useSearchParams` — destination params
arrive with the canonical commit. `useRefreshLoaders` works in groups with
the same contract as `useFetchLoader` (the refresh lane IS the fetch lane,
so tagged loaders must be `fetchable: true`; `revalidate()` is deliberately
not consulted).

`useLocationState` works in groups through three write lanes, none of which
needs a handler: `<Link state={...}>`, action writes
(`getRequestContext().setLocationState(...)` inside a server action — the
value merges into the CURRENT history entry when the action settles, no
navigation), and redirect-carried state (`redirect(url, { state })` thrown
from an action or a group loader — the state travels WITH the redirect
navigation and merges at the target entry). The loader lane deliberately does
NOT ride payload metadata: a streaming loader settles after the metadata
flush, so its redirect state rides the loader-result marker and is delivered
by the redirect nav itself, action-style. There is no commit-coupled
`ctx.setLocationState`-during-render lane in groups — groups have no
handlers.

`useReverse` works in groups through its local form: name your group routes
(`path("/items/:itemId", Item, { name: "item" })`) and the per-module gen
writer emits a sibling `<module>.gen.ts` route map for the default-exported
`clientUrls()` module, exactly as for named `urls()` modules. Import that
map and `useReverse(routes)` resolves names against the include mount
(`reverse("item", { itemId })` → `<mount>/items/<itemId>`; the `/` index
collapses to the bare mount). Route names in a group stay LOCAL unless the
`include()` itself is named — an unnamed include keeps them out of the
global map entirely.

## Supported surface

`clientUrls()` supports:

- `path()`, `layout()`, `loader()`, `loading()`, a restricted `intercept()`,
  a data-only `transition()`, and a client-run per-loader `revalidate()`
  inside `clientUrls()`;
- named client component values for paths, layouts, and intercepts;
- mounting through `include()` in the canonical `urls()` tree, with URL and
  route-name prefixes, wrapping RSC layouts, and prefix-scoped middleware
  deriving from the server tree;
- `PathOptions` projection for `name`, `search`, `trailingSlash`, and
  `ppr` — a group route with `ppr: true | PartialPrerenderProps` gets shell
  caching exactly like a hand-written ppr page: the materialized server
  route carries the option on its manifest entry, the capture freezes the
  group's static markup (its `useSearchParams` read included — search is
  shell identity, so the frozen value matches the URL the shell serves),
  and `loading()` subtrees stay the live holes. Per-loader capture
  policy: a `loader(Def, { ssr: false })` BAKES — it executes at
  capture and its settled return is shell material (frozen for the shell's
  lifetime, snapshot-pinned so HIT hydration agrees; nested promises in
  the return stay live holes), while every other loader is live and needs
  a boundary — `loading()` or an inline Suspense — or the capture refuses
  (eternal MISS). A route whose loaders are ALL flagged therefore needs no
  `loading()` at all. Actions/PE/nonce requests take the live axis;
- server `createLoader()` definitions, including non-fetchable loaders — with
  the full loader body contract: thrown `notFound()`/`redirect()` authority
  signals, handle writes (`ctx.use(Meta)({ title })`, handler parity), and
  `ctx.get(handle)` reads behind `await ctx.rendered()`;
- per-loader delivery options: `loader(Def, { ssr: false }, use?)`;
- hard-load server matching, SSR, hydration, and canonical partial Flight soft
  navigation, with implicitly-suspending `useLoader` reads (a pending first
  read suspends to its `<Suspense>` boundary while the loader streams).

`transition(config)` is valid inside a `path()` use callback only and projects
the data subset of `TransitionConfig`: ViewTransition classes
(`enter`/`exit`/`update`/`share`/`default`), `name`, and the
`viewTransition: "auto" | false` boundary opt-out. The `when` gate is a
server-executed predicate and is rejected — declare it with a server-tree
`transition()` wrapping the include. Materialization re-emits the config in
the standard child position, so the canonical commit gets the transition
hold — its remaining delta over the same-route default above is PARAM navs:
the config drops the param from the segment key, so `/items/one → /items/two`
reconciles and holds instead of remounting into its skeleton (pinned dev+prod
in `e2e/client-urls.test.ts` against a transition-less twin) — and, on
experimental React, the router's ViewTransition boundary with those classes.
`startTransition` itself needs no opt-in here: the local presentation already
wraps its swaps, and the canonical commit is transition-driven once the
config is present.

`revalidate(fn)` is valid inside a `loader()` use callback only —
`loader(SessionLoader, () => [revalidate(fn)])` — and gives each loader its
OWN revalidation decision instead of the route-level batch. The predicate is
declared in the `"use client"` module, so it never crosses the projection
boundary: it EXECUTES IN THE BROWSER before the partial or action request,
with a client-computable subset of the server args (`currentUrl`, `nextUrl`,
`currentParams`, `nextParams`, `defaultShouldRevalidate`, `stale`,
`isAction`, `actionId`), and only its DECISION crosses — an
`X-Rango-Client-Reval` header carrying skip/force loader ids. On the server,
every materialized loader stub has a synthesized per-loader `revalidate()`
that honors a decision addressed to its id and otherwise applies the locked
default; requests that carry no decisions (no-JS, PE, prefetch, document
loads) always get the defaults, and decisions can only address client-urls
stubs — server-tree loaders never see the header. Trust model: same class as
`_rsc_segments` — a decision only makes the client's own view staler or
fresher, never bypasses middleware or authorization. Pinned dev+prod in
`e2e/client-urls.test.ts`: after an action, one loader of the group refreshes
while a sibling with `isAction ? false : defaultShouldRevalidate` keeps its
held value in the same commit.

`loader(Def, { ssr: false }, use?)` is the SSR-completeness opt-in.
By default every loader streams on every render, so nothing a slow loader
produces is guaranteed to be in the SSR'd HTML — its section SSRs as the
Suspense fallback, a late handle push applies post-hydration, and a
loader-thrown `notFound()` only wins a real 404 status opportunistically.
With `ssr: false`, DOCUMENT renders await that loader before first
flush: its data is settled at first paint, its handle pushes ride the SSR
handle snapshot, and a thrown `notFound()` deterministically precedes
Response construction. Client navigations stream unchanged — the name says
where streaming still applies. Scoped per loader: unflagged siblings keep
streaming behind their boundaries. A flagged loader must not
`await ctx.rendered()` (a barrier cycle by construction — it throws a
deadlock error), and `intercept()` loaders reject the option (intercepts
render on client navigations only). Pinned dev+prod in
`tests/vite-rsc-demo/e2e/client-shop-stream.test.ts`.

INSIDE `clientUrls()` the DSL is deliberately minimal: client route groups
exist for transition performance — instant optimistic presentation, held
data, streaming reads — not for full-feature routing. `middleware()`,
`include()`, `parallel()`, `cache()`, error or not-found boundaries, and PPR
are not supported inside the group and are not a roadmap; they belong to the
surrounding server tree the include mounts into. (Boundaries are a
deliberate exclusion: a server-tree boundary around the mount catches
loader-thrown signals from the group with the uniform server-resolved
envelope, and inside the group plain React error boundaries work — every
component is a client component, and a streamed loader rejection throws to
the boundary above its `useLoader` read.) Every helper rejection and the
option-level rejections (`intercept`, `parallel`, `revalidate`, and any
other non-projected `PathOptions` key) are pinned by tests; `ppr` PROJECTS
(see Supported surface). `Static()`/`Prerender()` handler VALUES are also
rejected with a targeted message: build-time handlers are server-DSL
surface — their code cannot live in a "use client" bundle and their render
runs at build. Shell caching of a group route is the `ppr` path option;
build-time prerendering belongs to the server tree around the include.

Composition limits around a client include, locked explicitly:

- `parallel()` slots are handler-valued, so a client include is structurally
  unrepresentable inside one; parallel routes attach to server routes only.
- Canonical revalidation of a committed page follows ordinary server
  semantics; the group's loaders participate per-loader through client-run
  `revalidate()` decisions (see Supported surface). Segment-level
  `revalidate()` on the surrounding server tree is unaffected by the group.
- Intercepts come in TWO declaration forms, split by the projection boundary:
  1. **Server-declared** (a wrapping layout or route in the server tree) — the
     full form: `when` selectors, middleware, server handlers. Server-executed
     material cannot cross from a `"use client"` module, so anything beyond
     the restricted form below lives here. To keep that wiring next to the
     routes it belongs to, co-locate a small server module with the client
     module:

     ```
     photos/
       photos.client-urls.tsx   # "use client" — the routes
       photos.urls.ts           # server — urls() with the include + intercept
     ```

  2. **Client-declared**, inside `clientUrls()` — the restricted, fully
     JSON-projectable form: `intercept(slot, ".localTarget", Component,
use?)` where the target is a dot-local NAMED route in the same
     definition and `use` may contain `loader()`/`loading()` only. No `when`,
     no middleware. Scoping is MODULE-LOCAL by contract: only navigations
     whose origin is inside the group's mount render the modal; an outside
     origin commits the full route. Materialization enforces this with a
     synthesized origin-`when` — the server intercept walk resolves against
     the TARGET's parent chain and is origin-blind, so without the
     synthesized selector a client-declared intercept would claim every
     origin (and for outside origins the slot's host layout is not even in
     the rendered tree). The modal also PRESENTS module-locally: a
     materialized group layout hosts the slot outlets, so the modal renders
     inside the group's subtree rather than in a server layout of the
     consumer's choosing. (Mechanics: the group wrapper exists because
     top-level intercepts in a lazily included module attach to an isolated
     parent clone and vanish — see `materializeRouteItems` in
     `src/client-urls/server-projection.ts`.)

- `intercept()` MAY target a client route by its canonical route name
  (include name prefix + local name; unnamed client routes cannot be targets).
  From a server-page origin this behaves like any intercept. From an origin
  INSIDE the same client group, the local optimistic presentation DECLINES for
  claimed targets — payload metadata ships the current location's intercept
  target names, and the browser matcher composes the local record's canonical
  name to check membership — so the origin stays untouched until the canonical
  response commits the modal. `when`-conditional intercepts suppress
  conservatively (selectors need live navigation context); worst case a
  non-intercepted navigation loses its optimistic loading, never the reverse.
  One narrow edge: a back/forward restore served purely from the history cache
  keeps the previous location's target set until the next fresh commit.
- A clientUrls include NESTED inside another include module — including async
  `include(() => import())` modules — requires explicit names on the wrapping
  include(s) AND the client routes. Unnamed segments get counter-allocated
  auto-names (`$prefix_N` scope ids, `$path_*` route names) that diverge
  between discovery's single-pass walk and runtime nested lazy expansion, so
  requests 404 at entry resolution. Fully named nested mounts work and are
  e2e-pinned; root-module mounts work with or without names.

`useLoader()` inside client route components suspends implicitly: loaders
stream, and a pending first read suspends to the nearest `<Suspense>`
boundary (or the route's `loading()`) instead of rendering a loading flag.

## Security boundary

Optimistic loading UI can appear before global authentication or authorization
middleware completes. Do not put protected data or sensitive route-state details
in that loading branch. If revealing the destination shell itself is sensitive,
do not configure optimistic loading for that route.
