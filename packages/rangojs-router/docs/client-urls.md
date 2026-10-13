# Client URL Routes

`clientUrls()` lets the browser recognize selected client-component routes after
hydration. On a soft navigation inside a group, that local match renders the
destination component immediately (its `useLoader()` reads suspend into the
route's `loading()`) and sets `useOutlet().pending` while the ordinary partial
Flight request is still running.

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
`catalog.` route-name prefix. In the browser the group matches a URL against
its patterns joined to the mount PATTERN (`buildClientUrlsTrie` in
`client-urls.ts`, the router's own trie), the way `useReverse()` joins
`useMount()`. A parameterized mount works the same way:
`include("/:locale", ...)`, `include("/:locale?", ...)` (with and without the
prefix) and `include("/:accountId/:projectId", ...)` present at the click, and
the destination's `useParams()` carries the mount's params as after the
commit. A click that changes a mount param (`/en/...` to `/de/...`) is
another instance of the include: it gets no optimistic frame, and commits as
a plain navigation (a frame would render the destination inside the old
instance's chrome).

The group's patterns can match URLs the server routes elsewhere: `/:slug`
under `/:locale?` matches a root `/login`, and under `/:locale` a sibling
`/:locale/about`. The server ships the routes that compete with the group's
for a URL as ClientUrlsRoot's `foreign` prop (`competingPatterns` in
`server-projection.ts`, walked over the router's own trie), and the browser
adds them to the group's trie as leaves: a URL one of them wins gets no
frame. The intercept origin gate reads the router's own match of the origin
(`from.routeName`, or the trie key of an unnamed route, and `from.params`)
for the same reason.

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

The async include form takes the module directly too — `include("/catalog",
() => import("./catalog.client-urls.js"), { name: "catalog" })` — no server
`urls()` wrapper module needed, and route names infer through the thunk. It
buys no startup saving (a `"use client"` module is only a reference stub in
the RSC graph); use it when you want one mount shape across all groups.

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

After hydration, a navigation to a different matching client route renders the
destination's component before the network response arrives — that is the
point of a client route group. Its `useLoader()` reads have no data yet and
suspend: into the route's `loading()` if declared (it is the route-level
boundary around the optimistic render), else into the nearest inline
`<Suspense>` inside the component. A destination that suspends with no
boundary at all keeps the current branch visible until the response commits
(the swap renders in a transition lane, so React holds the previous content).
A wrapping client URL layout sees `useOutlet().pending === true` for the
optimistic branch in every case. Only the destination's own loaders and those
of layouts the navigation mounts anew wait: a loader of a `layout()` the
navigation keeps (a cart count in a shop layout) reads the data it already has,
wherever it is read, until the canonical response replaces it. These are the
committed route's layout loaders (`ClientUrlRouteRecord.layoutLoaders`), never
its own: a navigation back to the committed route, made while another
destination's optimistic branch is on screen (`/product/a → / → /product/b`
inside one round trip), presents `/product/b` with its own loaders pending
instead of the committed `/product/a` data. The intent carries `fromFrame`
for that (`src/client-urls/navigation.ts`); a same-route navigation from the
committed page keeps its content as before.

Inside that branch, `useParams`, `usePathname`, `useSearchParams` and
`useLocationState` describe the destination (the local match's params, the
target pathname and search, the `state` the navigation carries).
Everything outside it — chrome above the group, the URL bar, history,
`useNavigation`, `useLinkStatus` — keeps the committed location and its
location state until the canonical response commits; a redirect or error
discards the branch and its values with it. A group's route segments share one React key, so the
optimistically rendered instance is the one the canonical response commits
into: local state entered during the window survives and effects run once.
Design and rationale:
[client-urls-optimistic-destination.md](./design/client-urls-optimistic-destination.md).

The local result cannot authorize the request, run or skip middleware, execute a
loader, commit history, or override a redirect or error from the server. The
existing navigation bridge still sends the canonical partial Flight request;
middleware scoped over the include prefix and projected loaders run on the
server, and the response remains authoritative.

`pending` is deliberately narrow:

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

- **Param navigations hold too, inside a group.** A group's route segments
  are keyed by the group, not by route id + params (`segment-system.tsx`,
  `ResolvedSegment.clientGroup`), so a same-route param nav reconciles the
  mounted instance and the same-structure commit holds its content until the
  new data lands. `transition()` in a group configures the view-transition
  animation; it is not what produces the hold. Server routes outside a group
  keep the param-bearing key: a param change remounts the subtree with a
  fresh skeleton unless the route declares `transition()`.
- **Cross-route navigations present the destination at once** (see
  "Navigation authority") and commit in the transition lane, so the presented
  content is held while any read that still suspends resolves.
- **A `layout()` keeps its instance across its routes.** `ClientUrlsRoot`
  keys each layout per `layout()` item (`ClientUrlRouteRecord.layoutKeys`, its
  ordinal among sibling layouts), not per route, so `/a → /b` under one layout
  reconciles it: state, DOM and inline Suspense stay. Only the route component
  (`key: route.id`) and the layouts below where the two chains differ mount
  anew (#1124).

Pinned dev+prod in `tests/vite-rsc-demo/e2e/client-shop-filters.test.ts`
(hold + pending on a filter nav) and `e2e/client-urls.test.ts` (param-nav
hold with and without `transition()`); the server-route remount default stays
pinned in `e2e/same-route-nav.test.ts`. Layout identity across routes is
pinned by `src/client-urls/__tests__/client-root.test.tsx` and the
"a layout() keeps its DOM" case in both apps' `e2e/client-urls.test.ts`.

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

| Runs on…                   | Hard load | Within-group navigation                         | Nav with all loaders held              | Action                                      |
| -------------------------- | --------- | ----------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| `AdminRscLayout` handler   | yes       | no — its segment HOLDS (partial rendering)      | no                                     | no by default (`action:parent-chain-skip`)  |
| `requireAdmin` middleware  | yes       | **yes — every canonical request**               | **yes**                                | yes (wraps the revalidation render)         |
| Group loaders              | yes       | per-loader `revalidate()`, run on the server    | skipped (their `revalidate()` said so) | per-loader `revalidate()` (`isAction(ref)`) |
| Optimistic loading/pending | n/a       | renders BEFORE the response — presentation only | same                                   | n/a                                         |

Two consequences worth stating plainly:

- **Middleware does NOT run "on first encounter" only.** Every navigation
  inside the group — including a tab/param switch whose loaders all hold —
  still sends the canonical partial Flight request (that request is what
  commits URL, history, and content, and the server runs each group loader's
  `revalidate()` while it handles it). Middleware in the matched chain wraps every one of those
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

The one window that precedes middleware is the optimistic branch (the
destination component with its suspended loader reads, its `loading()`, and
`useOutlet().pending`) — presentation only, never authorization; see the
security boundary below.

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
  lane; their renderers (`Html.Meta`, `Html.Scripts`) are document-head
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
  `groupHref("/items/1")` composes the mount wherever the group is mounted,
  filling `:param` mount segments from `useParams()`.
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
  fetchable `createLoader(fn, true)` definition by id, with no route or
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
is on the `@rangojs/router/client` entry; `createLoader` / `createHandle` /
`isHandle` come from the root `@rangojs/router` entry, not `/client`, and
outside the react-server condition `createLoader` is an id-only stub —
define loaders and handles in server or shared modules, not browser-only
code). `MountContext` is the
raw context behind `useMount` — an advanced escape hatch; the hook is the
API. `initBrowserApp` / `Rango` (`./browser`) bootstrap the app above
everything and are out of group scope entirely.

Not meaningful inside a group (structural, not missing wiring):
`ParallelOutlet` (groups have no parallel slots), `useSegments` (the whole
group is one server segment — its answer inside a group does not reflect
the group's own nesting), `Html.ScrollRestoration` / `useScrollRestoration`
(module singleton — render once, in the document; the default document
includes it; mounting in a group tears down stored positions on group unmount), `Html.Meta` / `Html.Scripts` /
`NavigationProvider` (document-head / app-root components).

Programmatic navigation is mount-aware through RELATIVE paths:
`router.push("cart")` (no leading slash) resolves against the include
mount, while absolute paths stay app-absolute — the mount is scoped, so
`push("/x")` is never auto-prefixed. The URL-less router methods are
mount-independent: `refresh()` refetches the CURRENT route,
`forward()` is history traversal, and `back()` traverses history with a
first-entry guard whose fallback lands on the APP root (basename, not the
mount — consistent with absolute semantics). During the optimistic window,
`useParams` / `usePathname` / `useSearchParams` INSIDE the destination branch
report the destination's match, the mount's params included (see
"Navigation authority"), while the
same hooks in chrome outside the branch keep the COMMITTED origin values until
the canonical commit. `useRefreshLoaders` works in groups with the same
contract as `useFetchLoader` (the refresh lane IS the fetch lane, so tagged
loaders must be fetchable — `createLoader(fn, true)`; `revalidate()` is
deliberately not consulted).

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

When a reader gets the state follows the rule for every route hook here
(`src/client-urls/optimistic-location.ts`, `OptimisticLocation.state`). The
destination and the group's client layouts read the `state` a cross-route
navigation carries on their first optimistic render: history still holds the
entry being left, so the branch reads the entry the commit will push. A
reader outside the branch (chrome above the group), and one in content the
navigation keeps on screen (a same-route navigation from the committed page
never swaps; a
destination that suspends with no boundary holds the current page), keeps the
committed entry's state and changes with the canonical commit, in the same
React commit as its pathname and params. Server-set state is not part of the
optimistic entry: it arrives with that commit. A superseded or cancelled
navigation's state never reaches history or a reader outside the branch, and
a `flash` slot read in the branch is cleared from history only after the
commit. Pinned dev+prod in `e2e/client-urls-slow.test.ts` (both apps) and
`src/client-urls/__tests__/client-root.test.tsx`.

One difference between the two phases is deliberate. The optimistic entry is
the state object the navigation passed, as `buildHistoryState` assembled it,
not a copy: no history entry exists yet to hold one, and cloning here would
turn a value history cannot store into an error before the fetch instead of
at the commit, where it surfaces today. The committed value is the entry's
copy (`locationStateSnapshot` structured-clones what is new), so an
object-valued slot changes identity, not content, at the canonical commit.
The entry state is built only when the group presents the target
(`beginClientUrlNavigation`'s `buildState`).

`useReverse` works in groups through its local form: name your group routes
(`path("/items/:itemId", Item, { name: "item" })`) and the per-module gen
writer emits a sibling `<module>.gen.ts` route map for the default-exported
`clientUrls()` module, exactly as for named `urls()` modules (written by
`rango generate`, not by the Vite plugin; see [Manifests](./manifests.md)). Import that
map and `useReverse(routes)` resolves names against the include mount
(`reverse("item", { itemId })` → `<mount>/items/<itemId>`; the `/` index
collapses to the bare mount). Route names in a group stay LOCAL unless the
`include()` itself is named — an unnamed include keeps them out of the
global map entirely.

## Supported surface

`clientUrls()` supports:

- `path()`, `layout()`, `loader()`, `loading()`, a restricted `intercept()`,
  a `transition()` (ViewTransition classes/name, `viewTransition`, and a
  browser-run `when`), and a per-loader `revalidate()` inside `clientUrls()`
  that the build moves to the server;
- named client component values for paths, layouts, and intercepts, each of
  which may carry its own items as `Component.use` (below);
- mounting through `include()` in the canonical `urls()` tree, with URL and
  route-name prefixes, wrapping RSC layouts, and prefix-scoped middleware
  deriving from the server tree;
- `PathOptions` projection for `name`, `search`, `trailingSlash`, and
  `ppr` — a group route with `ppr: true | PartialPrerenderProps` gets shell
  caching exactly like a hand-written ppr page: the materialized server
  route carries the option on its manifest entry, the capture freezes the
  group's static markup (its `useSearchParams` read included — search is
  shell identity, so the frozen value matches the URL the shell serves),
  and live loaders stay the holes, per the same lane rule as a server
  route ([`/ppr` → The loader lane rule](../skills/ppr/SKILL.md#the-loader-lane-rule)).
  Actions/PE/nonce requests take the live axis;
- server `createLoader()` definitions, including non-fetchable loaders — with
  the full loader body contract: thrown `notFound()`/`redirect()` authority
  signals, handle writes (`ctx.use(Meta)({ title })`, handler parity), and
  `ctx.get(handle)` reads behind `await ctx.rendered()`;
- per-loader delivery options: `loader(Def, { ssr: false, prefetch: false },
use?)`;
- hard-load server matching, SSR, hydration, and canonical partial Flight soft
  navigation, with implicitly-suspending `useLoader` reads (a pending first
  read suspends to its `<Suspense>` boundary while the loader streams).

`transition(config)` is valid inside a `path()` use callback only and
carries `TransitionConfig`: ViewTransition classes
(`enter`/`exit`/`update`/`share`/`default`), `name`, the
`viewTransition: "auto" | false` boundary opt-out, and `when`. `when` is a
browser predicate written inline in the definition, which is already a
client module, so it needs no hoist; a non-function throws a `TypeError` at
definition time. The server projection never holds the function: it sends a
when reference (`{ definition, routeId }`, `transition-when-ref.ts`) that the
browser resolves to the route's `when` in the definition it loaded. A
cross-route navigation decides at the optimistic swap (the first
presentation), over the destination's `when` and the kept segments outside
the group, and the canonical commit reuses that decision; a same-route
navigation from the committed page never swaps and decides at the canonical
commit, where `false`
also opts out of the group's default hold. Materialization re-emits the config
in the standard child position, so the canonical commit gets the transition
config — on React 19.3+, the router's ViewTransition boundary with those
classes. It does not change whether a param nav holds: group segments are
keyed by the group, so `/items/one → /items/two` reconciles and holds with or
without `transition()` (pinned dev+prod in `e2e/client-urls.test.ts`, where
the transition-less twin holds too).
`startTransition` itself needs no opt-in here: the local presentation already
wraps its swaps, and the canonical commit is transition-driven once the
config is present.

`revalidate(fn)` is valid inside a `loader()` use callback only —
`loader(SessionLoader, () => [revalidate(fn)])` — and gives each loader its
OWN revalidation decision instead of the route-level batch. The predicate
runs ONLY ON THE SERVER, with the same argument object and type as a
`urls()` loader's (`ShouldRevalidateFn` from `@rangojs/router`):
`currentParams`, `currentUrl`, `nextParams`, `nextUrl`,
`defaultShouldRevalidate`, `context` (the server handler context, so
`context.get(var)` works), `segmentType` (`"loader"`), `actionId`,
`isAction(...refs)`, `actionUrl`, `actionResult`, `formData`, `method`,
`routeName` / `fromRouteName` / `toRouteName`, and `stale`. It runs inside
`evaluateRevalidation` (`src/router/revalidation.ts`), the code `urls()`
predicates run in. Nothing runs in the browser before the request, and the
request carries no client-computed decision: there is no hybrid, and
`X-Rango-Client-Reval` no longer exists (a browser from before the deploy
may still send it; the server ignores it).

The predicate is written in the `"use client"` module, so the build moves it.
The rango Vite plugin (`src/vite/plugins/client-urls-revalidate-hoist.ts`)
hoists each `revalidate()` argument into a server-only virtual module
`<file>?rango-revalidate`. The browser and SSR copies of the group keep a
marker, `{ $$rangoRevalidate: "<key>" }` (`client-urls/hoisted-revalidate.ts`);
the key hashes the project-relative file and the predicate's syntax tree
(formatting, comments, parentheses and TypeScript excluded, so the React
Compiler re-printing the client copy keeps it). plugin-rsc turns the RSC copy
of a `"use client"` module into client-reference proxies, so a post transform
appends `import "<file>?rango-revalidate"` to it: the predicates register
(`registerClientUrlRevalidators`, `client-urls/revalidate-registry.ts`) when
the group's module loads on the server, and a lazy `include()` stays lazy.
Route discovery serializes the SSR copy, so the projection carries a
per-loader key (`loaderRevalidate`); materialization
(`client-urls/server-projection.ts`) attaches the registered predicate to
the loader stub. A key with no registration fails loudly at materialization,
naming the loader, route and module. The scope and capture analysis is shared
with the `transition({ when })` hoist (`src/vite/plugins/hoist/scope.ts`,
`hoist/literal.ts`).

`revalidate(true)` and `revalidate(false)`, shorthand for `() => true` and
`() => false`, take a different path when the argument is a boolean LITERAL:
the plugin leaves it in place (it is the same constant in every environment),
the projection carries the boolean itself in `loaderRevalidate` beside the
keys, and materialization turns it into the constant predicate
(`toShouldRevalidateFn`, `src/router/revalidation.ts`). A module whose only
`revalidate()` calls are literals gets no `?rango-revalidate` module. Any
other argument is hoisted whatever it evaluates to: the build cannot tell an
imported boolean from an imported predicate (both are identifiers), so
instead of rejecting one it lets the server evaluate the expression. The
registry stores a boolean result as the same constant predicate, so
`revalidate(HOLD_SESSION)` with an imported flag works; it leaves a value
that is neither a function nor a boolean unregistered, and materialization
fails with the missing-key error, naming the loader, route and module. The
browser copy's argument check is dev-only: in a build the plugin checks a
literal at its call site and the server checks any other argument when it
mounts the group.

What the argument may be, and what the build rejects (every error names
`file:line:column` and starts `[rango] clientUrls() revalidate() at ...:
revalidate() runs on the server; ...`):

- **Accepted:** an inline arrow or function expression, an imported
  predicate (`revalidate(isCartAction)`), a namespace member (`P.cart`), a
  call of an imported factory (`makePredicate("cart")`). The argument may
  reference imports and globals only (`URL`, `Boolean`, `import.meta.env`).
- **A binding declared in the same `"use client"` module:** move the
  predicate to its own module without `"use client"` and import it, or write
  it inline. (The `vite-rsc-demo` `productData` predicate lives in
  `tests/vite-rsc-demo/src/urls/client-shop.predicates.ts` for this reason.)
- **A binding of an enclosing function:** read it from the predicate's
  argument.
- **`this`, `arguments`, `super`, `new.target`; `import()`; `import.meta`
  other than `import.meta.env`.**
- **A browser-only global** (`window`, `document`, `navigator`,
  `localStorage`, `sessionStorage`, `location`, `history`): put the input on
  the request (a cookie or a search param) and read it from the argument, or
  refresh with `useRefreshLoaders`.
- **An `async` or generator function; a spread, a second argument, or no
  argument; a literal that is neither a function nor a boolean** (an object,
  array, string, number or `null`).
- **An import of `client-only`, or of a module whose directive prologue is
  `"use client"`:** on the server its exports are client references. A
  `"use server"` import is fine (on the server it is the real action, which
  `isAction(ref)` matches). `server-only` and `node:` imports work on the
  server, but the import also stays in the `"use client"` module (imports are
  not pruned from the browser bundle), so it must still load in the browser.

Vitest does not run the plugin, so in unit tests the predicate stays a plain
function; test it with `runRevalidate` from `@rangojs/router/testing`, which
serves `urls()` and `clientUrls()` predicates alike.

Behaviour per request:

| Request                           | The predicate sees                                                                                                      | Default when it defers             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| JS action POST                    | `method: "POST"`, `actionId`, `actionResult` (the return value), `formData` (the last `FormData` argument), `actionUrl` | true                               |
| In-group navigation GET           | the two URLs and param sets                                                                                             | true when params or search changed |
| Prefetch partial                  | as a navigation: a prefetched in-group navigation honours the predicate                                                 | as a navigation                    |
| Stale back/forward revalidation   | `stale: true`                                                                                                           | as a navigation                    |
| Action-triggered refetch GET      | `isAction()` is false on that GET, as for `urls()`                                                                      | as a navigation                    |
| Document request, no-JS form post | not called: these hold no segments, so every loader renders (first-render guarantee)                                    | renders                            |

`currentParams` and `nextParams` are the server's route params, which include
the `include()` mount's params. `actionId` is the server's
`src/...#export` form, so `isAction(ref)` matches the action that ran. The
optimistic destination swap (`client-urls/client-root.tsx`) is unchanged: it
never read a verdict. Because `actionResult` is visible, a group can decide on
what the action returned:

```tsx
loader(CheckoutLoader, () => [
  revalidate((ctx) =>
    ctx.isAction(checkout) ? ctx.actionResult?.ok === true : undefined,
  ),
]);
```

`isAction` is the same callable matcher as on a `urls()` loader
(`isAction()`, `isAction(fn)`, `isAction(import * as Actions)`,
`isAction({ a, b })`) — not a boolean. On the server, every materialized
loader stub has a `revalidate()` that runs the predicate chain and otherwise
applies the locked default. Trust model: the verdict is computed on the
server from the request it received, like every `urls()` predicate; the
client's `_rsc_segments` still only tells the server what it holds, and a
predicate never bypasses middleware or authorization. Pinned dev+prod in
`e2e/client-urls.test.ts` (after an action, one loader of the group
refreshes while a sibling with `revalidate(false)` keeps its held value
in the same commit; `isAction(target)` vs `isAction(* as Actions)` pin
identity; an `actionResult` predicate, a `formData` predicate, a
prefetched param navigation, and a same-URL navigation that re-runs a
`revalidate(true)` loader the default holds) and in
`semantic-matrix.test.ts` row R2.

`intercept()` loaders inside `clientUrls()` apply their `revalidate()` the
same way: the build moves each predicate to the server, the projection carries
its keys on the intercept (`ClientUrlProjectionIntercept.loaderRevalidate`)
and materialization attaches them to the intercept's loader stubs, so an action
from the modal re-runs only the loaders whose predicate says so. Pinned dev+prod
in `e2e/client-urls.test.ts` ("a clientUrls() intercept loader's revalidate()
sees the action result") in both apps.

A `layout()` loader of the group revalidates as a server layout's loader
does. Its default is a layout's (`nav:non-route-skip`, `router/revalidation.ts`):
a navigation keeps it, whichever route of the layout it goes to and whatever
params or search change, a same-route param navigation included, and an
action re-runs it (`action:loader-segment`). Its `revalidate()` decides on
every navigation and action, with that default as `defaultShouldRevalidate`
and the origin route's params as `currentParams`. A loader that reads the
route's params therefore needs a rule, as on a server layout.

Two pieces make that hold across routes. The layout's loaders are copied into
every route record below it (`applyConfig`, `client-urls.ts`), and a loader
segment's id names its route (`${routeShortCode}D${index}.${$$id}`), so the
destination's copy used to be a segment the client lacked, and it ran whatever
its predicate said; with no predicate it also took the route's default and ran
on every param change. Now the projection numbers each route's layout loader
records (`ClientUrlProjectionRoute.layoutLoaders`), and materialization
records for each copy the ids the same loader has under the layout's other
routes (`client-urls/layout-loader-copies.ts`; it reads every group route's
shortCode with `peekShortCode`, also the routes an evaluation for one route
skips). A request whose page holds one of them holds the destination's copy
(`withLayoutLoaderCopies` in `router/match-api.ts`), and the copy's revalidation
input is a layout's (`isLayoutLoaderCopy` in
`router/segment-resolution/revalidation.ts`). A held copy is left out of the
response while `matched` names it under the destination route. The browser
carries the page's copy to that id (`carried` in
`browser/segment-reconciler.ts`) with its handle pushes
(`mergePartialHandleData`, `handles/pushed-by.ts`, never from a slot), so the
layout keeps its data and the canonical commit does not wait for the loader. A
navigation into the layout, from outside the group or from a group route
outside the layout, runs it. The same loader declared on another `layout()` is
another loader. Pinned by
`src/testing/__tests__/client-urls-layout-revalidate.rsc-test.tsx` and dev+prod
in both apps' `e2e/client-urls.test.ts` ("a layout() loader with no
revalidate() keeps its data and crumb across route switches, a param
navigation, a search change and Back"), which also times the canonical commit
under a 400 ms server delay.

### A component's own items: `Component.use`

You may already know the server pattern: a handler carries `.use`, and every
`path()` that mounts it gets its loader and skeleton
(`skills/handler-use/SKILL.md`). A group's components take the same shape,
in a module of their own:

```tsx
// Dashboard.tsx: no clientUrls() here
import { loader, loading, revalidate, useLoader } from "@rangojs/router/client";

export function Dashboard() {
  const { data } = useLoader(StatsLoader);
  return <StatsView stats={data} />;
}
Dashboard.use = () => [
  loader(StatsLoader, () => [
    revalidate(({ isAction }) => isAction(StatsActions)),
  ]),
  loading(<DashboardSkeleton />),
];
```

```tsx
// app.urls.tsx
"use client";
import { clientUrls } from "@rangojs/router/client";
import { Dashboard } from "./Dashboard";

export default clientUrls(({ path }) => [path("/dash", Dashboard)]);
```

`loader`, `loading`, `revalidate` and `transition` are module-level functions
in `client-urls/client-urls.ts`, exported from `@rangojs/router/client`
(`client.tsx` and `client.rsc.tsx`); the builder hands out the same ones.
`path()`, `layout()` and `intercept()` read the mounted component's `use`
(`componentUse()`), validate its items for the site, and put them BEFORE the
site's explicit items, as `mergeHandlerUse`
(`src/route-definition/resolve-handler-use.ts`) does on the server, so an
explicit `loading()` or `transition()` wins and loaders accumulate. A page
component may carry `loader()`, `loading()` and `transition()`; a layout or
intercept component `loader()` and `loading()`. `path()`, `layout()` and
`intercept()` inside a `.use` throw: the typed route map (`ExtractRoutes`) and
`.gen.ts` are computed from the builder's literal items, which is also why a
group has no `include()`. A layout's merge happens before `flattenLayout`'s
`applyConfig`, so its `.use` loaders are created once and shared as
`layoutLoaders` by every route below it (#1124/#1131). Projection and
materialization need nothing new: the flatten already folded the items into
`route.loaders`, `route.loading` and `route.transition`.

The predicate is the hard part. The component's module is not the group, and
plugin-rsc's RSC copy of the group is a client-reference proxy whose imports
are gone, so a `?rango-revalidate` import appended to the component's own
proxy would never load: nothing on the server imports the component. The
hoist therefore keys on `revalidate` imported from `@rangojs/router/client`
in any module (as well as the builder's helper), and the group's
`?rango-revalidate` module carries a **shadow graph**: it imports the
`?rango-revalidate` module of every project source file the group imports or
re-exports statically, and each of those does the same. A file with nothing
to register serves `export {}`, so the chain passes through barrels and
plain modules; a `"use server"` module ends it (no client code is behind
one). Only these small modules load on the server, never a client module's
code, and the key formula is unchanged, so a component module imported by
two groups registers once. The walk stays under the workspace root (Vite's
`searchForWorkspaceRoot`, so a component in a sibling workspace package, a
`packages/ui` beside `apps/web`, registers), outside `node_modules` and the
router's own `src/` (in this monorepo `@rangojs/router/client` resolves
there, outside `node_modules`). It ends at a module whose client copies are
loader stubs (only `createLoader()` exports, `isClientLoaderStubFile` in
`expose-ids/loader-transform.ts`): none of its imports load in the browser.
It skips `import()`: a predicate in a module the group reaches only that way
has no registration, and materialization reports the missing key. In a
build, the empty shadows tree-shake away; only modules that register reach
the RSC bundle. A `?rango-revalidate` load reads and parses its file once,
for both its registrations and its shadows.

In dev, the route-file watcher treats an edit of a module that imports
`@rangojs/router/client` and assigns a `.use`
(`isClientUrlsComponentUseSource`, `vite/discovery/client-urls-projection.ts`)
like a group edit: discovery refreshes the projections and the router's RSC
modules are invalidated, so the next request materializes the new keys. Only
when what a group reads changed, though: the watcher keeps each module's
`componentUseSignature`, a hash of its `.use` assignments' text, and a save
that keeps it (markup, hooks: page components are the most-edited files)
skips both. Its first save, and a save that adds or removes a `.use`,
re-project. An edit outside the assignments that changes what one means (a
local helper the callback calls, an import's source) is not seen until the
next `.use` edit.

The browser needs the same care. A component module that exports only
components is a Fast Refresh boundary, so a `.use` edit used to refresh the
component and leave the group's route records, flattened when the group
evaluated, as they were: the next navigation rendered the old `loading()`.
In dev, the `client-urls-component-use-hmr` plugin compares the same
signature in the client environment and, when it changed, updates the
module's importers too, so the group re-evaluates as it does when you edit
the group itself (today that ends in a page reload). A markup edit stays a
Fast Refresh, with every instance kept. Pinned by
`e2e/client-urls-hmr-component-use.test.ts`. In
Vitest, `rangoUseClientTransform` loads a group's `"use client"` project
imports as source too (`?rango-client-urls-source`): a client reference has
no `.use` to read.

A `createLoader()` definition's own `.use` is still ignored inside a group (the
materialized stub, `createLoaderStub`, has none). Pinned dev+prod by
`e2e/client-urls.test.ts` in both apps (a group whose layout and page carry
`.use`, through a barrel in cloudflare-basic), by
`e2e/client-urls-hmr-component-use.test.ts` (dev-only), and by
`src/testing/__tests__/client-urls-component-use.rsc-test.tsx`.

### After an action

A common misread is that a group hands the server only a verdict and the
browser decides the rest. It is the other way round: the browser sends the
action and the ids of the segments it holds (`_rsc_segments`), and the server
decides everything that follows while it handles that one request. The action
runs there and its return value is what the call resolves with. Each group
loader's `revalidate()` answers there, with `actionResult` and `formData`. The
browser's cache invalidation after the response is the action's call too:
`keepClientCache()` in the action suppresses it
([server-actions skill](../skills/server-actions/SKILL.md), "Client Cache
After an Action"). And a loader that throws on its rerun is reported to the
router's `onError` on the server and reaches the browser as a loader error
entry, which throws at the loader's read (below).

A form's React state survives the revalidation, as on a `urls()` route: the
action commit renders into the mounted tree (`server-action-bridge.ts`, the
`normal` case), so a controlled input keeps what the user typed.

### A loader that fails on its rerun after an action

The action has run and returned by the time its loaders rerun, so the failure
cannot undo it. The contract is the one a navigation already has, and it is
the same on every route: a group route or a `urls()` route, with or without
`loading()`, called directly or from `<form action>`, `useActionState` or
`useTransition`.

- The call resolves with the action's return value.
- The loader throws in place, at its `useLoader` read. The nearest boundary
  to the read catches it: the app's own React error boundary when one sits
  around the read, else the `errorBoundary()` that covers the segment (for a
  group, around the `include()` mount), else the router's root boundary.
- What sits outside that boundary keeps its instance and React state: a form
  next to the failed list keeps what the user typed. Loaders that reran
  without error commit their new data in the same commit.
- The error is reported to `onError` on the server (phase `"loader"`,
  `isPartial: true`) and in the browser as `revalidationError` on the
  action's `useAction()` state, with `error` null and `result` set.
- A later action or navigation whose rerun succeeds clears an
  `errorBoundary()` fallback the failure left. The app's own boundary resets
  by its own rule (see the reset key below).

```tsx
<StockBoundary resetKey={revision}>
  <StockList /> {/* useLoader(StockLoader) throws here on a failed rerun */}
</StockBoundary>
<SaveForm /> {/* await saveStock(sku) resolves: { saved: true } */}
```

Why this one and not the alternatives? Before it, the outcome depended on
where the decode ran. The action lane settled loader data before it
committed, and without `loading()` the segment's loaders took the aggregate
decode in the build, where an entry with `ok: false` and no fallback made
`decodeLoaderResults` throw: `renderSegments` rejected, the commit was
dropped, and the call rejected with the loader's error although the action
had returned. A `<form action>` then handed that rejection to the nearest
React error boundary above the form, so the root one replaced the page. With
`loading()` on a `urls()` route the decode ran in `LoaderResolver` while
React rendered, above the route's content: the call resolved and the root
boundary replaced the page, skipping any boundary inside the route. With an
`errorBoundary()` the build planted its fallback in place of the segment's
`StreamedLoaderErrorBoundary`, so a boundary the app put nearer the read was
skipped, and the wrapper chain lost a link (an `I5 drift` the e2e had to
allow). Three outcomes for one event. A plain navigation had none of these
problems: it hands each loader's entry to its read and lets it throw there.
Keeping the old data instead (the first draft of #1129) was rejected: it
differs from navigation and from `errorBoundary()`, and it shows stale data
silently unless the app reads the report.

How it works. The action lane no longer decodes loader results in the build,
and since dc-t65 neither does any `forceAwait` lane (a fully prefetched
click, back/forward, cached segments, leaving an intercept, stale
revalidation): only the document lane does. A stale revalidation whose
loader threw commits nothing at all and is logged (`partial-update.ts`). Every settled lane takes
`buildLoaderStreams` with `settle` (`segment-system.tsx:323`): every loader is
still awaited before the commit, so the commit is one commit with no
fallback, and each settled entry is handed to its read through
`loaderStreams`, the channel a navigation uses. A plain error stays out of
the build-time decode, so its `errorBoundary()` fallback rides the throw as
the `LOADER_ERROR_FALLBACK` marker (`decode-loader-results.ts`
`decodeLoaderEntry`) and `StreamedLoaderErrorBoundary` renders it
(`route-content-wrapper.tsx:86`) unless a nearer boundary catches first.
`notFound()` and `redirect()` are control flow and are still placed at build
time, in the segment's content. A `redirect()` must never take the
document-lane shortcut that replaces the whole page there
(`!settleLoaders && isLoaderRedirectNode` in `segment-system.tsx`): a delete action
whose item loader then redirects to the list would unmount every layout
before the redirect navigation mounted them again. The planted node replaces
the segment's `StreamedLoaderErrorBoundary`-wrapped content, so the wrapper
chain loses a link while it redirects (an `I5 drift` the redirect e2e
allows, as main does); the layouts above keep their instance. The read
decodes a settled entry synchronously (`use-loader.tsx:74`),
so nothing suspends (suspense-contract.md, rule 3) and the wrapper chain is
the same on every lane (rule 4).

The report is separate from the render. After the action lane's
`renderSegments`, which awaited the entries anyway, the bridge scans the
loader segments of the response for a thrown error (`revalidationErrorOf`,
`decode-loader-results.ts:107`, called at `server-action-bridge.ts:864`)
and passes the first to `handle.complete(result, revalidationError)`
(`:915`). Every refetch an action runs goes through `partial-update.ts` in
`action` mode, which renders the same way and resolves with its own scan
(`partial-update.ts:1235`, and `:1317` for a full-update fallback, which
renders on the plain lane, so the pending call waits for its loaders only to
report, as the partial lane's commit does); `refetchRoute` hands it back as
the action's `revalidationError`. That covers the refetch after several
actions (`consolidation-needed`), after a navigation during the action that
kept the history entry, and after an HMR update. An answer cached while a
sibling is still fetching (`concurrent-skip`, `:831`) is never rendered and
reports nothing: it resolves when its metadata lands, as before, and the
sibling's refetch reruns those loaders and reports to the action that ran
it. Waiting for loader chunks of a response it never renders would hold the
call for its slowest loader, and fail it if the stream were cut. The refetch
after a navigation to another history entry runs in the background after the
call resolved, so there is no pending call to report to.

The reset. `StreamedLoaderErrorBoundary` used to clear a caught marker only
when its `resetKey` (the segment's route and params) changed, so an
`errorBoundary()` fallback stayed after a later action or same-route
navigation whose rerun succeeded. Its `reset` prop is now the segment's
route-and-params key followed by the `loaderData` of each loader of the
segment and of its ancestors (`segment-system.tsx:695`), and it resets when
one of them is a different object (`route-content-wrapper.tsx:72`). The
ancestors matter because a read walks up the chain: a route that reads its
layout's loader catches that loader's marker at its own boundary, so it has
to reset when the layout's loader reruns, not only its own (the first
version of this fix missed that, and a navigation's fallback for a layout
loader stayed after a good action). A rerun brings a new entry; a held loader
keeps its segment and so its entry, so a tree that did not rerun the failed
loader keeps the fallback, and an unrelated re-render never resets. The
reset happens in the render that hands the boundary the new data, so it
cannot race the commit, and a healthy boundary resets to the state it is
already in: nothing remounts. One cost: a boundary whose own failure is held
while an ancestor's loader reruns catches the throw again, and React mounts
its fallback anew.

An app's own boundary resets by its own rule. One that resets when the
action settles races the commit, which React may not have rendered yet. The
pattern that cannot race is the router's: key the reset on data that reruns
with the failed loader and is read outside the boundary, so the reset lands
in the same render as the new data (the e2e fixture's
`ActionFailureAppBoundary`, keyed on a revision loader; the vite-rsc-demo
`/errors/revalidation` pages).

What it does not cover, each keeping its earlier behaviour:

- An `intercept()` slot's loaders ride on the slot as one aggregate, decoded
  by the slot's `LoaderResolver` while React renders, above the slot's
  content. So do a parallel slot's loaders under the slot's own `loading()`
  (`segment-system.tsx:850`, slots take no streams).
- A no-JS form post renders the whole document after the action, so a loader
  that throws there behaves as on a page load, with no call to resolve.

One more thing worth knowing about the report: `useAction` drops an action's
state once the action has settled and its entry leaves the event controller
(100 ms after settling, `event-controller.ts` `doSettle`), and
`revalidationError` goes with `error` and `result`. A component that wants to
keep a notice up latches it (the skill's example, and the e2e fixture's
`af-revalidation-error` line).

For a failure the user should see in place of the data without an error
boundary, return it from the loader as data (`{ ok: false, reason }`) and
render it at the read. The skill carries the example. One caveat: the failure
is then an ordinary value, so a `cache()` on the loader, a `ppr` bake of an
`ssr: false` loader, or a prerender stores and serves it like any other. A
thrown error is never stored: the miss path stores only what `execute()`
returned (`cache/read-through-swr.ts:159`), and a background revalidation
that throws keeps the stale entry. Cache the call the loader makes instead
and convert the throw in an uncached loader.

Pinned dev+prod in `e2e/action-failure.test.ts` (router test-app) and
`tests/cloudflare-basic/e2e/action-failure.test.ts`, body
`tests/shared-e2e/src/action-failure-scenario.ts`: a group and its `urls()`
twin, each with and without `loading()`, and the group under an
`errorBoundary()`, each called directly, from a `<form action>`, and together
with a slow action so the refetch after both throws again, with the page
around the read marked to prove it kept its instance; with no app boundary,
the `errorBoundary()` fallback and its reset after a later action (after an
action's failure and after a navigation's), and the root boundary; and a
delete action whose item loader then throws `redirect()`, with the layout
marked to prove it kept its instance. Semantic matrix row R3 pins it on the
`urls()` route. Unit: `src/__tests__/action-loader-error-in-place.test.tsx`
(real React over the action lane: the boundary at the read, a `redirect()`
that keeps the layout, a layout loader's fallback that clears),
`streamed-loader-error-boundary.test.tsx` (the reset),
`segment-system.test.tsx`, `server-action-bridge.test.ts`,
`partial-update.test.ts`, `event-controller.test.ts`. Userland:
`serveShellRequest(...).readAction()` in
`src/testing/__tests__/client-urls-revalidate.rsc-test.tsx`.

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

A browser without JavaScript sees only what the first flush carries: a
boundary that completes later ships its fallback and swaps the content in with
a script that never runs. A client component a loader's answer draws under an
inline `<Suspense>` is in the first flush when the loader settles before it
(a fast loader usually does; `ssr: false` guarantees the loader's data, not
the module load a build's first render of a reference still waits for). That
used to differ in
dev. plugin-rsc tags client reference ids with a per-render cache tag in dev, so
its SSR loader memo missed on every request and each reference loaded through
the module runner again, an RPC per import on workerd; the boundary completed
after the shell flushed. `renderHTML` (`src/ssr/index.tsx`,
`settleDocumentClientLoads`) now holds a dev document's first flush, when the
shell is ready, until the client-reference loads still pending at that moment
have settled, bounded at 5 seconds. Only that snapshot counts: a load starts
when the row naming it arrives, so its data is already in hand, while a load
a later row requests belongs to data the first flush would not carry in a
build. With nothing pending there is no wait at all. The first version kept
waiting until no new load appeared, and that let late data into the first
flush: a `loading()` skeleton and a streamed error's fallback stopped
streaming in dev (`e2e/loading-fn.test.ts`, `e2e/error-boundary.test.ts`).
Loads are attributed per document through an `AsyncLocalStorage` entered
around the decode, so a concurrent render's loads never hold it. A build does
not run it: its loader memo hits after the first load per isolate.
Pinned dev+prod in `e2e/client-urls-loader-element.test.ts` and
`tests/cloudflare-basic/e2e/client-urls-loader-element.test.ts` (body
`tests/shared-e2e/src/loader-element-scenario.ts`), and by
`src/ssr/__tests__/ssr-handler.test.tsx` ("dev client-reference loads").

Settled data is not always enough on its own, either. A `useActionState` form
under an inline `<Suspense>` whose loader is `ssr: false` shipped its fallback
on every no-script load of the fixture, dev and production (#1138). Here is
why. Fizz's `useActionState` binds the state onto the action, and encoding a
bound server reference for `<form action>` throws the Flight client's
`encodeFormData` thenable once. It settles in microtasks, but by then Fizz has
left its opening status, so `pingTask` retries the form on a `setTimeout(0)`
turn. `renderToReadableStream` resolves at shell-ready, so the first read beat
that turn. Now `renderHTML` (`settleSsrFalseFirstFlush`) gives Fizz up to
three `setTimeout(0)` turns before the first flush on a document whose
payload carries `awaitBeforeFlush`. It stops as soon as `allReady` settles,
and a document whole at shell-ready takes no turn. Each turn retries one
generation: the form, a `formAction` button inside it, and the same form
behind `lazy()` are one, two and three. A boundary waiting on I/O still
streams its fallback, sent at most three turns later. A document without an
`ssr: false` loader returns at shell-ready as before, so its `loading()`
skeletons still lead the first flush. Pinned dev+prod in
`e2e/client-urls-ssr-false-form.test.ts` and
`tests/cloudflare-basic/e2e/client-urls-ssr-false-form.test.ts` (body
`tests/shared-e2e/src/ssr-false-form-scenario.ts`), and by
`src/ssr/__tests__/ssr-handler.test.tsx` ("ssr: false first flush").

`loader(Def, { prefetch: false }, use?)` keeps one loader out of the route's
`<Link>` prefetches, as on a server route
([prefetch-false.md](../../../docs/design/prefetch-false.md), "`clientUrls()`
routes"). The flag is projected with the loader's index
(`deferrableLoaderIndices`) and materialized onto the server stub, so a
prefetch of the route defers it while its segment is new to the client. An
in-group click still presents the destination at the click; with the
prefetch adopted it then commits the prefetched tree at once (the URL, the
history entry and the unflagged loaders' data), `useOutlet().pending` ends
with that commit, and one fill request runs only the flagged loaders.

The flag skips a loader in a prefetch only when the loader is new to the page.
A loader already on screen is never deferred: if its revalidation (its
`revalidate()` or the default) re-runs it, it runs in the prefetch with the
rest of the destination; otherwise it is held. The familiar case is a
same-route navigation (`/product/a` to `/product/b`), where the loader keeps
its segment id. A group `layout()` loader behaves the same on every route of
its layout: the page holds its copy (see the `revalidate()` paragraph on
`layout()` loaders above), so a prefetch between two of those routes defers
nothing for it, and one that enters the layout defers it. A flagged `loader()`
on a server layout above the group is deferred while that layout is new to
the client. `loading()` inside `clientUrls()` takes no
options, a flagged `loading()` on a server layout above the group defers
nothing for its routes. On an `intercept()` loader the flag works as in
`urls()`: the projection carries it on the intercept
(`ClientUrlProjectionIntercept.deferrableLoaderIndices`), and an in-group
prefetch of the intercept's target defers the loader; the click, which takes
the server-route path (the optimistic presentation declines for an intercept
target), opens the modal at once and one fill runs it. Pinned dev+prod by the
`clientUrls():` cases of `tests/shared-e2e/src/prefetch-false.ts` and
`e2e/client-urls.test.ts` in the router test-app and cloudflare-basic.

INSIDE `clientUrls()` the DSL is deliberately minimal: client route groups
exist for transition performance — instant optimistic presentation, held
data, streaming reads — not for full-feature routing. `middleware()`,
`include()`, `parallel()`, `cache()`, and error or not-found boundaries are
not supported inside the group and are not a roadmap; they belong to the
surrounding server tree the include mounts into. (Boundaries are a
deliberate exclusion: a server-tree boundary around the mount catches
loader-thrown signals from the group with the uniform server-resolved
envelope, and inside the group plain React error boundaries work — every
component is a client component, and a streamed loader rejection throws to
the boundary above its `useLoader` read.) Every helper rejection and the
option-level rejections (any path-option key other than `name`, `search`,
`trailingSlash`, and `ppr`, such as `intercept`, `parallel`, or
`revalidate`) are pinned by tests; `ppr` PROJECTS (see Supported surface).
`Static()`/`Prerender()` handler VALUES are also
rejected with a targeted message: build-time handlers are server-DSL
surface — their code cannot live in a "use client" bundle and their render
runs at build. Shell caching of a group route is the `ppr` path option;
build-time prerendering belongs to the server tree around the include.

Composition limits around a client include, locked explicitly:

- `parallel()` slots are handler-valued, so a client include is structurally
  unrepresentable inside one; parallel routes attach to server routes only.
- Canonical revalidation of a committed page follows ordinary server
  semantics; the group's loaders participate per-loader through
  server-run `revalidate()` predicates, hoisted out of the `"use client"`
  module by the build (see Supported surface). Predicate functions never cross
  the projection boundary at runtime: the browser and SSR copies hold a key and
  the server holds the function. Segment-level
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
     JSON-projectable form:
     `intercept(slot, ".localTarget", Component, use?)` where the target is a
     dot-local NAMED route in the same
     definition and `use` may contain `loader()`/`loading()` only. No `when`,
     no middleware. Scoping is MODULE-LOCAL by contract: only navigations
     whose origin is one of the group's routes, in the target's mount
     instance (the same `:locale` under `include("/:locale", ...)`), render
     the modal; any other origin commits the full route. Materialization enforces this with a
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
  non-intercepted navigation loses its optimistic presentation, never the
  reverse.
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

The optimistic destination branch (the destination component and its
`loading()` UI) can render before global authentication or authorization
middleware completes. It has no new loader data (a read of the destination's
own loaders suspends; a loader of a `layout()` the navigation keeps shows what
the page already had), so it cannot reveal protected data, but it does reveal
the destination's shell. Do not put protected data or sensitive route-state details
in a group component outside a loader read. There is no per-route opt-out: if
revealing the destination shell itself is sensitive, define that route in
`urls()` instead of a client route group.
