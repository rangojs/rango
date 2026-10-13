# A shop

A storefront: category pages with filters, product pages, a cart badge on
every page, a cart page and a checkout. Most of each page is the same for
every visitor (the product, the category grid); a few regions are per
visitor or change by the minute (the cart, the price, the stock).

- **Category and product pages are server routes with `ppr`.** The handler
  renders the shared part from a tagged `"use cache"` read, and it bakes into
  the shell; the per-visitor parts are live loaders read under their own
  `<Suspense>`, the holes.
- **The cart is a loader on the store layout**, re-run after cart actions
  only.
- **Checkout is server-rendered with actions**: no shell, no cache, a guard
  that needs a cart.
- **Filters are search params** with a typed schema; each distinct query is
  its own shell.

## File tree

```
src/
  router.tsx                  cache store; tracking params out of the keys; loadCart
  router.named-routes.gen.ts  generated, committed
  urls.tsx                    root: store layout, catalog, cart, checkout
  urls/
    catalog.tsx               urls(): category and product pages (ppr)
    checkout.tsx              urls(): checkout steps (no ppr)
  pages/store.tsx             StoreLayout, CategoryPage, ProductPage
  pages/checkout.tsx          "use client": CartPage, CheckoutPage
  components/
    cart-badge.tsx            "use client": useLoader(CartLoader)
    buy-box.tsx               "use client": price, stock, reviews, add to cart
  loaders/shop.ts             CartLoader, PriceLoader, StockLoader, ReviewsLoader
  lib/data.ts                 getCategory, getProduct: "use cache" + cacheTag
  lib/catalog.ts  lib/carts.ts  lib/payments.ts   your data layer
  middleware/cart.ts          loadCart (global), requireCart
  actions/cart.ts             "use server": addToCart
  actions/checkout.ts         "use server": placeOrder
```

## router.tsx

```tsx
// src/router.tsx
import { createRouter, TRACKING_SEARCH_PARAMS } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { loadCart } from "./middleware/cart";
import { urlpatterns } from "./urls";

export const router = createRouter({
  cache: {
    store: new MemorySegmentCacheStore(), // CFCacheStore / VercelCacheStore when deployed
    // utm_* and click ids mint no new shells or cache entries.
    searchParams: { exclude: TRACKING_SEARCH_PARAMS },
  },
})
  .use(loadCart)
  .routes(urlpatterns);
```

```ts
// src/middleware/cart.ts
import { cookies, createVar, redirect } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";
import { carts } from "../lib/carts";

export const CartId = createVar<string>({ cache: false });

export const loadCart: Middleware = async (ctx, next) => {
  const id = cookies().get("cart")?.value;
  if (id) ctx.set(CartId, id);
  return next();
};

export const requireCart: Middleware = async (ctx, next) => {
  const id = ctx.get(CartId);
  if (!id || (await carts.get(id)).length === 0)
    return redirect(ctx.reverse("cart"));
  return next();
};
```

## urls.tsx

```tsx
// src/urls.tsx
import { urls } from "@rangojs/router";
import { catalogPatterns } from "./urls/catalog";
import { checkoutPatterns } from "./urls/checkout";
import { StoreLayout } from "./pages/store";
import { CartPage } from "./pages/checkout";
import { CartLoader } from "./loaders/shop";
import * as CartActions from "./actions/cart";
import { requireCart } from "./middleware/cart";

export const urlpatterns = urls(
  ({ path, layout, include, loader, revalidate, middleware }) => [
    layout(StoreLayout, () => [
      // The cart badge on every page. A layout loader re-runs after every
      // action by default: narrow it to cart actions. Navigations hold it.
      loader(CartLoader, () => [
        revalidate((ctx) =>
          ctx.isAction() ? ctx.isAction(CartActions) : undefined,
        ),
      ]),
      include("/", catalogPatterns, { name: "catalog" }),
      path("/cart", CartPage, { name: "cart" }),
      middleware(requireCart, () => [
        include("/checkout", checkoutPatterns, { name: "checkout" }),
      ]),
    ]),
  ],
);
```

## The catalog

```ts
// src/lib/data.ts
import { cacheTag } from "@rangojs/router";
import { catalog } from "./catalog";

// Shared by every visitor and tagged: a catalog edit drops the entry and
// every shell that baked it.
export async function getCategory(
  category: string,
  sort?: string,
  page?: number,
) {
  "use cache";
  cacheTag(`category:${category}`);
  return catalog.list(category, { sort, page });
}

export async function getProduct(slug: string) {
  "use cache";
  cacheTag(`product:${slug}`);
  return catalog.get(slug);
}
```

```tsx
// src/pages/store.tsx
import { Suspense } from "react";
import { notFound, type Handler } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { CartBadge } from "../components/cart-badge";
import { BuyBox } from "../components/buy-box";
import { getCategory, getProduct } from "../lib/data";

export function StoreLayout() {
  return (
    <>
      <header>
        {/* A badge-sized hole: the header itself bakes into every shell. */}
        <Suspense fallback={<span>Cart</span>}>
          <CartBadge />
        </Suspense>
      </header>
      <Outlet />
    </>
  );
}

// Typed from the generated map: ctx.params.category, ctx.search.sort.
export const CategoryPage: Handler<"catalog.category"> = async (ctx) => {
  const products = await getCategory(
    ctx.params.category,
    ctx.search.sort,
    ctx.search.page,
  );
  return (
    <ul>
      {products.map((p) => (
        <li key={p.slug}>
          <Link to={ctx.reverse("catalog.product", { slug: p.slug })}>
            {p.name}
          </Link>
        </li>
      ))}
    </ul>
  );
};

export const ProductPage: Handler<"catalog.product"> = async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  if (!product) notFound();
  return (
    <article>
      <h1>{product.name}</h1>
      <BuyBox slug={ctx.params.slug} />
    </article>
  );
};
```

```tsx
// src/urls/catalog.tsx
import { urls, type Revalidate } from "@rangojs/router";
import { CategoryPage, ProductPage } from "../pages/store";
import { PriceLoader, ReviewsLoader, StockLoader } from "../loaders/shop";

// A route and its loaders re-run after every action by default. The product
// itself, its price and its reviews do not change with the cart; stock may.
const notOnActions: Revalidate = (ctx) => (ctx.isAction() ? false : undefined);

export const catalogPatterns = urls(({ path, loader, revalidate }) => [
  path("/c/:category", CategoryPage, {
    name: "category",
    search: { sort: "string?", page: "number?" },
    ppr: true,
  }),
  path("/p/:slug", ProductPage, { name: "product", ppr: { ttl: 3600 } }, () => [
    revalidate(notOnActions), // the handler
    loader(PriceLoader, () => [revalidate(notOnActions)]),
    loader(StockLoader),
    // Below the fold and costly: kept out of link prefetches.
    loader(ReviewsLoader, { prefetch: false }, () => [
      revalidate(notOnActions),
    ]),
  ]),
]);
```

```tsx
// src/components/buy-box.tsx
"use client";

import { Suspense } from "react";
import { useLoader } from "@rangojs/router/client";
import { PriceLoader, ReviewsLoader, StockLoader } from "../loaders/shop";
import { addToCart } from "../actions/cart";

function Price() {
  const { data } = useLoader(PriceLoader);
  return <p>{(data.cents / 100).toFixed(2)}</p>;
}
function Stock() {
  const { data } = useLoader(StockLoader);
  return <p>{data.count} left</p>;
}
function Reviews() {
  const { data } = useLoader(ReviewsLoader);
  return (
    <ul>
      {data.map((r) => (
        <li key={r.id}>{r.text}</li>
      ))}
    </ul>
  );
}

// Each read under its own boundary: these are the shell's live holes.
export function BuyBox({ slug }: { slug: string }) {
  return (
    <>
      <Suspense fallback={<p>…</p>}>
        <Price />
        <Stock />
      </Suspense>
      <button onClick={() => addToCart(slug)}>Add to cart</button>
      <Suspense fallback={<p>Loading reviews…</p>}>
        <Reviews />
      </Suspense>
    </>
  );
}
```

What a product page request does:

| Part                      | Where it comes from                                    | On a shell HIT                                       |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Name, description, images | the handler, from `getProduct` (`"use cache"`, tagged) | from the shell; the handler does not run             |
| Price, stock              | live loaders under `<Suspense>`                        | run for this request, stream into the holes          |
| Reviews                   | a live loader, kept out of prefetches                  | run for this request; a prefetch defers it to a fill |
| Cart badge                | the layout's `CartLoader`                              | run for this request                                 |

- Filters link with the typed search:
  `ctx.reverse("catalog.category", { category }, { sort: "price" })`. Every
  distinct query is its own shell, captured on its first request; keep the
  filter set small or move the grid into a live loader when combinations
  explode.
- A catalog edit is a tag: `updateTag()` with `product:<slug>` drops the
  `"use cache"` entry and every shell that baked it; the next request
  recaptures. A webhook route has the request context `updateTag()` needs:

  ```ts
  path.json(
    "/hooks/catalog",
    async (ctx) => {
      // verify the sender's signature first
      const { slug } = (await ctx.request.json()) as { slug: string };
      await updateTag(`product:${slug}`);
      return { ok: true };
    },
    { name: "catalogHook" },
  );
  ```

- Every per-visitor read lives in a loader the client reads. A `cookies()`
  read in a handler or in a loader a handler awaits refuses the shell
  capture, and the page never serves a shell (`/ppr` → "The
  layout-with-loaders playbook").

### Variant: product pages prerendered

For a catalog known at build time, the product page can be
`Prerender(getParams, handler, { onDemand })` wrapped in `Passthrough()`: the
build bakes the listed products, a CMS webhook refreshes one with
`router.prerender()`, and the live handler renders the long tail. `onDemand`
cannot be combined with `ppr`, so this variant stores the Flight payload but
no HTML shell; a plain `Prerender` (no `onDemand`) can take `ppr`, but then a
content change needs a deploy. The pattern, webhook included, is in
[`./content-site.md`](./content-site.md#the-blog-section).

## The cart

```ts
// src/loaders/shop.ts
import { createLoader } from "@rangojs/router";
import { carts } from "../lib/carts";
import { catalog } from "../lib/catalog";
import { CartId } from "../middleware/cart";

// Per visitor: live, never cached.
export const CartLoader = createLoader(async (ctx) => {
  const id = ctx.get(CartId);
  const items = id ? await carts.get(id) : [];
  return { count: items.length, items };
});

// Change by the minute: live on every request, shell HITs included.
export const PriceLoader = createLoader(async (ctx) =>
  catalog.price(ctx.params.slug!),
);
export const StockLoader = createLoader(async (ctx) =>
  catalog.stock(ctx.params.slug!),
);
export const ReviewsLoader = createLoader(async (ctx) =>
  catalog.reviews(ctx.params.slug!),
);
```

```ts
// src/actions/cart.ts
"use server";

import { cookies, getRequestContext } from "@rangojs/router";
import { carts } from "../lib/carts";
import { CartId } from "../middleware/cart";

export async function addToCart(slug: string) {
  const ctx = getRequestContext();
  let id = ctx.get(CartId);
  if (!id) {
    id = crypto.randomUUID();
    cookies().set("cart", id, { httpOnly: true, path: "/" });
    // loadCart ran before the action; the revalidation render reads this.
    ctx.set(CartId, id);
  }
  await carts.add(id, slug);
  return { ok: true as const };
}
```

One add-to-cart from a product page re-runs `CartLoader` (its
`revalidate()` names cart actions) and `StockLoader` (the default), and holds
`PriceLoader`, `ReviewsLoader` and the product handler (`notOnActions`); the
store layout is skipped after actions by default. Each decision is per
segment, in the action's own response. Without the route's own
`revalidate()`, the handler would re-run on every add-to-cart.

### Variant: the shop as a `clientUrls()` group

When shoppers mostly move inside one layout (filters, tabs, product to
product) and the pages render entirely from loaders, mount the shop as a
`clientUrls()` group, `include("/shop", shopUrls, { name: "shop" })`:
navigations inside it render at the click, and each loader's `revalidate()`
holds its data across them. A group has no handlers, so a `ppr` group route
holds its client components' HTML and its `ssr: false` loaders' data, and
every other loader is a hole; handler output baked from a tagged
`"use cache"` read, as in the catalog above, needs `urls()` routes. The router
repository's `tests/vite-rsc-demo/src/urls/client-shop.client.tsx` is a full
example (index, product, a cart badge, param-sensitive predicates). Through
0.24.2, register the cart loader on a server layout above the include rather
than on the group's `layout()`: a group layout's loader re-runs on every
navigation between the group's routes, whatever its `revalidate()` says
([`./large-app.md`](./large-app.md#known-gap-through-0242-a-group-layout-loader)).

## Checkout

```tsx
// src/urls/checkout.tsx
import { urls } from "@rangojs/router";
import { CheckoutPage } from "../pages/checkout";

// Per visitor and mutating: no ppr, no cache().
export const checkoutPatterns = urls(({ path }) => [
  path("/", CheckoutPage, { name: "start" }),
]);
```

```ts
// src/actions/checkout.ts
"use server";

import { redirect } from "@rangojs/router";
import { payments } from "../lib/payments";

export async function placeOrder(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  if (!email.includes("@")) return { error: "Enter an email address" }; // shown by useActionState
  const session = await payments.createSession();
  // Off-site redirects are refused unless you opt in.
  throw redirect(session.url, { external: true });
}
```

`requireCart` wraps the checkout's renders, not `placeOrder`: an action
checks what it needs itself (`/server-actions` → "Authorization in actions").
A form whose `action` is the dispatcher `useActionState` returns posts
without JavaScript too (`/server-actions` → "Progressive Enhancement").

## Why

| Choice                                        | Why                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `ppr` on category and product pages           | The shared part is HTML from the shell; only the holes render per request  |
| `"use cache"` + `cacheTag()` for product data | One read for every visitor, and the tag reaches the shells that baked it   |
| Live loaders for price, stock, cart           | Fresh on every request, shell HITs included                                |
| `CartLoader` on the store layout              | One badge on every page; held on navigations; narrowed to cart actions     |
| `TRACKING_SEARCH_PARAMS` excluded             | Campaign links do not multiply shells                                      |
| `prefetch: false` on reviews                  | Every product card prefetches its page; few shoppers scroll to the reviews |
| Checkout without `ppr` or `cache()`           | Nothing on it is shared                                                    |
