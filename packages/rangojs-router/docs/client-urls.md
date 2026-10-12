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
optimistic branch in every case.

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

Pinned dev+prod in `tests/vite-rsc-demo/e2e/client-shop-filters.test.ts`
(hold + pending on a filter nav) and `e2e/client-urls.test.ts` (param-nav
hold with and without `transition()`); the server-route remount default stays
pinned in `e2e/same-route-nav.test.ts`.

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
report the destination's local match (see "Navigation authority"), while the
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
navigation keeps on screen (a same-route navigation never swaps; a
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
navigation never swaps and decides at the canonical commit, where `false`
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
  argument; a non-function value** (an object, array or string literal).
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
refreshes while a sibling with `revalidate(() => false)` keeps its held value
in the same commit; `isAction(target)` vs `isAction(* as Actions)` pin
identity; an `actionResult` predicate, a `formData` predicate, and a
prefetched param navigation) and in `semantic-matrix.test.ts` row R2.

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
router's `onError` on the server and reaches the page as a loader error entry.

A form's React state survives the revalidation, as on a `urls()` route: the
action commit renders into the mounted tree (`server-action-bridge.ts`, the
`normal` case), so a controlled input keeps what the user typed.

### A loader that fails on its rerun after an action

The action has run and returned by the time its loaders rerun, so the failure
cannot undo it. What the browser does depends on two things: whether an
`errorBoundary()` sits above the route (for a group, around the `include()`
mount), and, for a `urls()` route, whether the route has a `loading()`:

| The route                                                  | Action called directly (`await action()`)                                                                                                         | From `<form action>`, `useActionState`, `useTransition`                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A group route, or a `urls()` route without `loading()`     | The call rejects with the loader's error (`"An error occurred"` in a build); nothing of that revalidation commits; page data and React state stay | React hands the rejection to the nearest React error boundary above the form; with none of the app's, `RootErrorBoundary` replaces the page |
| A `urls()` route with `loading()`                          | The call resolves; the commit renders, the read throws, and the nearest React error boundary catches it (`RootErrorBoundary` if the app has none) | The same                                                                                                                                    |
| Under an `errorBoundary()` (for a group, around the mount) | Its fallback replaces the route; the page and its form state unmount                                                                              | The same                                                                                                                                    |

Why the rows differ. The action lane settles loader data before it commits
(`renderSegments` with `isAction`, `server-action-bridge.ts:848`). Without
`loading()` the segment's loaders take the aggregate path: a loader entry with
`ok: false` and no fallback makes `decodeLoaderResults` throw
(`decode-loader-results.ts:121`, called from `segment-system.tsx:745`), so
`renderSegments` rejects before `onUpdate`, the commit is dropped, and the
rejection becomes the action call's. With `loading()` on a `urls()` route the
lane awaits the same data (`segment-system.tsx:651-662`) but hands it to
`LoaderBoundary`, which decodes it while React renders
(`route-content-wrapper.tsx:351`): `renderSegments` resolves, the action
resolves, and the throw happens in the committed render. A group route never
takes that branch (`segment-system.tsx:638`, `!clientGroup && loading`), so
its `loading()` changes nothing here. With an `errorBoundary()`,
`loader-resolution.ts` renders its fallback into the entry,
`decodeLoaderResults` takes it as the segment's `errorFallback`
(`decode-loader-results.ts:109`), and the commit renders it in place of the
route.

The rejected call is the action's error for `useAction` too: the bridge's
`catch` calls `handle.fail(error)`, and the event controller marks a disposed
action completed, so an action started in its 100 ms settle window is not
counted as concurrent (no consolidation refetch, #675).

The pattern to recommend for a failure the user can retry: return it from the
loader as data (`{ ok: false, reason }`) and render it at the read. The action
resolves, the page and its state stay, and the next rerun replaces the
message. The skill carries the example. One caveat: the failure is then an
ordinary value, so a `cache()` on the loader, a `ppr` bake of an `ssr: false`
loader, or a prerender stores and serves it like any other. A thrown error is
never stored: the miss path stores only what `execute()` returned
(`cache/read-through-swr.ts:159`), and a background revalidation that throws
keeps the stale entry. Cache the call the loader makes instead and convert the
throw in an uncached loader.

Pinned dev+prod in `e2e/action-failure.test.ts` (router test-app) and
`tests/cloudflare-basic/e2e/action-failure.test.ts`, body
`tests/shared-e2e/src/action-failure-scenario.ts`: a group and its `urls()`
twin, each with and without `loading()`, and the group under an
`errorBoundary()`. The response itself is pinned through
`serveShellRequest({ action })` in
`src/testing/__tests__/client-urls-revalidate.rsc-test.tsx`; the settle-window
fix in `src/__tests__/event-controller.test.ts` and
`src/__tests__/server-action-bridge.test.ts`.

`intercept()` loaders inside `clientUrls()` do not apply their `revalidate()`
yet (a known gap, left for a follow-up), so do not rely on it there. The build
still checks those predicates like any other, so one that captures a binding of
the `"use client"` module fails the build although nothing runs it: import it
from a module without `"use client"`, or drop it.

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
`settleDocumentClientLoads`) now holds a dev document's first flush until the
client-reference loads its Flight decode requested have settled, bounded at 5
seconds. Loads are attributed per document through an `AsyncLocalStorage`
entered around the decode, so a concurrent render's loads never hold it. A
build does not run it: its loader memo hits after the first load per isolate.
Pinned dev+prod in `e2e/client-urls-loader-element.test.ts` and
`tests/cloudflare-basic/e2e/client-urls-loader-element.test.ts` (body
`tests/shared-e2e/src/loader-element-scenario.ts`), and by
`src/ssr/__tests__/ssr-handler.test.tsx` ("dev client-reference loads").

`loader(Def, { prefetch: false }, use?)` keeps one loader out of the route's
`<Link>` prefetches, as on a server route
([prefetch-false.md](../../../docs/design/prefetch-false.md), "`clientUrls()`
routes"). The flag is projected with the loader's index
(`deferrableLoaderIndices`) and materialized onto the server stub, so a
prefetch of the route defers it while its segment is new to the client. An
in-group click still presents the destination at the click; with the
prefetch adopted it then commits the prefetched tree at once (the URL, the
history entry and the unflagged loaders' data), `useOutlet().pending` ends
with that commit, and one fill request runs only the flagged loaders. A
`layout()` loader with the flag is flagged on every route below it, and a
flagged `loader()` on a server layout above the group is deferred too while
that layout is new to the client. `loading()` inside `clientUrls()` takes no
options, a flagged `loading()` on a server layout above the group defers
nothing for its routes, and `intercept()` loaders accept the flag and ignore
it, as in `urls()`. Pinned dev+prod by the `clientUrls():` cases of
`tests/shared-e2e/src/prefetch-false.ts` in the router test-app and
cloudflare-basic.

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
middleware completes. It has no loader data (every `useLoader()` read
suspends), so it cannot reveal protected data, but it does reveal the
destination's shell. Do not put protected data or sensitive route-state details
in a group component outside a loader read. There is no per-route opt-out: if
revealing the destination shell itself is sensitive, define that route in
`urls()` instead of a client route group.
