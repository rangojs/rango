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

- `path()`, `layout()`, `loader()`, and `loading()` inside `clientUrls()`;
- named client component values for paths and layouts;
- mounting through `include()` in the canonical `urls()` tree, with URL and
  route-name prefixes, wrapping RSC layouts, and prefix-scoped middleware
  deriving from the server tree;
- `PathOptions` projection for `name`, `search`, and `trailingSlash` only;
- server `createLoader()` definitions, including non-fetchable loaders;
- hard-load server matching, SSR, hydration, and canonical partial Flight soft
  navigation.

INSIDE `clientUrls()` the DSL does not support `middleware()`, `revalidate()`,
`include()`, `parallel()`, `intercept()`, `cache()`, `transition()`, error or
not-found boundaries, or PPR — those belong to the surrounding server tree the
include mounts into. Every helper rejection and the option-level rejections
(`ppr`, `intercept`, `parallel`, `revalidate`, and any other non-projected
`PathOptions` key) are pinned by tests.

Composition limits around a client include, locked explicitly:

- `parallel()` slots are handler-valued, so a client include is structurally
  unrepresentable inside one; parallel routes attach to server routes only.
- `revalidate()` has no surface to attach to projected client routes (their
  use-lists are generated: loader stubs and `loading()` only). Canonical
  revalidation of a committed page follows ordinary server semantics.
- Do NOT target a `clientUrls()` route pattern with `intercept()`: the
  browser-local optimistic presentation and the intercept presentation are not
  coordinated, and the combined behavior is undefined.
- Async `include(() => import())` modules must NOT mount clientUrls groups.
  Projection discovery itself is import-timing independent (filesystem scan)
  and the manifest composes correctly, but the RUNTIME lazy expansion of a
  nested substituted include does not yet reproduce discovery's auto-name
  identity, so requests 404. Mount clientUrls includes in statically imported
  urls modules; lifting this needs nested-include name-identity work.

With composition in place, the next API exploration is suspending
`useLoader()` inside client route components.

## Security boundary

Optimistic loading UI can appear before global authentication or authorization
middleware completes. Do not put protected data or sensitive route-state details
in that loading branch. If revealing the destination shell itself is sensitive,
do not configure optimistic loading for that route.
