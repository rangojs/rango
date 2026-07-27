---
name: client-urls
description: Define client-component route groups with clientUrls() in a "use client" module — no handlers, useLoader at read sites, client-run revalidate predicates, loader-thrown notFound/redirect, loader handle writes, and the stream:"navigation" SSR-completeness opt-in. Use when a route group's pages are client components, when building high-navigation-speed UIs (dashboards, admin panels, settings) where transitions must feel instant, when moving data reads from handler ctx.use() to useLoader at consumption sites, or when asking how routes defined in a "use client" file work.
argument-hint: "[setup]"
---

# Client route groups with clientUrls()

`clientUrls()` defines a route group inside a `"use client"` module. The
components are client components, and there are **no handlers at all** — every
data read is `useLoader` at the consumption site, waiting is scoped by the
inline `<Suspense>` above each read, and per-loader `revalidate()` predicates
run in the browser. The server shop pattern — `await ctx.use(ProductLoader)` in
a handler — is pipeline-blocking by contract: no pending UI can ever cover that
latency. `clientUrls()` makes that shape unrepresentable.

This is the fastest-transition shape Rango has, and the natural fit for
dashboard / admin / settings-style apps — high navigation frequency inside one
layout, mostly tab/param/filter switches. Three things compound: the
definition also matches in the browser, so a soft navigation presents
optimistic pending UI immediately (`useOutlet().pending`) with no server
round-trip to start; browser-run `revalidate()` predicates HOLD data across
navigations that don't invalidate it (a tab switch re-runs nothing — only the
decision crosses the wire); and any read that does refresh streams behind its
own inline boundary instead of gating the commit. Add per-Link prefetch
(`/links`) and a warmed click lands the complete page instantly.

## Not this skill if…

- You are defining server routes with handlers — that is `urls()`: see
  `/route`.
- You want loader mechanics (createLoader, caching a loader, fetchable
  loaders) — see `/loader`. This skill covers what is _different_ inside
  `clientUrls()`.
- You want `useOutlet`/`useLoader`/`useHandle` reference — see `/hooks`.

## The shape

A `clientUrls()` module never ships route-definition code to the server as
code. The Vite plugin discovers the module (it must be `"use client"`, contain
`clientUrls(`, and **default-export** the result), evaluates it, and serializes
a JSON **projection**: patterns, names, options, loader ids, which loaders are
flagged, loading/transition presence. The server tree materializes real routes
from that projection — loader stubs resolved by id from the server loader
registry, your client components referenced but never executed server-side as
route code. In the browser the same definition matches locally, so soft
navigations inside the group present optimistic pending UI
(`useOutlet().pending`) while the canonical partial Flight settles.

Consequences you will hit:

- **Components must be named function values.** `path("/x", HomePage)`, not
  `path("/x", <HomePage />)` and not an inline arrow — the projection stores a
  component reference, and an anonymous value throws
  (`clientUrls() path() expects a named client component value`).
- **Loaders must be `createLoader()` definitions** whose bodies are
  `"use server"` — they execute on the server, addressed by id; the client
  module only imports the definition object.
- **Everything in the definition must be JSON-projectable.** That is why the
  unsupported helpers below are rejected rather than silently dropped.

## Defining and mounting

```tsx
// src/urls/shop.client.tsx
"use client";

import { Suspense } from "react";
import { clientUrls, useLoader, Link } from "@rangojs/router/client";
import { ProductsLoader, ProductLoader } from "@/loaders/products.js";

function ShopLayout() {
  /* useOutlet().content + chrome */
}
function ShopIndex() {
  /* <Suspense><Grid/></Suspense> */
}
function ProductPage() {
  /* useLoader(ProductLoader) under Suspense */
}

export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(ShopLayout, () => [
    path("/", ShopIndex, { name: "index" }, () => [loader(ProductsLoader)]),
    path("/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, () => [
        revalidate(
          ({
            isAction,
            currentParams,
            nextParams,
            defaultShouldRevalidate,
          }) => {
            if (isAction) return false;
            return currentParams.slug !== nextParams.slug
              ? defaultShouldRevalidate
              : false;
          },
        ),
      ]),
    ]),
  ]),
]);
```

Mount it from the server tree like any module:

```tsx
// src/urls/index.tsx (server)
import shopUrls from "./shop.client.js";

include("/shop", shopUrls, { name: "shop" });
```

Route names compose through the include (`shop.index`, `shop.product`) and
flow into the generated route map, so `href`/`reverse` and `Handler<"...">`
typing work exactly as for server routes (`/typesafety`).

## Helpers: what exists inside clientUrls()

| Helper         | Notes                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| `path()`       | Options are `name`, `search`, `trailingSlash` only (no `ppr`, no response variants)   |
| `layout()`     | Must contain at least one `path()`                                                    |
| `loader()`     | `loader(Def, use?)` or `loader(Def, { stream: "navigation" }, use?)` — see below      |
| `loading()`    | Route/layout-level pending UI; inline `<Suspense>` at read sites is usually better    |
| `revalidate()` | Valid **inside a loader() use callback only**; runs in the browser                    |
| `transition()` | Data-only ViewTransition config — no `when` (that is a server-executed predicate)     |
| `intercept()`  | Dot-local named target in the SAME definition; use may contain `loader()`/`loading()` |

`include`, `parallel`, `cache`, `middleware`, `errorBoundary`,
`notFoundBoundary` **throw** — and that is a design position, not a gap.
Client route groups are a PERFORMANCE surface (instant presentation, held
data, streaming reads), not full-feature routing; the server tree around the
mount is the full-feature router. Put those helpers at or around the
`include()` mount in the server `urls()` tree: middleware wrapping the mount
runs for every route in the group; a `notFoundBoundary()` on an enclosing
server layout catches loader-thrown `notFound()` from the group. (Caching
still reaches the group's data the right way: `"use cache"` inside a loader
body — the loaders stay the live layer, the expensive function is what
caches.)

Boundaries are a deliberate exclusion, not a projection limitation: the
server-tree boundary around the mount gives group-scoped custom UI with the
uniform server-resolved envelope (PE/no-JS correct), and INSIDE the group
plain React error boundaries just work — every component is a client
component, and a streamed loader rejection throws to the boundary above its
`useLoader` read (siblings keep reading it from `error`). Per-read boundary +
inline Suspense is the clientUrls idiom; a route-level DSL boundary would be
the same regression `loading()` is relative to inline Suspense.

## Outer layouts and middleware across group navigations

With the common shape — `layout(<AdminRscLayout />, () => [middleware(requireAdmin), include("/admin", adminUrls)])` — middleware and layout handlers ride
DIFFERENT schedules:

- **Middleware runs on EVERY canonical request**, not just the first
  encounter. Every navigation inside the group — including a tab switch whose
  loaders all hold — still sends the canonical partial request (it commits
  URL/history and carries the revalidation decisions), and middleware wraps
  each one: `requireAdmin` re-authorizes every navigation, and its
  `ctx.set()` variables are fresh for the group's loaders on every pass. The
  instant feel comes from held data and optimistic presentation, not from
  skipping the server.
- **The outer layout handler does NOT re-run on within-group navigations** —
  partial rendering holds its segment (and the parent chain skips on actions
  by default). Layout-rendered data that must track the group belongs in
  middleware `ctx.set()`, not the layout body.
- The only thing that precedes middleware is the optimistic branch
  (destination `loading()` / `useOutlet().pending`) — presentation, never
  authorization.

All three pinned by dev + production e2e in the router repository (a
middleware-stamped header per request, a layout run-count stamp held across
navigations).

## Revalidation runs in the browser

A server-tree `revalidate()` predicate executes on the server. A `clientUrls()`
predicate is client-module code, so it executes **in the browser** with
client-computable args — `currentUrl`, `nextUrl`, `currentParams`,
`nextParams`, `defaultShouldRevalidate`, `stale`, `isAction`, `actionId` — and
only its _decision_ crosses the wire with the navigation request. Requests that
carry no decisions (no-JS, progressive enhancement, prefetch, document loads)
follow the locked server defaults.

Two scars worth copying:

- A blunt `() => false` keeps serving the OLD product on product→product
  navigations (same route, new param). Make predicates param-sensitive:
  return `defaultShouldRevalidate` when the identifying param changed.
- One action, per-loader outcomes: a cart badge loader revalidates on actions
  (`isAction ? defaultShouldRevalidate : false`) while product/related loaders
  hold — three freshness outcomes in a single commit, decided per loader.

## Loaders are full citizens: signals and handles

Everything a DSL loader can do in the server tree works here — the loader body
is server code either way.

**Authority signals.** A loader may `throw notFound()` or
`throw redirect(url)`:

```ts
export const ProductLoader = createLoader(async (ctx) => {
  "use server";
  const moved = LEGACY_SLUGS[ctx.params.slug];
  if (moved) throw redirect(`/shop/product/${moved}`);
  if (!(await exists(ctx.params.slug))) notFound(`No "${ctx.params.slug}"`);
  return getProduct(ctx.params.slug);
});
```

On a document load, `notFound()` streams the resolved not-found UI in the
envelope and _opportunistically_ sets a real 404 status — the status write only
wins if the rejection settles before the document Response is constructed (a
fast, pre-fetch existence check usually wins; see `stream: "navigation"` below
for the deterministic version). On navigations the 404 UI swaps in with the
URL preserved. A loader `redirect()` is always a client-side navigate — there
is no document-lane 302 from loaders; pre-stream redirect authority belongs to
middleware.

**Handle writes.** `ctx.use(Handle)` from the loader body is the WRITE, with
handler parity — `ctx.use(Meta)({ title })` pushes exactly like a handler
push. Reads moved to `ctx.get(handle)`, gated behind `await ctx.rendered()`.
Delivery follows the race model: pushes that settle before the handler barrier
ride the SSR handle snapshot; later ones stream and apply post-hydration
(document loads) or progressively (navigations). See `/loader` for the full
contract.

## `stream: "navigation"` — the SSR-completeness opt-in

By default every loader streams on every render, so nothing a slow loader
produces is _guaranteed_ to be in the SSR'd HTML — data SSRs as the Suspense
fallback, a late handle push applies post-hydration, a late `notFound()` loses
the status race. When the loader feeds something that must exist in the
document — `<head>` meta via a handle, or a real 404 status — flag it:

```ts
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader, { stream: "navigation" }, () => [revalidate(productData)]),
  loader(RelatedLoader),   // untouched: still streams behind its boundary
]),
```

The name says WHERE streaming still applies, not that it is disabled: document
renders await this loader before first flush (data settled — no fallback
paints; handle pushes beat the barrier snapshot; a thrown `notFound()` is a
deterministic real 404, no warm-up race); client navigations stream exactly as
before. Scoped per loader — the flagged loader awaits only itself, siblings
keep streaming.

Constraints:

- A flagged loader must not `await ctx.rendered()` (or read handles via
  `ctx.get(handle)`, which rendered() gates) — the document render awaits the
  loader _before_ the render barrier resolves, so that wait is a cycle by
  construction. It throws a deadlock error naming the fix.
- `intercept()` loaders reject the flag — intercepts render on client
  navigations only, so a document-render await can never apply.
- It does not change PPR capture behavior: capture renders mask loaders and
  skip the await.

Every document load pays the flagged loader's latency before first byte —
that is the point, but it is a real cost. Keep flagged loaders fast (existence
checks before expensive fetches) and flag the loaders that need it, not the
route.

Pinned end to end by dev + production e2e in the router repository.

## Intercepts

```tsx
export default clientUrls(({ path, intercept, loader, loading }) => [
  path("/items", ItemsIndex, { name: "index" }),
  path("/items/:id", ItemDetail, { name: "detail" }),
  intercept("@modal", ".detail", ItemModal, () => [
    loader(ItemLoader),
    loading(<ModalSkeleton />),
  ]),
]);
```

Compared to the server `intercept()` (`/intercept`): the target must be a
dot-local NAMED route in the same definition, there is no `when` selector and
no middleware, and the use callback accepts `loader()`/`loading()` only —
every field must be JSON-projectable. Scoping is module-local: only
navigations originating inside this `clientUrls()` group render the intercept;
a hard load of the target URL renders the full route.

## Pitfalls

- **Duplicate patterns or names throw** at definition time, per definition.
- **`layout()` with no `path()` inside throws** — a client layout exists only
  to wrap routes.
- **`loading()` vs inline Suspense:** same-route SEARCH navigations
  (filters, tabs) hold previous content by default — the canonical commit
  runs in a `startTransition` when no new segments mount, and the wrapping
  layout sees `useOutlet().pending === true` for the held window; a
  route-level `loading()` no longer re-flashes there. PARAM navigations
  still remount (fresh skeleton, fresh state) unless the route declares
  `transition()` — that opt-in drops the param from the segment key. Inline
  `<Suspense>` above each `useLoader` read is still the finer-grained tool
  when different reads on one route should wait independently.
- **Two parallel loaders with equal latency look "SSR'd" together.** Loaders
  kick off in parallel, so awaiting one (`stream: "navigation"`) gives
  same-or-faster siblings time to settle coincidentally. Do not read "it was
  in the HTML once" as a guarantee — only the flagged loader is guaranteed.
- **Hook semantics shift inside a group.** `usePathname` is ABSOLUTE (mount
  included) — never compare it to your own `path()` patterns; build local
  links with `useHref()` (`groupHref("/items/1")` composes the mount).
  `useRouter().push("/local")` is mount-blind — compose:
  `router.push(groupHref("/local"))`. `useSearchParams` carries REAL
  values during SSR (live request seeds the SSR store; ppr static parts
  are the search-agnostic exception).
  `useNavigation`/`useLinkStatus` report the canonical nav, but a reader
  inside optimistically-swapped content (destination WITH `loading()`)
  unmounts at click — put status readers in surviving chrome. Errors: wrap
  throwers in the client `ErrorBoundary`; `useFetchLoader` works unchanged
  (route-independent lane; `revalidate()` deliberately not consulted).
  Pinned in the router repo's client-urls hook-probe e2e.
- **Editing the module in dev:** projections refresh via HMR discovery; if a
  route-shape edit ever serves stale routes, restart dev — and if you are
  developing the router itself, rebuild the router dist before `pnpm dev`
  (the discovery machinery ships compiled).

## Reference app

The router repository (not shipped in this package) carries a canonical
consumer at `tests/vite-rsc-demo/src/urls/client-shop.client.tsx`: layout +
index + product routes, param-sensitive predicates, action-scoped cart
revalidation, loader-thrown `notFound()`/`redirect()`, loader-written
Meta/Breadcrumbs, viewport prefetch on cards, and the `stream: "navigation"`
fixtures — with e2e suites next to it pinning each contract in dev and
production. The sections above are self-contained; the app is corroboration,
not required reading.
