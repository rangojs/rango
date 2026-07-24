# Client URL Routes

`clientUrls()` lets the browser recognize selected client-component routes after
hydration. On a soft navigation, that local match can show the destination's
`loading()` UI immediately and set `useOutlet().pending` while the ordinary
partial Flight request is still running.

The browser match is presentation only. The server still matches the request,
runs global router middleware and route loaders, and returns the canonical
partial Flight response. Only that response commits the URL, history, and route
content. Hard requests use the same projected server routes, so SSR and hydration
work without a separate client-only entry path.

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
    path("/catalog", CatalogIndex, { name: "catalog" }),
    path(
      "/catalog/products/:productId",
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

Register the definition directly at the router root. It may follow ordinary
server URL patterns, but it cannot be mounted through `include()` or under a
client URL prefix.

```tsx
// src/router.tsx
import { createRouter } from "@rangojs/router";
import clientUrlPatterns from "./catalog.client-urls.js";
import { Document } from "./document.js";
import { globalMiddleware } from "./middleware.js";
import { serverUrls } from "./server-urls.js";

export const router = createRouter({ document: Document })
  .use(globalMiddleware)
  .routes(serverUrls)
  .routes(clientUrlPatterns);
```

A router accepts one distinct `clientUrls()` definition, and it must be the
FINAL `.routes()` registration — registering server URL patterns after it
throws. This keeps runtime registration order identical to build discovery,
which always orders the client mount last. Keep each client route pattern
absolute in that root definition.

Pass the client module's default export, not a `clientUrls()` object built in a
server module: a direct object cannot cross the server/client boundary and fails
at render. Development warns at the `.routes()` call site when it receives one.

## Navigation authority

After hydration, a navigation to a different matching client route can render
its `loading()` value before the network response arrives. A wrapping client URL
layout sees `useOutlet().pending === true` for that optimistic branch. Without a
destination `loading()`, the current branch remains visible with its outlet marked
pending.

The local result cannot authorize the request, run or skip middleware, execute a
loader, commit history, or override a redirect or error from the server. The
existing navigation bridge still sends the canonical partial Flight request;
global `createRouter().use(...)` middleware and projected loaders run on the
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
- direct root registration through `.routes(clientUrlsDefinition)`;
- `PathOptions` projection for `name`, `search`, and `trailingSlash` only;
- server `createLoader()` definitions, including non-fetchable loaders;
- hard-load server matching, SSR, hydration, and canonical partial Flight soft
  navigation;
- global router middleware through `createRouter().use(...)`.

The current `clientUrls()` DSL does not support `middleware()`, `revalidate()`,
`include()`, `parallel()`, `intercept()`, `cache()`, `transition()`, error or
not-found boundaries, or PPR. Route-local middleware remains unsupported; global
router middleware remains canonical. Other `PathOptions`, including `ppr`, are
rejected by server projection.

## Security boundary

Optimistic loading UI can appear before global authentication or authorization
middleware completes. Do not put protected data or sensitive route-state details
in that loading branch. If revealing the destination shell itself is sensitive,
do not configure optimistic loading for that route.
