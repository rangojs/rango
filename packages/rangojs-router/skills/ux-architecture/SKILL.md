---
name: ux-architecture
description: Architect a Rango app so navigation is instant and stable — when a server urls() page or a clientUrls() group wins, where layouts, loaders, Suspense boundaries, revalidate() rules, prefetch, transition(), intercept() modals and actions go, with worked recipes (shop, dashboard tabs, settings forms, search filters, a modal over a list) and the anti-patterns behind remounts, skeleton flashes and slow clicks. Use when designing or reviewing a Rango app's routing, layout, loading or navigation UX, choosing between urls() and clientUrls(), placing a loader or a boundary, writing revalidate() rules, or debugging a remount, a re-shown fallback or a click that waits.
argument-hint: "[shop|dashboard|settings|search|modal]"
---

# Navigation UX architecture with urls() and clientUrls()

The primitive skills tell you what each helper does. This one tells you where
each piece goes so a click shows the next page at once, nothing on screen
remounts, and no skeleton flashes over content that was already there. Read
the contract first, then the decision tree, then the recipe closest to your
app.

## Not this skill if…

- You want to lay out the `urls()` files for an app type (a SaaS dashboard, a
  multi-app host, a static site): that is the **app-structure** skill. This
  skill only sketches the routes each UX recipe needs.
- You want a primitive's full API: `/client-urls`, `/loader`, `/layout`,
  `/route`, `/links`, `/intercept`, `/view-transitions`, `/server-actions`,
  `/hooks`. Section 6 maps each topic to its skill.

## 1. The UX contract

Four promises. Rango keeps its half; the app keeps the other half by where it
puts things.

| Promise                                                                    | What Rango does                                                                                                                                                                                                                                                                      | What your app must do                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A prefetched click shows the next page, or its skeleton, at the click.** | A click that adopts a complete prefetch commits from it with no request. Inside a `clientUrls()` group a click to another route of the group renders the destination in the browser before the server answers, prefetched or not. The router adds no wait of its own.                | Let the links people click prefetch. Keep what a prefetch runs cheap (`prefetch: false` on expensive loaders). Give each slow read a boundary, so the destination can show before that read's data arrives.           |
| **Deferred parts reveal by React's rules.**                                | Each loader streams on its own and each read gets one stable promise. The router never steers React's scheduling.                                                                                                                                                                    | Place a `<Suspense>` wherever the page may show in parts. Expect React's timing: a fallback that appeared stays at least 300 ms (section 5).                                                                          |
| **Nothing that stays on screen remounts.**                                 | A layout stays mounted across navigations between its routes. A group's route segment is keyed by the group, so param and search changes reconcile. A search-only navigation reconciles everywhere. An action's revalidation renders into the mounted tree, so React state survives. | Put shared chrome in a layout, not in a route component. Never key a boundary or a wrapper by the URL. On a server route whose param changes should keep the page (`/product/a` to `/product/b`), add `transition()`. |
| **A fallback shows only for loading that is new.**                         | A navigation that mounts nothing new commits in a transition, so React keeps revealed content until the new data lands. A loader whose `revalidate()` holds is not re-run, so nothing waits for it.                                                                                  | Write `revalidate()` rules that hold what the navigation did not change. Return transient loader failures as data instead of throwing them.                                                                           |

What is a bug and what is the design: a fallback for a boundary the navigation
mounts, or for data the navigation fetches, is the design. A remount of
something that stays on screen, or a fallback over content whose data was in
hand, is a router bug: report it.

**Judge it in a build, at a realistic distance.**

- Dev loads client references per render, so a boundary new to the page can
  show its fallback for 300 ms in dev where a build shows none
  (`docs/internal/suspense-contract.md`, "Dev is not production"). Dev also
  prefetches nothing by default (`defaultPrefetch` is `"none"` in development
  and `"viewport"` in production, `src/router/prefetch-default.ts`).
- Add a 300 to 500 ms delay to every server response (a middleware that
  sleeps) before you compare clicks. At a local 10 ms, React's 300 ms throttle
  is the slowest thing on the page and decides everything you see.

## 2. The decision tree

### 2.1 A server urls() page or a clientUrls() group?

| Pick                                   | When                                                                                                                                                                                                                                                                                    | What you get                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server `urls()` route with a handler | Pages people mostly reach by a document load (marketing, docs, articles, landing pages). Pages built from server components you don't want to ship as client code. Routes that need `cache()`, `Prerender()`, `parallel()`, `middleware()` or an `errorBoundary()` on the route itself. | The handler renders on the server, and `cache()` or a prerender can store its output. A click with no prefetch waits for the server before the page changes; a prefetched click does not.                                                                                                                                                                                                                  |
| A `clientUrls()` group                 | An area where people move a lot inside one layout: dashboards, admin, settings, tabs, filters, master and detail. Pages that are client components anyway.                                                                                                                              | The browser matches the group, so a click to another route of the group renders the destination at once, before the server answers. Param and search changes on one route reconcile and hold. There are no handlers: every read is a `useLoader` under its own boundary. A document load is still rendered on the server, and `loader(Def, { ssr: false })` puts a loader's data and handles in that HTML. |

Two limits of a group decide some cases:

- The destination renders before middleware has run. Its loader reads wait
  for the server, but everything outside a loader read shows at the click. If
  showing a page's shell before authorization is a problem, define that route
  in `urls()` (`docs/client-urls.md`, "Security boundary").
- Inside the group there is no `middleware()`, `include()`, `parallel()`,
  `cache()`, `errorBoundary()` or `notFoundBoundary()`. They go on the server
  tree around the `include()`. For caching, put `"use cache"` on the function
  a loader calls.

### 2.2 Combine them: server structure around the group

The common shape: a server layout holds what every area shares, middleware
guards, an error boundary catches what loaders throw, and each area is a
group mounted with `include()`.

```tsx
// src/urls.tsx (server)
import { urls } from "@rangojs/router";
import appUrls from "./app/app.client.js"; // clientUrls() group
import settingsUrls from "./settings/settings.client.js"; // clientUrls() group
import { AppShell, AppError, HomePage } from "./shell.js";
import { SessionLoader } from "./session.loader.js";
import * as AccountActions from "./account.actions.js";
import { requireSession } from "./middleware.js";

export const urlpatterns = urls(
  ({
    path,
    layout,
    include,
    loader,
    middleware,
    errorBoundary,
    revalidate,
  }) => [
    layout(AppShell, () => [
      middleware(requireSession),
      errorBoundary(<AppError />),
      loader(SessionLoader, () => [
        revalidate(({ isAction }) =>
          isAction() ? isAction(AccountActions) : undefined,
        ),
      ]),
      path("/", HomePage, { name: "home" }),
      include("/app", appUrls, { name: "app" }),
      include("/settings", settingsUrls, { name: "settings" }),
    ]),
  ],
);
```

On a navigation inside one group:

| Piece                  | Runs?                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `requireSession`       | Yes, on every request, a tab switch whose loaders all hold included.                                                               |
| The `AppShell` handler | No. Its segment is held. A `revalidate()` on the layout opts it in, and its handler time then adds to every navigation it runs on. |
| `SessionLoader`        | Held on navigation (the default for a loader above the route). After an action, only an account action re-runs it.                 |
| The group's loaders    | Each by its own `revalidate()`, run on the server.                                                                                 |

Pinned by `tests/vite-rsc-demo/e2e/client-shop-guards.test.ts` (dev and
production): the middleware stamps every request while the outer layout's run
count holds.

**Navigating between two groups** (`/app/...` to `/settings/...`) is a server
navigation: each group matches only below its own mount
(`src/client-urls/navigation.ts`, `stripMountPrefix`), so nothing renders
before the response, and the destination group mounts with its layouts (a
group's segment key is its mount, `src/segment-system.tsx`). The server shell
above both and its loaders stay as they are. That is the expected shape, not a
remount bug. Two consequences:

- Chrome that must survive moving between areas (the account menu, a cart
  badge, global navigation) goes in the server layout above the groups.
  Chrome that belongs to one area (its section nav, its tab bar) goes in that
  group's `layout()`.
- Prefetch the links that cross areas: the adopted prefetch makes that click
  commit at once like any prefetched click.

A large app follows the same shape: server layouts for the first page and
the chrome, loaders for user and app data, and one group per area (app, auth,
onboarding, settings). How to cut an app into areas and files is the
app-structure skill.

### 2.3 Where a layout goes

|                      | A server `layout()` around the `include()`                                                                            | A client `layout()` inside the group                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stays mounted across | Every navigation below it, between groups too.                                                                        | Navigations between the routes it wraps (#1124). The route component inside it mounts anew on a route change; it is a different page.             |
| Its own code re-runs | Never on a navigation or an action by default. `revalidate()` opts in; the handler time adds to each such navigation. | It is a client component: it re-renders with React state, never re-fetched.                                                                       |
| Can hold             | Server components, `parallel()` slots, `middleware()`, `errorBoundary()`, `intercept()`.                              | Client components only. `useOutlet()` gives `content` and `pending`, which is true from the click to the commit of a navigation inside the group. |
| A `loader()` on it   | Held on navigation, re-run after every action unless its `revalidate()` narrows that.                                 | Re-runs when params or search change and after every action unless its `revalidate()` says otherwise (and see "Known gaps").                      |
| Use it for           | App-wide chrome and its data: session, account menu, cart badge, notifications.                                       | Area chrome: section nav, tabs, a busy indicator from `pending`.                                                                                  |

A server layout handler that reads request data (a cookie, the session,
`ctx.params`) renders it once and keeps it. Data that must refresh goes in a
loader read by a client component (section 2.4), or in middleware `ctx.set()`
consumed by a loader. See `/rango`, "Passing data down the tree".

### 2.4 Where loaders go, and their revalidate() rules

Put a loader on the segment whose lifetime matches the data, and read it with
`useLoader` in the component that shows it, under its own boundary. Never
fetch in a handler with `await ctx.use(Loader)` when a read site can do it:
the handler then waits for the data, a route without `loading()` waits with
it, and under `cache()` or a `ppr` shell the value bakes in.

Defaults, when no `revalidate()` decides (`/loader`, "`revalidate()` return
shapes"):

| Declared on                              | On a navigation                      | After an action |
| ---------------------------------------- | ------------------------------------ | --------------- |
| A server `path()`, or anything inside it | Re-runs when params or search change | Re-runs         |
| A server `layout()` above the route      | Held                                 | Re-runs         |
| A `clientUrls()` `path()` or `layout()`  | Re-runs when params or search change | Re-runs         |
| Any segment the page does not hold yet   | Runs; a predicate cannot stop it     | Runs            |

The four predicates most apps need (all run on the server, in `clientUrls()`
too):

```ts
import type { RevalidateParams } from "@rangojs/router";
import * as CartActions from "./cart.actions.js";
import { saveProfile } from "./profile.actions.js";

// 1. Data keyed by a param: re-run when the param changes; hold on tab and
//    search changes and on actions.
export function bySlug({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}: RevalidateParams): boolean {
  if (isAction()) return false;
  return currentParams.slug !== nextParams.slug
    ? defaultShouldRevalidate
    : false;
}

// 2. Data driven by the query string: re-run when the search changes.
export function bySearch({
  isAction,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: RevalidateParams): boolean {
  return !isAction() && currentUrl.search !== nextUrl.search
    ? defaultShouldRevalidate
    : false;
}

// 3. Data an action changes: after an action, only these actions re-run it;
//    on a navigation, keep the default.
export const byCartAction = ({ isAction }: RevalidateParams) =>
  isAction() ? isAction(CartActions) : undefined;

// 4. Data that depends on what the action returned.
export const bySavedProfile = ({ isAction, actionResult }: RevalidateParams) =>
  isAction(saveProfile) ? actionResult?.ok === true : undefined;
```

`bySlug` is the vite-rsc-demo's `productData`
(`tests/vite-rsc-demo/src/urls/client-shop.predicates.ts`). Rules that keep
them right:

- A boolean is a hard answer, `undefined` defers to the default. Pick by the
  default you are changing: the ternary narrows a loader that re-runs after
  every action; `isAction(X) || undefined` adds a re-run where the default
  skips (a server layout's own handler).
- Never `() => false` on data keyed by a param: product to product then keeps
  showing the first product. Never `() => true` as a habit: it re-runs on
  every navigation and action, and where its read is on screen the navigation
  either waits for it (a held commit) or shows that read's fallback again (an
  urgent one).
- Chrome data that does not depend on the URL, on a group `layout()`: a bare
  `isAction(CartActions)` is right there. It is a hard `false` on navigation,
  which is what a cart badge wants, and `true` after a cart action. This is the
  vite-rsc-demo's `CartLoader` rule.
- A predicate in a `clientUrls()` module may reference imports and globals
  only. A predicate shared by several loaders goes in a module without
  `"use client"` and is imported (`/client-urls`, "Revalidation runs on the
  server").
- A prefetch runs the predicates too, so a loader that holds costs nothing in
  the prefetch of a tab switch.
- Unit-test them with `runRevalidate` (`/testing`).

### 2.5 loading() or an inline Suspense

Default to an inline `<Suspense>` directly above each `useLoader` read that
can be slow. What the URL already decides (a heading, the tabs, a breadcrumb
from params) paints at once, and each read fills on its own. A route-level
`loading()` is one skeleton for the whole route content.

| Use                           | When                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline `<Suspense>` per read  | The default. Several reads with different latencies; a page whose frame is meaningful before the data.                                                                                                                                                                                                                                   |
| `loading()` on a server route | The route's handler is async (with `loading()` it streams instead of holding the response; `docs/internal/execution-model.md`, "Limitation: a Response from an async handler under `loading()` is not a redirect"), or the content means nothing until its data lands. Keep inline boundaries inside it.                                 |
| `loading()` on a group route  | The route-level boundary around the destination the browser renders at the click. Same-route navigations hold whatever you declare.                                                                                                                                                                                                      |
| No boundary at all            | A read with no boundary suspends to the nearest one above: on a server route that is a layout's `loading()` or `<Suspense>`, so a larger area shows a fallback; with none, nothing of the new page shows until the data lands. In a group the destination is not shown at the click; React keeps the old page until the server's commit. |

Which fallbacks show: a boundary the navigation mounts shows its fallback; a
boundary already revealed holds its content on a navigation that mounts
nothing new; a fallback that appeared stays at least 300 ms.

`useLoader().isLoading` is true on a reader that still shows the old data
while a held navigation fetches the new one. Dim it instead of adding a
boundary (`/hooks`, `data.md`).

### 2.6 Prefetch

A prefetch is a navigation sent early: the server renders the destination's
handlers and loaders for it, from the page you are on (`/links`, "What a
prefetch renders"). A click that adopts a complete prefetch commits with no
request. Entries live 300 s by default (`prefetchCacheTTL`) and an action
drops them unless it calls `keepClientCache()`.

The rule: **prefetch broadly, and flag what is expensive.**

- Links people click: leave the production default `viewport`, or set it
  (`createRouter({ defaultPrefetch })`, `<Link prefetch>`). Long lists of
  secondary links (related items): `hover`. Unbounded combinations (filter
  chips, arbitrary query pages) and rarely followed links to expensive pages:
  `none`, or `data-prefetch-scope="none"` on their container.
- `loader(Def, { prefetch: false })` for a loader that is expensive (a slow
  query, a third-party API, a large payload), personalised (every visible link
  runs it again for that user), or rarely needed (a reviews tab). Cheap
  loaders stay prefetched, so their data is there at the click.
- The trade-off, measured on a `clientUrls()` tab in a consumer app (dev, a
  loaded machine): with the tab's loader flagged, a hover then a click 150 ms
  later showed the content in 843 to 918 ms; with the tab prefetched whole, in
  77 to 157 ms. The flagged click pays the fill request and then React's
  300 ms on the tab's fallback.
- A click that adopts a prefetch with a flagged loader shows the page at once
  and sends one fill request for the flagged loaders. Read a flagged loader
  under its own `<Suspense>`: with no boundary, React keeps the page being
  left until the fill answers.
- On a server route, `loading(fallback, { prefetch: false })` keeps the whole
  entry behind that fallback out of the prefetch (`/route`, "`loading()`
  options"). A group's `loading()` takes no options.
- When the target's `revalidate()` reads `currentUrl` or `currentParams`, give
  the Link `prefetchKey=":source"`: the default prefetch entry is shared by
  every source page (`src/browser/react/Link.tsx`, `prefetchKey`).

### 2.7 transition() and view transitions

- On a server route, `transition()` makes its navigations commit in a
  transition and drops params from the route's React key, so `/product/a` to
  `/product/b` keeps the page on screen until the new data lands instead of
  remounting it under a skeleton (`src/segment-system.tsx`,
  `inTransitionScope`). `transition({ viewTransition: false })` gives the hold
  without the animation.
- In a group the hold needs no `transition()`: group segments are keyed by the
  group. There `transition()` adds the view-transition animation only, and
  goes inside a `path()`.
- Put `transition()` at one level, not on every layout, and mount the
  `<ParallelOutlet>` of a modal slot in a layout, not in a route component
  that has a transition (`/view-transitions`, "Recommendations").
- A `transition({ when })` that returns `false` commits that navigation
  urgently: no hold, the skeleton streams. Keep it to the navigations it names.
- `<Link revalidate={false}>` or `setSearchParams(next, { revalidate: false })`
  changes the URL and the hooks at once with no server request, for view state
  that needs no data (grid or list, an open panel). The pathname must stay the
  same.

### 2.8 intercept() modals and parallel() slots

- A modal over a list is an `intercept()` declared on the layout that wraps
  both the list and the target route, rendered by
  `<ParallelOutlet name="@modal" />` in that layout. A click opens the modal
  and the list stays mounted under it; a document load of the URL renders the
  full page; Back closes the modal. Recipe 3.5.
- An intercept's loaders each take their own `revalidate()`, and a flagged
  `prefetch: false` loader opens the modal at once with its `loading()`. Its
  errors render the declaring layout's `errorBoundary()`.
- Inside a group, `intercept()` takes a dot-local named target in the same
  definition and `loader()`/`loading()` only, and only navigations from inside
  the group open it.
- `parallel()` is server-only. A slot on a standalone layout is kept across
  navigations and actions unless its `revalidate()` opts in; a slot with its
  own `loading()` streams on its own. Use it for chrome that fills
  separately, such as a sidebar (`/parallel`).

### 2.9 Actions

- What re-runs by default: the route, its loaders and what is inside its
  `path()`; loaders on layouts above. A layout's own handler and its parallel
  slots do not. The server decides per loader with each `revalidate()`
  (`actionResult` and `formData` included), in the action's own response.
- The commit renders into the mounted page: nothing remounts, a controlled
  input keeps what was typed, and `useActionState` keeps its state.
- Return validation failures from the action as state for `useActionState`;
  throw only for the unexpected (`/server-actions`, "Error Handling").
- Return a loader's transient failure (a flaky upstream, a rate limit) as
  data, `{ ok: false, reason }`, and render it where the data goes. A throw on
  the re-run after an action rejects a direct `await action()` call, or hands
  the error to the nearest error boundary, which replaces the page and its
  form (`/client-urls`, "A loader that fails on its rerun").
- `keepClientCache()` in an action that changed nothing keeps the prefetches
  and the history cache.
- `useOptimistic` gives feedback before the action answers.

### 2.10 Updates you did not make: three channels

| The change                                         | The tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your own mutation                                  | A server action plus `revalidate()` rules (`isAction(ref)`, `actionResult`). The server re-runs what the action touched in the same response; nothing else to call.                                                                                                                                                                                                                                                                                                                           |
| Out of band: a push, polling, a REST call, a login | `useLoader(L).load()` (also `refetch`): a plain `load()` of a route-registered loader updates every reader of it. `refreshGroup` on reads plus `useRefreshLoaders()` refreshes several loaders at once. Both need a fetchable loader, `createLoader(fn, true)`; a plain one answers 403. `router.refresh()` re-renders the current route's server data and keeps client state. `invalidateClientCache()` marks the history cache stale and drops prefetches when the change makes them wrong. |
| Shared server caches (other users' data)           | Tags: `cache({ tags })` or `cacheTag()`, then `updateTag()` in the action (awaitable, the action's response reads fresh) or `revalidateTag()` from a webhook. `revalidate()` is not cache invalidation (`/cache-guide`).                                                                                                                                                                                                                                                                      |

### 2.11 Handles: titles and breadcrumbs

- Push from the loader that has the data: `ctx.use(Meta)({ title })`,
  `ctx.use(Breadcrumbs)({ label, href })`. This is how a group, which has no
  handlers, sets them (`/breadcrumbs`, "Pushing from Loaders").
- Read them in chrome with `useHandle(Breadcrumbs)`, in a layout that stays.
- `loader(Def, { ssr: false })` puts its pushes in the document's HTML (a
  title for search engines, a real 404 from `notFound()`). The document waits
  for that loader; flag only the one that needs it.
- A loader an action skips keeps its title and crumbs
  (`tests/shared-e2e/src/held-handles-scenario.ts`), and a link back to a page
  you visited keeps that page's (#1115).

## 3. Recipes

Each recipe is a sketch: the placements are the point. Imports of your own
modules are left out where they are obvious.

### 3.1 A shop: catalog, product, cart badge, add to cart

Reference implementation: `tests/vite-rsc-demo/src/urls/client-shop.client.tsx`
(the group), `client-shop-guard.tsx` (the server layout and middleware around
it), `client-shop.predicates.ts`, and the mount in `src/urls/index.tsx`, in
the router repository (not shipped in the package). Its e2e suites
`tests/vite-rsc-demo/e2e/client-shop-*.test.ts` pin each behaviour in dev and
production. The sketch below differs in one place: the cart loader sits on the
server layout, because a group `layout()` loader re-runs on every cross-route
navigation today (see "Known gaps").

```tsx
// src/urls.tsx (server)
import { urls } from "@rangojs/router";
import shopUrls from "./shop/shop.client.js";
import { CartLoader } from "./shop/loaders.js";
import * as CartActions from "./shop/cart.actions.js";

export const urlpatterns = urls(
  ({ layout, include, loader, revalidate, errorBoundary }) => [
    layout(ShopShell, () => [
      errorBoundary(<ShopError />),
      loader(CartLoader, () => [
        revalidate(({ isAction }) =>
          isAction() ? isAction(CartActions) : undefined,
        ),
      ]),
      include("/shop", shopUrls, { name: "shop" }),
    ]),
  ],
);
```

```tsx
// src/shop/shell.tsx (server component) and cart-badge.tsx ("use client")
function ShopShell() {
  return (
    <>
      <header>
        <Link to="/shop">Shop</Link>
        <Suspense fallback={<span>Cart</span>}>
          <CartBadge />
        </Suspense>
      </header>
      <Outlet />
    </>
  );
}

function CartBadge() {
  const { data } = useLoader(CartLoader);
  return <span>Cart ({data.count})</span>;
}
```

```tsx
// src/shop/shop.client.tsx
"use client";
import { Suspense } from "react";
import { clientUrls, Link, useLoader, useOutlet } from "@rangojs/router/client";
import { bySlug, bySearch } from "./predicates.js"; // no "use client" there

function ShopLayout() {
  const { content, pending } = useOutlet();
  return <main aria-busy={pending}>{content}</main>;
}

function ProductPage() {
  return (
    <>
      <Tabs /> {/* from the URL: paints at the click */}
      <Suspense fallback={<InfoSkeleton />}>
        <ProductInfo /> {/* useLoader(ProductLoader) + <AddToCartForm> */}
      </Suspense>
      <Suspense fallback={<RelatedSkeleton />}>
        <Related /> {/* <Link prefetch="hover"> per item */}
      </Suspense>
      <Suspense fallback={<ReviewsSkeleton />}>
        <Reviews />
      </Suspense>
    </>
  );
}

export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(ShopLayout, () => [
    path("/", Catalog, { name: "index" }, () => [
      loader(ProductsLoader, () => [revalidate(bySearch)]),
    ]),
    path("/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, { ssr: false }, () => [revalidate(bySlug)]),
      loader(RelatedLoader, () => [revalidate(bySlug)]),
      loader(ReviewsLoader, { prefetch: false }, () => [revalidate(bySlug)]),
    ]),
  ]),
]);
```

Why each placement:

| Placement                                              | Why                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog and product in one group                       | A card click renders the product page at the click; the filters and tabs are same-route navigations that hold.                                                                                                                                                                            |
| `CartLoader` on the server layout, ternary predicate   | Held on every navigation (a server layout loader's default), re-run only after a cart action. It survives entering and leaving the group. The badge updates in the add-to-cart response itself.                                                                                           |
| `ProductLoader` with `ssr: false`                      | The product's title and a real 404 for an unknown slug are in the document's HTML. Client navigations still stream it.                                                                                                                                                                    |
| `bySlug` on the product loaders                        | Product to product re-runs them; a tab switch and an add to cart hold them. One action, three outcomes: the badge refreshes, product and related keep their data (`client-shop-cart.test.ts`).                                                                                            |
| `ReviewsLoader` flagged `prefetch: false`              | Every visible card prefetches; reviews are the expensive, rarely read part. The click still shows the product at once and the reviews fill behind their own boundary. A prefetch from another product page (the related links) still runs it: only a segment new to the page is deferred. |
| One `<Suspense>` per section                           | A slow product loader fills its section without holding the related list, and the other way round (the demo's product loader takes 2 s).                                                                                                                                                  |
| Cards `prefetch="viewport"`, filters `prefetch="none"` | A visible card is likely to be clicked; filter combinations are unbounded (the demo's `FilterLink`).                                                                                                                                                                                      |
| `pending` from `useOutlet()` on the layout             | The progress signal for a filter change, whose grid holds instead of flashing (`client-shop-filters.test.ts`).                                                                                                                                                                            |

The add-to-cart form uses `useActionState` and an action that returns its
result; nothing else is needed for the badge.

### 3.2 Dashboard tabs

```tsx
// src/dashboard/dashboard.client.tsx, mounted under the app's server shell
"use client";
import { clientUrls, Link, useOutlet } from "@rangojs/router/client";
import { bySearch } from "../predicates.js";

function DashboardLayout() {
  const { content, pending } = useOutlet();
  return (
    <section aria-busy={pending}>
      <nav>
        <Link to="/dashboard">Overview</Link>
        <Link to="/dashboard/traffic">Traffic</Link>
        <Link to="/dashboard/reports">Reports</Link>
      </nav>
      {content}
    </section>
  );
}

export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(DashboardLayout, () => [
    path("/", Overview, { name: "overview" }, () => [loader(KpiLoader)]),
    path(
      "/traffic",
      Traffic,
      { name: "traffic", search: { range: "string?" } },
      () => [loader(TrafficLoader, () => [revalidate(bySearch)])],
    ),
    path("/reports", Reports, { name: "reports" }, () => [
      loader(ReportsLoader, { prefetch: false }),
    ]),
  ]),
]);
```

- **A tab with its own data is a route.** A click to another route of the
  group renders it at the click, prefetched or not; the layout and its tab bar
  keep their instance (#1124, pinned by "a layout() keeps its DOM across
  navigations between its routes" in both apps' `e2e/client-urls.test.ts`).
- **A view option over the same data is a search param** (a date range, a
  sort). Its navigation stays on the route, so the browser renders nothing
  early (`src/client-urls/client-root.tsx`: a same-route intent from the
  committed page never swaps); the page holds with `pending` until the server
  answers, one round trip, unless the link was prefetched: then it commits at
  the click. The prefetch is cheap when the loaders' rules hold them. Change the range with
  `setSearchParams({ range }, { replace: true, scroll: false })`; a pure view
  toggle takes `revalidate: false`.
- `ReportsLoader` is slow and rarely opened: flag it, read it under its own
  `<Suspense>`. `KpiLoader` and `TrafficLoader` are cheap: leave them
  prefetched so the tab is complete at the click.
- The org switcher, the user menu and their loaders go in the server layout
  above the group (section 2.2): they stay when the user goes from the
  dashboard to settings, which is a different group.

### 3.3 A settings area with forms

```tsx
// src/settings/settings.client.tsx
"use client";
import { clientUrls } from "@rangojs/router/client";
import { saveProfile } from "./profile.actions.js"; // "use server"

export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(SettingsLayout, () => [
    path("/profile", ProfilePage, { name: "profile" }, () => [
      loader(ProfileLoader, () => [
        revalidate(({ isAction, actionResult }) =>
          isAction()
            ? isAction(saveProfile) && actionResult?.ok === true
            : undefined,
        ),
      ]),
    ]),
    path("/notifications", NotificationsPage, { name: "notifications" }, () => [
      loader(NotificationPrefsLoader),
    ]),
    path("/billing", BillingPage, { name: "billing" }, () => [
      loader(InvoicesLoader, { prefetch: false }),
    ]),
  ]),
]);
```

```tsx
// the profile form
function ProfileForm() {
  const { data } = useLoader(ProfileLoader);
  const [state, formAction, isPending] = useActionState(saveProfile, null);
  if (!data.ok) return <p role="status">{data.reason}</p>;
  return (
    <form action={formAction}>
      <input name="name" defaultValue={data.profile.name} />
      {state?.ok === false && <p role="alert">{state.error}</p>}
      <button disabled={isPending}>Save</button>
    </form>
  );
}
```

- `saveProfile` returns `{ ok: true }` or `{ ok: false, error }`; it never
  throws for bad input, so the page stays and shows the error. The predicate
  re-runs `ProfileLoader` only when the save succeeded: a refused save re-runs
  nothing.
- `ProfileLoader` returns `{ ok: false, reason }` when its upstream fails,
  instead of throwing: the page and the form stay mounted and the next re-run
  replaces the message.
- The commit after the action renders into the mounted page: nothing
  remounts and React state survives. React itself resets a `<form action>`'s
  uncontrolled fields once the action function finishes without throwing; to
  keep a refused value in its field, make the input controlled or return the
  submitted value in the action state.
- The header's name and avatar come from the server shell's `SessionLoader`
  with `isAction() ? isAction(saveProfile) : undefined` (or the module's
  actions), so a saved name shows in the header in the same response.
- With JavaScript off the form still posts: a no-JS form post renders every
  loader, whatever the predicates say.
- Each settings page is a route of one group so the section nav stays and
  page changes render at the click. Billing's invoices are expensive: flagged.

### 3.4 Search with filters

Search results are often a landing page from a link or a search engine, so
this one is a server route. The same holds in a group.

```tsx
// src/search/urls.tsx (server)
export const searchPatterns = urls(({ path, loader, revalidate }) => [
  path(
    "/",
    SearchPage,
    {
      name: "results",
      search: { q: "string?", category: "string?", page: "number?" },
    },
    () => [
      loader(ResultsLoader), // the route default: re-run on every search change
      loader(FacetsLoader, () => [
        revalidate(
          ({ isAction, currentUrl, nextUrl, defaultShouldRevalidate }) => {
            if (isAction()) return false;
            const keys = ["q", "category"];
            return keys.some(
              (k) =>
                currentUrl.searchParams.get(k) !== nextUrl.searchParams.get(k),
            )
              ? defaultShouldRevalidate
              : false;
          },
        ),
      ]),
    ],
  ),
]);
```

```tsx
// SearchPage: a cheap, synchronous server handler
function SearchPage() {
  return (
    <>
      <SearchBox /> {/* client: setSearchParams with replace, see below */}
      <Suspense fallback={<FacetsSkeleton />}>
        <Facets /> {/* <Link prefetch="none"> per filter chip */}
      </Suspense>
      <Suspense fallback={<ResultsSkeleton />}>
        <Results /> {/* useLoader(ResultsLoader); dim on isLoading */}
      </Suspense>
    </>
  );
}
```

- A search-only navigation mounts nothing new, so it commits in a transition
  and the results already on screen stay until the new ones land, in a server
  route as in a group (`src/browser/partial-update.ts`, `isSameStructureNav`).
  Show progress with `useLoader(ResultsLoader).isLoading` on the results, or
  `useNavigation()`'s `isStreaming`.
- The route handler re-runs on every search change (route default), so it
  must stay cheap and must not await data. The data lives in loaders.
- Facets depend on the query and category, not on the page number: their
  rule holds them when only `page` changes.
- Filter chips: `prefetch="none"` (unbounded). The next-page link can take
  `prefetch="hover"`.
- Typing: the setter replaces the whole query string, so merge, and replace
  the history entry instead of pushing one per keystroke (debounce it):
  `setSearchParams((prev) => { prev.set("q", q); prev.delete("page"); return prev; }, { replace: true })`.

### 3.5 A modal over a list

```tsx
// src/photos/urls.tsx (server), mounted with include("/photos", photoPatterns, { name: "photos" })
export const photoPatterns = urls(
  ({ path, layout, intercept, loader, loading, errorBoundary, revalidate }) => [
    layout(GalleryLayout, () => [
      errorBoundary(<GalleryError />),
      path("/", Gallery, { name: "gallery" }, () => [loader(PhotosLoader)]),
      path("/:id", PhotoPage, { name: "photo" }, () => [loader(PhotoLoader)]),
      intercept("@modal", ".photo", <PhotoModal />, () => [
        layout(<ModalChrome />), // the overlay; closes with router.back()
        loader(PhotoLoader, () => [revalidate(byId)]), // bySlug, on :id
        loader(CommentsLoader, { prefetch: false }, () => [
          revalidate(({ isAction }) =>
            isAction() ? isAction(CommentActions) : undefined,
          ),
        ]),
        loading(<ModalSkeleton />),
      ]),
    ]),
  ],
);

function GalleryLayout() {
  return (
    <>
      <Outlet />
      <ParallelOutlet name="@modal" />
    </>
  );
}
```

- The intercept is declared on the layout that wraps both routes, and the
  slot is rendered by that layout, so the gallery stays mounted under the
  modal and opening it fires no layout view transition.
- Grid thumbnails prefetch the modal from the gallery page (a target an
  intercept claims is prefetched per source page). `CommentsLoader` is
  flagged: the modal opens at the click with its skeleton and one fill brings
  the comments.
- Posting a comment from the modal re-runs the modal's loaders whose rule
  says so (`CommentsLoader`; `byId` holds the photo on actions), and the modal
  keeps its React state.
- A document load of a photo URL renders `PhotoPage`, a shareable full page.
- Put an authorization guard in route `middleware()` on an enclosing layout or
  in the loaders, not in the intercept's own `middleware()`: that one does not
  run when the modal is served from `cache()` or a `Prerender()` (see "Known gaps").
- Inside a `clientUrls()` group the same shape is
  `intercept("@modal", ".photo", PhotoModal, () => [loader(PhotoLoader), loading(<ModalSkeleton />)])`,
  with a named target in the same definition; only navigations from inside
  the group open it.

## 4. Anti-patterns

Each entry: what the user sees, why, the fix.

1. **One big `<Suspense>` (or only a route `loading()`) around the page.** The
   whole page is a skeleton until its slowest read lands; the heading and tabs
   the URL already decided don't show. Fix: one boundary per read that can be
   slow (2.5).
2. **A boundary or wrapper keyed per navigation** (`<Suspense key={pathname}>`,
   `key={params.id}` on a wrapper). Every navigation remounts the subtree: its
   fallback shows again, inputs, scroll and child state reset, images reload.
   A changed key always remounts in React. Fix: no URL-derived keys; let the
   router hold and dim with `isLoading`.
3. **A server layout that reads request data and is expected to refresh** (the
   user's name from the session, a param-derived label). It stays as first
   rendered: a login, an action or a param change does not update it. Fix: a
   loader read by a client component in the layout, with a `revalidate()` rule;
   or `revalidate()` on the layout, paying its handler time on every navigation
   it re-runs on.
4. **`revalidate(() => true)` everywhere.** Every navigation and action re-runs
   the loader, prefetches carry it, and where its read is on screen the
   navigation waits for it or shows its fallback again. Fix: rules that name
   what changes the data (2.4).
5. **`revalidate(() => false)` on data keyed by a param.** Product to product
   keeps showing the first product. Fix: compare the identifying param.
6. **A loader that throws a transient failure.** After an action, a direct
   `await action()` rejects although the action ran, or an error boundary
   replaces the page and the user's form. Fix: return `{ ok: false, reason }`
   and render it at the read (2.9).
7. **Reading a loader above the boundary meant to catch it.** The read
   suspends to the next boundary up: a larger area shows a skeleton, or in a
   group the destination is not shown at the click at all; an error escapes to
   a higher boundary (the vite-rsc-demo's `SsrCategoryProbe` notes a 404 turned
   into a 500 without its containment). Fix: call `useLoader` inside the
   component the boundary wraps.
8. **Shared chrome in a route component.** It remounts on every navigation to
   another route: its state resets and its own fallbacks show again. Fix: move
   it into a `layout()` (a group `layout()` keeps its instance across its
   routes; a server layout across everything below it).
9. **`useEffect` fetching.** A spinner after the page has shown, nothing
   prefetched or server-rendered, no re-run after an action, races on fast
   navigations. Fix: a loader read with `useLoader`; `useFetchLoader` for
   on-demand reads (search-as-you-type, load more).
10. **A server route with a param and no `transition()`, expected to hold.**
    `/product/a` to `/product/b` remounts the route under its skeleton (its key
    carries the params). Fix: `transition()` (or
    `transition({ viewTransition: false })`), or make it a group route.
11. **An area split into several groups, or a group per page.** Navigating
    between groups is a server navigation: nothing shows before the response,
    and the destination group's layout mounts. Fix: one group per area, with
    the area's chrome in its `layout()` and app chrome on the server layout
    above.
12. **An async handler that awaits data, on a route without `loading()`.** The
    response waits for it; with `loading()` the whole route waits behind one
    skeleton. Fix: move the data to a loader read under its own boundary.
13. **Prefetching everything with an expensive loader.** Forty visible cards
    are forty renders of that loader for this user. Fix: `prefetch: false` on
    the expensive loader, `prefetch="none"` on unbounded links (2.6).
14. **Navigation status readers inside the destination's `loading()`.** In a
    group, a `useNavigation()` or `useLinkStatus()` reader inside content the
    click swaps out unmounts at the click. Fix: put status readers in chrome
    that stays (`/client-urls`, "Pitfalls").
15. **An effect keyed on a location-state object.** In a group the object is
    the one the navigation passed until the commit, then the history entry's
    copy: the effect runs twice. Fix: key it on a primitive field.

## 5. Known gaps

These are open. Each says what you see and what to do meanwhile.

- **A group `layout()` loader re-runs on every navigation between
  different routes of the group, whatever its `revalidate()` returns.** A
  layout's loaders are copied into each route's record
  (`src/client-urls/client-urls.ts`, `applyConfig`) and loader segment ids are
  per route (`src/router/segment-resolution/revalidation.ts`), so the
  destination's copy is new to the page and runs. Measured with
  `serveShellRequest`: a layout loader with `revalidate(() => false)` ran 0
  times on a param navigation and 1 time on `/items/a` to `/`. Cost: one
  wasted run per cross-route click, and the commit of the navigation waits for
  it where the layout reads it. The click itself still shows the destination
  at once (fixed in 0.24.2, #1131). Workaround: put the loader on a server
  `layout()` around the `include()` and read it from a client component there
  or inside the group (`useLoader` looks up through enclosing layouts,
  `src/use-loader.tsx`). Measured the same way, a server layout loader with
  the cart ternary ran 0 times on param, search and cross-route navigations in
  the group and on entering it, and once on a cart action. Check
  `CHANGELOG.md` for the fix before you rely on either behaviour.
- **An `intercept()`'s own `middleware()` does not run when the modal
  is served from a `cache()` hit or a `Prerender()` target.** Only the live
  path calls it (`src/router/intercept-resolution.ts`); the cache-hit path
  resolves the intercept's loaders only. A guard there is skipped for cached
  or prerendered modals. Put the guard in route middleware or in the loaders,
  which run on both paths.
- **React's fallback throttle.** React commits a Suspense retry no sooner than
  300 ms after any boundary on the page last showed or hid its fallback. A
  skeleton that appeared stays at least that long, and a read that resolves
  after its parent was revealed shows its own fallback and starts the 300 ms
  again. After a click that adopts a `prefetch: false` prefetch, a late read
  can show a fallback the plain click never shows, and its content can come up
  to 300 ms later than the plain click's (`/route`, "`loading()` options",
  Limits; `docs/design/prefetch-false.md`, "When the holes resolve"). Rango
  leaves this to React by design: no placeholders or re-anchored timers to
  dodge it.
- **A view transition that changes nothing.** On a route with `loading()` and
  `transition()` whose loaders take longer than about 320 ms, React's retry of
  the boundary starts a view transition with the fallback still up, and the
  content lands about 250 ms after its data (#1078). Escape hatches:
  `/view-transitions`, "A view transition that changes nothing under
  `loading()`".
- **A client component first used by the click.** In a build, a client
  component at the top of a route's content whose module the document has not
  used yet makes the Flight client wait for its `import()`, so the route's
  `loading()` shows for 300 ms (`docs/internal/suspense-contract.md`, "What
  the audit does not see").
- **A group navigation commits the destination 2 to 4 times.** The instance
  is the same throughout (local state survives, mount effects run once), but
  the one-commit target of #1079 is not met yet
  (`docs/internal/suspense-contract.md`, rule 5).
- **The URL leads a held page.** `location` and the address bar move when the
  response arrives; where React then holds the page being left, they are ahead
  of the screen for that wait (#1046, `/hooks`, `navigation.md`).

## 6. Where the details live

| Topic                                                              | Skill                                    |
| ------------------------------------------------------------------ | ---------------------------------------- |
| How to lay out `urls()` files and areas for an app type            | app-structure                            |
| `clientUrls()` surface, hooks inside a group, action failure table | `/client-urls`                           |
| Loader options, `revalidate()` return shapes, `ssr` and `prefetch` | `/loader`                                |
| Layout forms, outlets, layout revalidation, contracts              | `/layout`                                |
| `path()`, `loading()` options, handler data ownership              | `/route`                                 |
| Link prefetch strategies, `data-prefetch-scope`, URL generation    | `/links`                                 |
| Modals                                                             | `/intercept`                             |
| Slots                                                              | `/parallel`                              |
| `transition()`, view transitions and their costs                   | `/view-transitions`                      |
| Actions, `useActionState`, `keepClientCache()`                     | `/server-actions`                        |
| `useLoader`, `load()`, `refreshGroup`, `useNavigation`             | `/hooks`                                 |
| Titles and breadcrumbs                                             | `/breadcrumbs`                           |
| Cache tags and invalidation                                        | `/cache-guide`, `/caching`, `/use-cache` |
| `runRevalidate`, `serveShellRequest`, dev and production e2e       | `/testing`                               |
