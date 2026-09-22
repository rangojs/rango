---
name: layout
description: Define layout routes that wrap child routes in @rangojs/router. Use when sharing a persistent UI shell (nav, sidebar) across nested routes, or asking how to wrap child pages with a common layout.
argument-hint: [component]
---

# Layouts with layout()

`layout(handler, use?)` wraps its child routes in shared UI (nav, sidebar,
shell). The child content renders where the layout places `<Outlet />`, and the
layout stays mounted while you navigate between the routes it wraps. This skill
covers layout forms, outlets, orphan layouts (a layout inside a `path()`), and
layout revalidation.

Related skills: `/parallel` (named slots rendered by a layout), `/intercept`
(modal slots), `/route` (the routes a layout wraps), `/router-setup` (the
`document` shell that renders `<html>`).

## Basic Layout

```typescript
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

function ShopLayout() {
  return (
    <div className="shop">
      <nav>Shop Navigation</nav>
      <Outlet />  {/* Child routes render here */}
    </div>
  );
}

export const urlpatterns = urls(({ path, layout }) => [
  layout(<ShopLayout />, () => [
    path("/shop", ShopIndex, { name: "shop.index" }),
    path("/shop/cart", CartPage, { name: "shop.cart" }),
    path("/shop/product/:slug", ProductPage, { name: "shop.product" }),
  ]),
]);
```

## Layout Patterns

### JSX Element

```typescript
layout(<ShopLayout />, () => [
  path("/shop", ShopIndex, { name: "shop" }),
])
```

### Component Function

```typescript
layout(ShopLayout, () => [path("/shop", ShopIndex, { name: "shop" })]);
```

### Handler with Context

A function layout receives the same handler context as a route (`ctx.params`,
`ctx.get()`, `ctx.set()`, `ctx.use()`):

```typescript
import { Breadcrumbs } from "@rangojs/router";

layout((ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Shop", href: "/shop" });
  return <ShopLayout />;
}, () => [
  path("/shop", ShopIndex, { name: "shop" }),
])
```

## Nested Layouts

Layouts compose by wrapping order (first layout wraps outer):

```typescript
urls(({ path, layout }) => [
  layout(<RootLayout />, () => [           // Outer
    layout(<ShopLayout />, () => [         // Inner
      path("/shop", ShopIndex, { name: "shop" }),
    ]),
  ]),
])

// Result: RootLayout > ShopLayout > ShopIndex
```

## Layout with Children DSL

Add loaders, parallel routes, or revalidation to layouts:

```typescript
layout(<ShopLayout />, () => [
  // Loaders for layout
  loader(CartLoader),
  loader(UserLoader),

  // Revalidation rules for layout
  revalidate(shopRevalidation),

  // Child routes
  path("/shop", ShopIndex, { name: "shop" }),
  path("/shop/cart", CartPage, { name: "cart" }),
])
```

## The Outlet Component

`<Outlet />` renders child content. Import from `@rangojs/router/client`
(it works in server and client components):

```typescript
import { Outlet } from "@rangojs/router/client";

function ShopLayout() {
  return (
    <div className="shop-layout">
      <header>Shop Header</header>
      <main>
        <Outlet />  {/* Child routes render here */}
      </main>
      <footer>Shop Footer</footer>
    </div>
  );
}
```

A layout's `transition()` config wraps the content that flows through `<Outlet />` — not the layout chrome itself, and not sibling `<ParallelOutlet />` slots. Stacking transitions across nested layouts collapses around the deepest default outlet content. See [skills/view-transitions](../view-transitions/SKILL.md) for the full wrap rules and intercept-modal interaction.

## Named Outlets

For parallel routes, use named outlets (`<Outlet name="@sidebar" />` is
equivalent to `<ParallelOutlet name="@sidebar" />`). Slot content is defined
with `parallel()` — see `/parallel`.

```typescript
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>
        <ParallelOutlet name="@sidebar" />
      </aside>
      <main>
        <Outlet />  {/* Main content */}
      </main>
      <aside>
        <ParallelOutlet name="@notifications" />
      </aside>
    </div>
  );
}
```

## Orphan Layout (inside route)

A layout declared inside a `path()` (an "orphan" layout) wraps that route's
content and can read what the route handler stored with `ctx.set()`. The
handler always executes before its orphan layouts and their parallels.

This is the recommended way to pass handler data downward. It needs no
revalidation setup: orphan layouts and their parallels belong to the route
entry, so on an action the route segment, its loaders, and these children all
re-run together, handler first. They can only desync if you narrow one side
with a predicate that returns a hard `false` — then put the same contract on
both (see "Revalidation Contracts").

Data from an **outer** handler or layout entry is the opposite case: outer
entries are skipped on actions by default. If an orphan layout depends on data
set above its own route entry, give that outer segment a shared revalidation
contract, or have the orphan load/guard the data itself. See `/rango` →
"Passing data down the tree" for the full safest-first ladder.

```typescript
import { createVar } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

const CurrentProduct = createVar<Product>();

urls(({ path, layout, parallel }) => [
  path("/product/:slug", async (ctx) => {
    const product = await fetchProduct(ctx.params.slug);
    ctx.set(CurrentProduct, product);
    return <ProductPage product={product} />;
  }, { name: "product" }, () => [
    layout((ctx) => {
      const product = ctx.get(CurrentProduct); // Product | undefined
      return (
        <div>
          <ProductHeader name={product?.name} />
          <Outlet />
          <ParallelOutlet name="@related" />
        </div>
      );
    }, () => [
      parallel({
        "@related": (ctx) => {
          const product = ctx.get(CurrentProduct);
          return <RelatedProducts category={product?.category} />;
        },
      }),
    ]),
  ]),
])
```

Orphan layouts can also call `ctx.set()` for their own children, but the usual
split is: middleware and route handlers write, orphan layouts and parallels
read.

## Layout Revalidation

A standalone `layout()` renders when it is first mounted and is then kept as-is:

- **Navigation** between routes it already wraps does not re-render it — even
  when the URL params change.
- **Actions** skip it too (the revalidation trace calls this
  `action:parent-chain-skip`).

Orphan layouts inside a `path()` are the opposite: they belong to the route
entry and re-render with it (on param/search changes and on every action).

Opt a standalone layout in with `revalidate()`. Return `true` to re-render,
or `undefined` to defer to the default:

```typescript
import * as CartActions from "./actions/cart";

// Re-render after any cart action
layout(<CartLayout />, () => [
  revalidate((ctx) => ctx.isAction(CartActions) || undefined),

  path("/cart", CartPage, { name: "cart" }),
])

// Re-render when a param the layout displays changes
layout(LocaleLayout, () => [
  revalidate(({ currentParams, nextParams }) =>
    currentParams.locale !== nextParams.locale || undefined,
  ),

  path("/:locale/shop", ShopIndex, { name: "shop" }),
])
```

`revalidate(() => false)` on a standalone layout only restates the default.
The return shapes (hard boolean, soft `{ defaultShouldRevalidate }`, or defer)
are covered in `/loader` → "`revalidate()` return shapes".

If child segments read data that was established by this layout or by a
route handler above them, revalidate the outer segment too. Partial
revalidation does not re-run non-revalidated ancestors just to rebuild
their `ctx.set()` state.

### Revalidation Contracts

Contracts are the tool for cross-entry sharing — the bottom rung of the
data-passing ladder (`/rango` → "Passing data down the tree"). Before
writing one, check whether the producer can move down a rung: into the
consumer's own entry as an orphan layout, into middleware, or into a
loader. When the data genuinely must flow from an outer entry, define
named revalidation functions and reuse them on both producer and
consumer segments:

```typescript
// revalidation-contracts.ts
import type { Revalidate } from "@rangojs/router";
import { addToCart } from "./actions/cart";

export const revalidateCartData: Revalidate = (ctx) =>
  ctx.isAction(addToCart) || undefined;
```

```typescript
layout(<CartLayout />, () => [
  revalidate(revalidateCartData), // producer
  path("/cart", CartPage, { name: "cart" }, () => [
    revalidate(revalidateCartData), // consumer
  ]),
]);
```

If a segment depends on multiple upstream domains, compose multiple
contracts (`revalidateAuthData`, `revalidateCartData`, and so on).

You can also package them as importable handoff helpers:

```typescript
// revalidation-contracts.ts
import { revalidate, type Revalidate } from "@rangojs/router";
import * as AuthActions from "./actions/auth";

export const revalidateAuthData: Revalidate = (ctx) =>
  ctx.isAction(AuthActions) || undefined;
export const revalidateAuth = () => [revalidate(revalidateAuthData)];
```

```typescript
layout(<ShellLayout />, () => [
  revalidateAuth(),
  path("/account", AccountPage, { name: "account" }, () => [
    revalidateAuth(),
  ]),
]);
```

## Complete Example

```typescript
import { urls, Breadcrumbs } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import * as CartActions from "./actions/cart";

function ShopLayout() {
  return (
    <div className="shop">
      <ParallelOutlet name="@promoBanner" />
      <nav>
        <Link to="/shop">Home</Link>
        <Link to="/shop/cart">Cart</Link>
      </nav>
      <div className="content">
        <aside>
          <ParallelOutlet name="@sidebar" />
        </aside>
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const shopPatterns = urls(({ path, layout, parallel, loader, revalidate }) => [
  layout((ctx) => {
    const push = ctx.use(Breadcrumbs);
    push({ label: "Shop", href: "/shop" });
    return <ShopLayout />;
  }, () => [
    // Layout loaders
    loader(CartLoader, () => [
      revalidate((ctx) => ctx.isAction(CartActions) || undefined),
    ]),

    // Parallel routes
    parallel({
      "@promoBanner": () => <PromoBanner />,
      "@sidebar": () => <CategorySidebar />,
    }),

    // Child routes
    path("/shop", ShopIndex, { name: "index" }),
    path("/shop/cart", CartPage, { name: "cart" }),
    path("/shop/product/:slug", ProductPage, { name: "product" }),
  ]),
]);
```

## Handler-attached `.use`

Layout handlers can carry their own middleware, default parallels, and includes via `.use` so a layout becomes a self-contained unit reusable across mount sites.

```typescript
import { middleware, parallel, type Handler } from "@rangojs/router";

const AdminLayout: Handler = (ctx) => {
  const user = ctx.get(CurrentUser);
  return <Admin user={user} />;
};
AdminLayout.use = () => [
  middleware(requireAdmin),
  parallel({ "@adminNotifs": AdminNotifsSlot }),
];

// Mount site declares structure only; defaults travel with the layout.
layout(AdminLayout, () => [
  path("/admin", AdminIndex, { name: "admin.index" }),
]);
```

Allowed item types in a layout's `.use` mirror the layout `use()` callback (the broadest set). Explicit `use()` at the mount site merges with `handler.use` (handler defaults first, explicit second). See [skills/handler-use](../handler-use/SKILL.md) for merge order and per-mount-site allowed types.
