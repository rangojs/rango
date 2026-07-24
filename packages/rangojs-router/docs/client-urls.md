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
- it covers a local match to a different `clientUrls()` route record while its
  canonical navigation is unresolved;
- it clears when that navigation commits, fails, redirects, is cancelled, or is
  superseded;
- it does not report prefetching, generic Suspense, ordinary server-route work,
  unrelated actions, or a parameter/search change that stays on the same client
  route record.

Use `useNavigation()`, `useLinkStatus()`, loader state, or your own Suspense
boundary for those other scopes.

## Supported surface

The initial slice supports:

- `path()`, `layout()`, `loader()`, `loading()`, a restricted `intercept()`,
  and a data-only `transition()` inside `clientUrls()`;
- named client component values for paths, layouts, and intercepts;
- mounting through `include()` in the canonical `urls()` tree, with URL and
  route-name prefixes, wrapping RSC layouts, and prefix-scoped middleware
  deriving from the server tree;
- `PathOptions` projection for `name`, `search`, and `trailingSlash` only;
- server `createLoader()` definitions, including non-fetchable loaders;
- hard-load server matching, SSR, hydration, and canonical partial Flight soft
  navigation.

`transition(config)` is valid inside a `path()` use callback only and projects
the data subset of `TransitionConfig`: ViewTransition classes
(`enter`/`exit`/`update`/`share`/`default`), `name`, and the
`viewTransition: "auto" | false` boundary opt-out. The `when` gate is a
server-executed predicate and is rejected — declare it with a server-tree
`transition()` wrapping the include. Materialization re-emits the config in
the standard child position, so the canonical commit gets the transition
hold (a same-route param nav keeps previous content instead of re-streaming
the `loading()` fallback — pinned dev+prod in `e2e/client-urls.test.ts`) and,
on experimental React, the router's ViewTransition boundary with those
classes. `startTransition` itself needs no opt-in here: the local
presentation already wraps its swaps, and the canonical commit is
transition-driven once the config is present.

INSIDE `clientUrls()` the DSL does not support `middleware()`, `revalidate()`,
`include()`, `parallel()`, `cache()`, error or not-found boundaries, or PPR —
those belong to the surrounding server tree the include mounts into. Every
helper rejection and the option-level rejections (`ppr`, `intercept`,
`parallel`, `revalidate`, and any other non-projected `PathOptions` key) are
pinned by tests.

Composition limits around a client include, locked explicitly:

- `parallel()` slots are handler-valued, so a client include is structurally
  unrepresentable inside one; parallel routes attach to server routes only.
- `revalidate()` has no surface to attach to projected client routes (their
  use-lists are generated: loader stubs and `loading()` only). Canonical
  revalidation of a committed page follows ordinary server semantics.
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

With composition in place, the next API exploration is suspending
`useLoader()` inside client route components.

## Security boundary

Optimistic loading UI can appear before global authentication or authorization
middleware completes. Do not put protected data or sensitive route-state details
in that loading branch. If revealing the destination shell itself is sensitive,
do not configure optimistic loading for that route.
