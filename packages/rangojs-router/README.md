# Rango

A code-first, type-safe React Server Components router. Django-inspired:
routes are expressed in one visible tree, URLs are built from names, and
everything past the core is opt-in.

> **Pre-1.0:** Rango follows semver 0.x — breaking changes land in minor
> releases and are noted in the changelog. npm `latest` is the current 0.x
> release; the `experimental` tag tracks `main` between tagged releases.

This page is a tour: it builds one small shop and meets the entire core API
along the way — about six primitives. Everything else is opt-in and linked at
the end. For the design rationale behind these APIs, read
[Why Rango](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/why-rango.md); this page shows how it feels, that page
argues why it's right.

## Start a new app

The recommended path is to scaffold a complete app with
[`create-rango`](https://github.com/rangojs/templates):

```bash
pnpm create rango my-app
```

Select a deployment target with `--template basic`, `--template cloudflare`, or
`--template vercel`. The templates include streaming RSC, typed routes, Server
Actions, Tailwind CSS, and production deployment configuration; the scaffolder
installs the latest `@rangojs/router` release. For a plain
JavaScript Node app, add `--template basic --js`. With npm, run
`npm create rango@latest my-app`. The scaffolder currently requires Node.js 24
or newer.

## Install manually

If you are adding Rango to an existing Vite RSC project:

```bash
npm install @rangojs/router@latest react @vitejs/plugin-rsc
```

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [react(), rango({ preset: "cloudflare" })],
});
```

The `cloudflare` preset targets Cloudflare Workers (add
`@cloudflare/vite-plugin`); the `vercel` preset emits a ready-to-deploy
`.vercel/output` (Build Output API) from a plain `vite build` — see the
[`/vercel` skill](./skills/vercel/SKILL.md); omit `preset` for the default
Node setup.

## Using the skills with your coding agent

This package ships agent skills in `node_modules/@rangojs/router/skills/` —
task-focused guides written for LLM coding agents. Start at
`skills/rango/SKILL.md` (the mental model + catalog); a machine-readable index
is at `skills/catalog.json`.

- **Claude Code**: point it at the skills (e.g. "read
  node_modules/@rangojs/router/skills/rango/SKILL.md before routing work"), or
  copy/symlink the directories you use into your project's `.claude/skills/`.
- **Other agents (Cursor, Codex CLI, Gemini CLI, ...)**: these harnesses
  auto-discover skills from `.agents/skills/` in your project (or
  `~/.agents/skills/`) — copy or symlink the skill directories you use from
  `node_modules/@rangojs/router/skills/<name>` into `.agents/skills/<name>`.
  The files are plain markdown; cross-references like `/loader` name sibling
  skill directories.

## 1. Pages

A router is a tree. `path()` places a page, `layout()` wraps children,
`{ name }` gives a route an identity:

```tsx
// src/router.tsx
import { createRouter, urls } from "@rangojs/router";
import { Document } from "./document";
import { ShopLayout } from "./layouts/shop";
import { HomePage } from "./routes/home";
import { ProductPage } from "./routes/product";

const urlpatterns = urls(({ path, layout }) => [
  layout(<ShopLayout />, () => [
    path("/", HomePage, { name: "home" }),
    path("/products/:slug", ProductPage, { name: "product" }),
  ]),
]);

export const router = createRouter({ document: Document }).routes(urlpatterns);
```

```tsx
// src/layouts/shop.tsx
import { Outlet } from "@rangojs/router/client";

export function ShopLayout() {
  return (
    <div>
      <nav>Shop</nav>
      <main>
        <Outlet /> {/* child routes render here */}
      </main>
    </div>
  );
}
```

```tsx
// src/document.tsx
"use client";

import type { ReactNode } from "react";
import { MetaTags, Scripts } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <MetaTags />
        <Scripts />
      </head>
      <body>
        <Scripts position="body" />
        {children}
      </body>
    </html>
  );
}
```

(The built-in `DefaultDocument` already wires all of this — a custom document
is optional.)

A handler is a function of `ctx`. Typing it by route name gives typed params
— the Vite plugin generates the route map automatically, nothing to register:

```tsx
// src/routes/product.tsx
import type { Handler } from "@rangojs/router";

export const ProductPage: Handler<"product"> = (ctx) => {
  return <h1>{ctx.params.slug}</h1>; // slug: string, from the pattern
};
```

And because routes have names, URLs are built, never hand-written:

```tsx
const url = ctx.reverse("product", { slug: "espresso-cup" });
// "/products/espresso-cup" — name and params compile-time checked
```

Rename `/products/:slug` to `/shop/:slug` in the one place it's defined and
every link, redirect, and prefetch follows. In client components, `href()`
validates static paths against the registered patterns:
`<Link to={href("/")}>Home</Link>`.

The tree is also lazy-first, which is the shape serverless cold starts want.
`include()` mounts a whole route module under a prefix — and with the async
form, `include("/shop", () => import("./shop"))`, the group is code-split:
its module doesn't load or run until a request matches it, a group nobody
visits never evaluates at all, and warm requests run zero route handlers.
Boot cost stays flat as the app grows — one module body at startup, not one
per group — while matching stays an `O(path length)` prefix trie, identical
in dev and production. None of this is assumed: the trie is benchmarked
in-repo against multi-thousand-route manifests, and the lazy guarantees are
pinned by run-count tests (see
[matching & lazy discovery](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/internal/matching-and-lazy-discovery.md)).
Grow the tree without watching the boot time.

That's a working site. Everything below adds to this app.

## 2. Data

The product page needs data. A handler is an async server component — fetch
where you render:

```tsx
// src/routes/product.tsx
export const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await db.products.find(ctx.params.slug);
  ctx.use(Meta)({ title: product.name }); // metadata where the data is
  return <ProductView product={product} />;
};
```

That's the default data path. React Router and Remix split data into a
loader beside the component because components couldn't fetch; RSC collapses
the split, and Rango doesn't reintroduce it. (That `ctx.use(Meta)` line is
also the whole metadata story: push tags where the data already is, layouts
set title templates, deeper segments override — no separate metadata export,
no second fetch.)

Loaders enter when data needs a life of its own. First case: a **client
component** needs server data — the stock badge is interactive, but the
stock lives in the database:

```tsx
// src/loaders/stock.ts
import { createLoader } from "@rangojs/router";

export const StockLoader = createLoader(async (ctx) => {
  "use server";
  return db.stockFor(ctx.params.slug);
});
```

```tsx
path("/products/:slug", ProductPage, { name: "product" }, () => [
  loader(StockLoader),
  loading(<ProductSkeleton />),
]),
```

```tsx
// src/components/stock-badge.tsx
"use client";
import { useLoader } from "@rangojs/router/client";
import { StockLoader } from "../loaders/stock";

export function StockBadge() {
  const { data } = useLoader(StockLoader);
  return <span>{data.inStock ? "In stock" : "Sold out"}</span>;
}
```

Loaders run in parallel with the handler and stream; `loading()` opts the
segment into skeleton-then-stream. Without it, document requests arrive
**ready** — the HTML ships with data in place; the skeleton is a per-segment
choice, not the first impression.

The rule of thumb: fetch in the **handler** when the data belongs to the
rendered page — it will be frozen with the shell if you cache it (step 4).
Put data in a **loader** when it must outlive the shell: shared with client
components, fresh on every hit even when the segment is cached, refetchable
from the client, or revalidated on its own after actions.

## 3. Mutations

Users add to cart. A server action is a plain `"use server"` function; the
form posts to it with standard React 19 hooks — and it works without
JavaScript:

```tsx
// src/actions/cart.ts
"use server";

export async function addToCart(productId: string) {
  await db.cart.insert({ productId });
}
```

```tsx
// src/components/add-to-cart.tsx
"use client";
import { useActionState } from "react";
import { addToCart } from "../actions/cart";

export function AddToCart({ productId }: { productId: string }) {
  const [, action, pending] = useActionState(() => addToCart(productId), null);
  return (
    <form action={action}>
      <button disabled={pending}>{pending ? "Adding…" : "Add to cart"}</button>
    </form>
  );
}
```

After an action, route segments and loaders re-render by default so the UI
reflects the new state. `revalidate()` narrows that to the segments that
actually own the data — matched by action **reference**, so renames are
compile errors, not stale predicates:

```tsx
import * as CartActions from "./actions/cart";

path("/cart", CartPage, { name: "cart" }, () => [
  loader(CartLoader, () => [
    revalidate((ctx) => ctx.isAction(CartActions) || undefined),
  ]),
]),
```

Notice what you didn't write: no API endpoint, no fetch wrapper, and no
client-cache invalidation call. Actions invalidate the client-side caches
(history entries, prefetches, HTTP cache key) automatically — a no-op action
can opt out per invocation with `keepClientCache()`.

## 4. Speed

Production traffic. Wrap a segment in `cache()` and the rendered shell —
including everything the handler fetched — is stored, while every loader on
it keeps running fresh on each hit. This is where the handler-vs-loader
choice from step 2 pays off: handler data freezes with the shell, the
`StockLoader` stays live. Cached shell, live data, one line:

```tsx
const urlpatterns = urls(({ path, layout, loader, loading, cache }) => [
  layout(<ShopLayout />, () => [
    path("/", HomePage, { name: "home" }),
    cache({ ttl: 600, swr: 3600, tags: ["products"] }, () => [
      path("/products/:slug", ProductPage, { name: "product" }, () => [
        loader(StockLoader), // never cached: re-runs on every hit
        loading(<ProductSkeleton />),
      ]),
    ]),
  ]),
]);
```

Wire a store once on the router (`MemorySegmentCacheStore` for dev,
`CFCacheStore` for Cloudflare — see the [`/caching` skill](./skills/caching/SKILL.md)),
and bust by tag from the mutation that changes the data:

```tsx
// src/actions/products.ts
"use server";
import { updateTag } from "@rangojs/router";

export async function renameProduct(id: string, name: string) {
  await db.products.rename(id, name);
  await updateTag("products"); // awaitable, read-your-own-writes
}
```

Navigation speed is a `Link` prop away:

```tsx
<Link to={url} prefetch="viewport">
  {product.name}
</Link>
```

A fully-prefetched navigation commits a **finished page** — no skeleton, no
loading flash — and staying correct is the router's job: every action
invalidates the prefetch caches by default, so a prefetched page can't show
pre-mutation data.

To move the shell's cost to build time entirely, `Prerender()` bakes it while
loaders stay live at runtime — same mental model, earlier cache write. See
the [`/prerender` skill](./skills/prerender/SKILL.md).

## 5. An API, when you need one

Response routes live in the same tree — `path.json()`, `path.text()`,
`path.xml()`, `path.image()`, `path.stream()`:

```tsx
path("/products/:slug", ProductPage, { name: "product" }),
path.json("/products/:slug", (ctx) => db.products.find(ctx.params.slug), {
  name: "productJson",
}),
```

Same URL: browsers get the page, API clients get JSON, negotiated by
`Accept` header in the route trie. Handlers return bare values; errors
serialize as RFC 9457 `application/problem+json`. The payload type is
inferred from the handler — no codegen:

```ts
type Product = RouteResponse<typeof urlpatterns, "productJson">;
```

See the [`/api-client` skill](./skills/api-client/SKILL.md) for a small typed
client over these endpoints.

## Everything else, when you need it

That was the core: `path`/`layout`/`include`, names, loaders, actions +
`revalidate`, `cache`, response routes. The rest is opt-in — reach for it
when the requirement appears:

| I need to…                                      | Skill                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| guard or shape requests (auth, headers)         | [`/middleware`](./skills/middleware/SKILL.md)                                                |
| multi-column layouts, independent slots         | [`/parallel`](./skills/parallel/SKILL.md)                                                    |
| open a route as a modal on soft navigation      | [`/intercept`](./skills/intercept/SKILL.md)                                                  |
| compose route modules / sub-apps                | [`/route`](./skills/route/SKILL.md), [`/composability`](./skills/composability/SKILL.md)     |
| cache a single function or component            | [`/use-cache`](./skills/use-cache/SKILL.md), [`/cache-guide`](./skills/cache-guide/SKILL.md) |
| feed live loaders from a cached shell           | [`/shell-manifest`](./skills/shell-manifest/SKILL.md)                                        |
| edge caching with Cache-Control                 | [`/document-cache`](./skills/document-cache/SKILL.md)                                        |
| light/dark mode without FOUC                    | [`/theme`](./skills/theme/SKILL.md)                                                          |
| analytics / third-party scripts with CSP nonce  | [`/scripts`](./skills/scripts/SKILL.md)                                                      |
| locale routing                                  | [`/i18n`](./skills/i18n/SKILL.md)                                                            |
| SSE and WebSockets                              | [`/streams-and-websockets`](./skills/streams-and-websockets/SKILL.md)                        |
| multi-app routing by domain                     | [`/host-router`](./skills/host-router/SKILL.md)                                              |
| animate navigations                             | [`/view-transitions`](./skills/view-transitions/SKILL.md)                                    |
| test loaders, middleware, handlers, Flight      | [`/testing`](./skills/testing/SKILL.md)                                                      |
| see where request time goes                     | [`/observability`](./skills/observability/SKILL.md)                                          |
| deploy to Vercel (cache store, tracing, output) | [`/vercel`](./skills/vercel/SKILL.md)                                                        |
| choose in-function vs CDN caching               | [`/deployment-caching`](./skills/deployment-caching/SKILL.md)                                |
| compare Rango with Next.js / TanStack / Waku    | [`/comparison`](./skills/comparison/SKILL.md)                                                |

The [`/rango` skill](./skills/rango/SKILL.md) is the full catalog and the
mental model that ties it together.

## Reference

### Imports and subpaths

| Export                    | Description                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@rangojs/router`         | Server/RSC core and shared types: `createRouter`, `urls`, `createLoader`, `Handler`, `Prerender`, `Meta`                       |
| `@rangojs/router/client`  | Client: `Link`, `Outlet`, `href`, `useNavigation`, `useLoader`, `MetaTags`                                                     |
| `@rangojs/router/cache`   | Cache: `CFCacheStore`, `VercelCacheStore`, `MemorySegmentCacheStore`, `createDocumentCacheMiddleware`                          |
| `@rangojs/router/theme`   | Theme: `useTheme`, `ThemeProvider`, `ThemeScript`                                                                              |
| `@rangojs/router/host`    | Host routing: `createHostRouter`, `defineHosts`, `isNoRouteMatchError`                                                         |
| `@rangojs/router/vercel`  | Vercel: `createVercelTracing` (phase spans via `@vercel/otel`'s global tracer)                                                 |
| `@rangojs/router/vite`    | Vite plugin: `rango()`                                                                                                         |
| `@rangojs/router/testing` | Consumer testing primitives: `runLoader`, `runMiddleware`, `dispatch` (plus `/testing/dom`, `/testing/flight`, `/testing/e2e`) |
| `@rangojs/router/rsc`     | Advanced server pipeline APIs: `createRSCHandler`, request-context access                                                      |
| `@rangojs/router/ssr`     | Advanced SSR bridge APIs: `createSSRHandler`                                                                                   |

Use only subpaths that are explicitly exported; avoid deep imports.

The root entry is conditionally resolved: server-only APIs (`createRouter`,
`urls`, `redirect`, `Prerender`, `cookies`) run under the `react-server`
condition and throw guidance errors elsewhere. If you hit a root-entrypoint
stub error: hooks and components (`Link`, `Outlet`, `useLoader`, `MetaTags`)
live in `@rangojs/router/client`; cache APIs in `@rangojs/router/cache`;
host APIs in `@rangojs/router/host`.

### Type safety

The Vite plugin generates `router.named-routes.gen.ts` automatically (on dev
startup, HMR, and builds), registering route names, params, and search
schemas globally via `Rango.GeneratedRouteMap`. That powers `Handler<"name">`,
`ctx.reverse()`, and `RouteParams<"name">` with no manual registration.

For response-aware and path-based utilities (`href()`, `Rango.Path`,
`RouteResponse`), augment `Rango.RegisteredRoutes` once:

```ts
// router.tsx
const router = createRouter<AppBindings>({}).routes(urlpatterns);

// The alias is required: an interface heritage clause cannot take a `typeof`
// type query directly (TS1109), so extend through a named alias.
type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface Env extends AppEnv {}
    interface RegisteredRoutes extends AppRoutes {}
  }
}
```

See the [`/typesafety` skill](./skills/typesafety/SKILL.md) for the full
surface breakdown.

### CLI

Route types are generated by the Vite plugin; the CLI is the manual fallback
for CI or pre-first-run IDE support:

```bash
npx rango generate src/router.tsx   # global named-route map
npx rango generate src/             # recursive scan
```

### Examples

- [`e2e/mini`](https://github.com/rangojs/rango/tree/main/packages/rangojs-router/e2e/mini) — single-file demo app
- [`cloudflare-basic`](https://github.com/rangojs/rango/tree/main/tests/cloudflare-basic) — Cloudflare Workers with caching, loaders, theme, and pre-rendering
- [`cloudflare-multi-router`](https://github.com/rangojs/rango/tree/main/examples/cloudflare-multi-router) — multi-app host routing
- [`vercel-basic`](https://github.com/rangojs/rango/tree/main/examples/vercel-basic) — Vercel deployment with `preset: "vercel"`, `VercelCacheStore`, and OTel tracing
- [`vercel-multi-router`](https://github.com/rangojs/rango/tree/main/examples/vercel-multi-router) — multi-app host routing on Vercel (single function, routed by Host header)

### Going deeper

- [Why Rango](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/why-rango.md) — the design rationale, claim by claim
- [Framework comparison](./skills/comparison/references/framework-comparison.md) — Rango vs Next.js App Router, TanStack Start, and Waku, capability by capability
- [Docs index](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/README.md) — architecture, caching, prerender, testing
- [Execution model](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/internal/execution-model.md) — the runtime contract

## License

[MIT](./LICENSE)
