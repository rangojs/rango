---
name: app-structure
description: Concrete urls() layouts for whole Rango apps, with the file tree, router.tsx, the root urls.tsx with sync include() of section modules, and where middleware, server layouts, clientUrls() groups, response routes, caching, prerender, PPR and boundaries sit. Recipes for a large signed-in app with a protected admin area (auth, onboarding, app, settings and admin as clientUrls() groups under one server shell), several apps under createHostRouter(), a docs site or blog, and a shop. Use when starting or restructuring a Rango app, laying out urls() files, splitting an app into sections or separate apps, or setting up a dashboard, SaaS, multi-app, static or content site, or e-commerce app.
argument-hint: "[large-app|multi-app|content-site|e-commerce]"
---

# App structure recipes

The other skills cover one primitive each. This one puts them together into
whole apps: for each common shape, the file tree, `router.tsx`, the root
`urls.tsx` with a sync `include()` per section, each section module, and
where middleware, layouts, `clientUrls()` groups, response routes, caches,
prerender and PPR, and error boundaries go, with the reason for each
placement.

## Not this skill if…

- You want the mechanics of one primitive: `include()` and helper factories
  are `/composability`, router options are `/router-setup`, route groups of
  client components are `/client-urls`, hostname routing is `/host-router`.
- You want navigation UX inside one of these shapes: where loaders,
  `loading()`, inline `<Suspense>` and `revalidate()` go so that navigations
  show the next page early and never flash a fallback. That is the
  `ux-architecture` skill.

## Pick a recipe

| You are building                                                                 | Shape                                                                                                                | Read                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A large signed-in app (SaaS, dashboard) with a protected admin area              | One server shell; `auth`, `onboarding`, `app`, `settings` and `admin` as `clientUrls()` groups; guards as middleware | [`./large-app.md`](./large-app.md)       |
| Several apps on one deployment: marketing on the apex, `app.`, `admin.`, `docs.` | `createHostRouter()` with one `createRouter()` per app                                                               | [`./multi-app.md`](./multi-app.md)       |
| A docs site or a blog                                                            | A module per section; `Prerender`, `Static`, `ppr` shells, on-demand refresh                                         | [`./content-site.md`](./content-site.md) |
| A shop                                                                           | `ppr` catalog and product pages, a live cart, a server-rendered checkout                                             | [`./e-commerce.md`](./e-commerce.md)     |
| A small tool, or the first version of anything above                             | One `urls()` module                                                                                                  | [A small app](#a-small-app-one-module)   |

Each recipe file stands alone. Start with the one that matches, and come back
here for the rules they share.

## The rules every recipe follows

1. **The route tree has its own module.** `router.tsx` imports `urlpatterns`
   from `urls.tsx` and calls `createRouter()`. Nothing the route tree imports
   may import the router: a module that does is an import cycle, and when it
   loads first (a test, a script) `createRouter().routes()` receives
   `undefined` and throws `Cannot read properties of undefined (reading
'handler')`. Code that needs the router at request time, such as a webhook
   that calls `router.prerender()`, lives next to the entry
   ([`./content-site.md`](./content-site.md#the-publish-webhook)).
2. **One module per section, mounted with a sync `include()` and a name.**
   `include("/settings", settingsUrls, { name: "settings" })`. The root module
   then reads as a table of contents: every URL prefix and who owns it.
3. **Identity in global middleware, gates in route middleware.**
   `router.use()` wraps every request: renders, server actions, and
   fetchable-loader calls (`load()`, `refetch`, `useRefreshLoaders()`). Route
   `middleware()` wraps renders only, on document loads and on every client
   navigation. So the session is resolved in `router.use()`, the redirect to
   the login page is a `middleware()` around the includes it guards, and every
   server action and fetchable loader authorizes itself.
4. **Chrome that spans sections is a server `layout()` above their
   includes.** It renders on the document load and is kept on every
   navigation below it. Chrome of one area is that area's own layout.
5. **Data comes from loaders,** read with `useLoader()` in the component that
   shows it. Public pages get `ppr` or `Prerender`, an expensive read shared
   by many users gets `"use cache"` and a tag, and per-user data stays in live
   loaders.
6. **Commit the generated files.** `router.named-routes.gen.ts` sits next to
   the router; the Vite plugin rewrites it on `vite dev` and `vite build`, and
   `rango generate src/router.tsx` writes it without Vite (CI, a fresh clone).
   `rango generate src` also writes a `*.gen.ts` beside every `urls()` and
   `clientUrls()` module, the local `routes` map that `useReverse(routes)` and
   `Handler<".name", routes>` read. Regenerate and commit both whenever a
   `path()` or `include()` changes.
7. **Link by name, never by string. Inside a module, by local name, never by
   its mount.** Moving an `include()` mount or renaming a path then updates
   every link; a hardcoded `"/app/projects"` breaks silently. A local name
   (`ctx.reverse(".x")`, `useReverse(routes)`) resolves against wherever the
   module is mounted and fills the mount's params (`:locale`, `:accountId`,
   `:projectId`) from the current URL, so the module never knows its prefix
   and can be mounted twice. The maps exist only if generated and committed
   (rule 6).
   - Server handlers, layouts, parallel slots, loaders: `ctx.reverse(".local")`
     or `ctx.reverse("global.name")`; both fill mount params, and explicit
     params override (`{ locale: "de" }` switches; `{ locale: undefined }`
     drops an optional `/:locale?` and throws for a required `/:locale`).
     `scopedReverse` types the local names.
   - Middleware `ctx.reverse` takes global names only and fills nothing, so
     pass every param; a missing one throws `Missing param`.
     `getRequestContext().reverse` in route middleware does fill; in global
     middleware only after `next()`.
   - An action's `getRequestContext().reverse("global.name")` fills from the
     page URL; use global names.
   - A client component linking within one module or `clientUrls()` group:
     `useReverse(routes)`, `routes` imported from that module's `.gen.ts`
     (`import { routes } from "./app.client.gen"`). Mount-aware, fills params
     from `useParams()`, and only that module's names reach the client bundle.
     Wrap each map once in `src/lib/links.ts`
     (`export const useAppReverse = () => useReverse(appRoutes)`) and call
     that hook in components under that module's own mount (`/links`).
   - A URL from another module: generate it on the server and pass it as a
     prop or loader data. Another module's map, or `router.named-routes.gen.ts`
     under a mount, gives a wrong URL with no error (the latter is correct
     only at the root mount and pulls every route name into the client
     bundle).
   - Not these: `useParams().accountId` in a template string, `ctx.params`
     passed down as props, a "current account" context, `href("/path")` for
     anything but static paths. `useHref()` and a relative `router.push()`
     fill the mount's params but take unchecked paths: prefer `useReverse`.
8. **Rewrite is middleware only.** A maintenance page, a flag or an alias
   URL is a `router.use()` middleware that does `throw rewrite("name")`; a
   lock answers mutations with a `Response` or adds `.disallowMutations()`,
   since a rewrite moves a server action to the target. The address bar
   keeps the visitor's URL. A loader, handler or server action
   cannot rewrite, and a loop answers 508. Redirect when the new URL should
   show (`/middleware`, "Rewrite").
9. **Keep prefetches shared.** One prefetch of a page serves every page
   that links to it. A `revalidate()` that reads the page being left and
   keeps its segment shares those prefetches only between the pages with
   equal values of what it read (`currentParams.locale`: the pages of one
   locale); one that reads `currentUrl` makes them page-only. Read params
   by name, keep page-specific blocks in their route, and write such a rule
   for chrome that shows a param's data
   ([Prefetches are shared](#prefetches-are-shared)).
10. **A layout keeps its `<Outlet />` in one place.** Branch inside one shape
    (`<>{promo ? <Banner /> : null}<Outlet /></>`), never between a bare
    `return <Outlet />` and a wrapped one: the outlet moves, and every page
    below remounts when the branch flips, its state reset and its mount
    effects run again. When an early return is unavoidable and the other
    branch is only a fragment, give the outlet the same `key` in both
    (`/layout`, "Moving the Outlet remounts its children").

## A small app: one module

The minimal recommended shape, and the starting point of every recipe:

```
src/
  router.tsx                   createRouter(), the Document, router.use()
  router.named-routes.gen.ts   generated, committed
  urls.tsx                     the whole route tree
  document.tsx                 "use client" Document (optional)
  pages/  loaders/  actions/
```

```tsx
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "./document";
import { urlpatterns } from "./urls";

export const router = createRouter({
  document: Document,
  urls: urlpatterns,
});
```

```tsx
// src/urls.tsx
import { urls } from "@rangojs/router";
import { RootLayout } from "./pages/root-layout"; // renders <Outlet />
import { HomePage, ReportsPage, ReportPage } from "./pages";
import { ReportLoader } from "./loaders/report";

export const urlpatterns = urls(({ path, layout, loader }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/reports", ReportsPage, { name: "reports" }),
    path("/reports/:id", ReportPage, { name: "report" }, () => [
      loader(ReportLoader),
    ]),
  ]),
]);
```

On the Node preset that is the whole app: `rango()` finds the router and
generates the entries (`/router-setup`). Keep it in one module until a
section has its own layout, its own guard, or more than a handful of routes,
then follow [Growing an app](#growing-an-app).

## Sync or async include()

Default to the sync form, `include("/x", xPatterns)`. Both forms match the
same URLs, build the same names and types, and expand the module's routes
lazily on the first request under the prefix
(`src/urls/include-helper.ts`). They differ in when the module itself is
loaded:

|                                  | `include("/x", xPatterns)` | `include("/x", () => import("./x"))`                                                                                                      |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Module load                      | at startup, with the entry | its own chunk, imported on the first request under the prefix, then cached                                                                |
| First request under the prefix   | no extra cost              | pays the chunk import: about 75 ms for a 240-route group, 188 ms for 9,000 routes, measured cold on Workers (`/composability`)            |
| Nested async includes            | n/a                        | import one after another: a 3-level chain measured 464 ms on its first hit                                                                |
| Route types, `href()`, prerender | complete                   | complete: build discovery and `rango generate` await the provider                                                                         |
| `rango generate` (static parser) | resolves it                | resolves `() => import("./x")` when `./x` has `export default urls(...)`; a `.then((m) => m.x)` provider needs `rango generate --runtime` |

Switch a group to async when it pays: the group has hundreds of routes, or
pulls in heavy server-only modules the rest of the app does not share, and
your platform starts cold often (Workers isolates, serverless functions).
Admin areas and large API surfaces are the usual candidates. A
`clientUrls()` group gains no startup time from it (`/client-urls`), so keep
group includes sync. Measure before and after: the sizing rules and numbers
are in `/composability` → "Code-splitting a route group with async include()".

## Naming includes

| Include                                        | Names in the app-wide map               | Use for                                                         |
| ---------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `include("/shop", shopUrls, { name: "shop" })` | `shop.index`, `shop.product`, …         | every section of an app                                         |
| `include("/", machineUrls, { name: "" })`      | the child names as they are (`sitemap`) | a module whose names are unique app-wide                        |
| `include("/x", widgetUrls)`                    | none: a hidden scope (`$prefix_0`)      | a reusable module linked only from inside, with `.name` reverse |

Name every section include. A name is what `ctx.reverse("settings.profile")`,
`href()`, `Handler<"settings.profile">` and the redirects in your middleware
type-check against, and an unnamed include keeps its routes out of
`router.named-routes.gen.ts` altogether.

In 0.24.x, give a name to every include that sits inside an included module.
With the route trie live (every request in `vite dev` and in production), an
unnamed include inside another unnamed include answers 404 for all of its
routes, with no warning from the build (#1104), and an unnamed include inside
a `{ name: "" }` include can render another module's handler when two modules
name a route alike. One unnamed level in the root module is fine.

## Where shared chrome lives

| Chrome                                                         | Put it in                                                                           | Why                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Spans several sections (top nav, user menu, footer)            | a server `layout()` in `urls()`, above their includes                               | Rendered once on the document load and kept on every navigation below it; navigations do not re-render it, actions skip it (`/layout`)     |
| Data in that chrome (the user, a workspace list, a cart count) | a `loader()` on that layout, read with `useLoader()`                                | Loaders are the live layer; a loader above the route re-runs after actions by default and not on navigations (`/loader`, segment defaults) |
| One area's chrome (tabs, a sub-nav, a pending indicator)       | the area's own `layout()`: in `urls()`, or the group's `layout()` in `clientUrls()` | In a group, `useOutlet().pending` drives the chrome at the click, and the layout keeps its instance across its routes (`/client-urls`)     |
| The document (`<html>`, stylesheets, theme script)             | the `document` option                                                               | One per router; a cross-app navigation loads the other app's (`/host-router`)                                                              |

For where boundaries and `revalidate()` rules go inside that chrome so
navigations stay smooth, see the `ux-architecture` skill.

## Prefetches are shared

In production every visible `<Link>` prefetches its page, and one prefetch
of a page serves every page that links to it: a product prefetched on the
home page is not fetched again on the search page or on page 2 of a list
(`/links` → "Shared prefetches and `prefetchKey`"). A structure keeps that
sharing as long as no segment's answer depends on the page being left.

The default rules keep it: a standalone layout is held from every page that
shows it, and a route re-renders when its params or search change. A
`revalidate()` that reads the page being left and keeps its segment narrows
it to what the rule read. A rule that reads `currentParams` or
`fromRouteName` shares the answer between the pages with equal values of
those reads (the params a rule reads by name, every param when it spreads
`currentParams`, the route name for `fromRouteName`; the page's set of params
always counts). A rule that reads `currentUrl` makes it page-only: the server
stores the answer for the exact page that sent it, query string and hash
included, and each page prefetches those links again. The answer stays
correct; what is lost is the sharing.

| What you are placing                                                                                                                               | Put it in                                                                    | Prefetches                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A block that belongs to one page (a category's hero, a product's breadcrumb)                                                                       | that page's route: its handler, or a layout inside its `path()` (below)      | Shared. It re-renders with its route on a param or search change. In a layout other pages share it would need a rule that reads the page being left |
| Links that follow a mount param (`:locale`, `:accountId`, `:projectId`)                                                                            | a client component with `useReverse(routes)` (rule 7)                        | Shared. The links follow `useParams()`, and the layout stays held with no rule                                                                      |
| Chrome that shows a param's data (the locale's messages, a project's name)                                                                         | the layout, with a `revalidate()` comparing `currentParams` and `nextParams` | Shared between the pages with the same value of that param where the rule keeps the layout (the pages of one locale or one project)                 |
| A page whose answer depends on the page that sent it through something the server cannot see (`context` in a `revalidate()`, the `Referer` header) | `prefetchKey=":source"` on the links to it                                   | Page-only, for those links                                                                                                                          |

The third row is the one to weigh: write that rule for chrome that must
follow the param, read the param by name, and keep everything else that
varies by page out of the layout.

Chrome that one kind of page has (a category's hero and breadcrumbs, a
product's gallery frame) can be a layout of its own route instead of a
template shared with other pages. A layout declared inside a `path()` belongs
to that route (`/layout`, "Orphan Layout"):

```tsx
urls(({ path, layout }) => [
  path("/c/:category", CategoryPage, { name: "category" }, () => [
    layout(CategoryLayout), // the hero: re-renders with the category
  ]),
  path("/p/:slug", ProductPage, { name: "product" }, () => [
    layout(ProductLayout),
  ]),
]);
```

- **No rule, shared prefetches.** It re-renders on its route's param or
  search change by default, so nothing reads the page being left.
- **It cannot leak.** The category's layout is not in the product page's
  tree, so no navigation can keep it above a product page or the cart.
- **What it costs.** Its handler runs on every param or search change of its
  route, `?page=2` included; cache an expensive read with `"use cache"`. Without
  a `transition()` in its chain (the route, this layout or a layout above) it
  remounts on a param change, like the route. A navigation to another route
  mounts that route's layout: nothing is held between them.
- **In a `clientUrls()` group** a `path()` takes no `layout()`, only
  `loader()`, `loading()` and `transition()` (`/client-urls`). A group
  layout has no `revalidate()` of its own: it is a client component, so the
  params it reads with `useParams()` are always the current page's. Its
  loaders are held on navigation like a server layout's, though, so hero
  data from a layout loader needs a rule that reads the page being left.
  Put the block in the route component and its data in a loader on the
  `path()`: that loader re-runs when the params or search change, with no
  rule.

## Growing an app

1. **Start with one `urls()` module** ([A small app](#a-small-app-one-module)).
2. **Extract a section into its own module** when it gets its own layout, its
   own guard or a dozen routes: move its `path()`s into `urls/<section>.tsx`
   with paths relative to the section, and mount it with
   `include("/<section>", sectionUrls, { name: "<section>" })`. Names change
   from `report` to `reports.detail`: regenerate, and the type checker lists
   every `ctx.reverse()` and `href()` to update.
3. **Lift shared chrome and guards** out of the sections: a server `layout()`
   around the includes that share a shell, a `middleware(guard, () => [...])`
   around the includes that share a gate.
4. **Move a section into a `clientUrls()` group** when most of its
   navigations are tab, param and filter switches inside one layout, and its
   handlers' data can become loaders read with `useLoader()` (a group has no
   handlers). Middleware, `errorBoundary()`, `notFoundBoundary()`, `cache()`
   and `parallel()` stay in the server tree around the include; the group
   rejects them. Its `revalidate()` rules move into the group with its
   loaders and keep running on the server. See `/client-urls`.
5. **Split code** with an async `include()` only for a group that measures
   large ([Sync or async](#sync-or-async-include)).
6. **Split into separate apps** under `createHostRouter()` when parts of the
   product have different documents, deploy cadences or hostnames
   ([`./multi-app.md`](./multi-app.md)). Navigations between them are
   document loads by design.

## Related

- `/router-setup`: `createRouter()` options, the Document, presets.
- `/composability`: `include()`, factories, async-include sizing.
- `/client-urls`: route groups of client components.
- `/middleware`: execution model, redirects, `throw rewrite()`.
- `/host-router`: hostname patterns, the host-override cookie, shared stores.
- `/ppr`, `/prerender`, `/cache-guide`: which cache layer a page needs.
- `/links`, `/typesafety`: names, `ctx.reverse()`, `href()`, generated files.
- `ux-architecture`: navigation UX inside these shapes.
