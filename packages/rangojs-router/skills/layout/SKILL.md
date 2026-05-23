---
name: layout
description: Define layout routes that wrap child routes in @rangojs/router
argument-hint: [component]
---

# Layouts with layout()

Layouts wrap child routes and persist during navigation within their scope.

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

```typescript
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

`<Outlet />` renders child content. Import from `@rangojs/router/client`:

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

For parallel routes, use named outlets:

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

A layout as a child of `path()` wraps the route content and can read
data set by the route handler via `ctx.get()`. The handler always
executes before its children.

This handler-first guarantee applies to a single full render pass
(initial render, prerender, or full HTML re-render). During partial
action revalidation, only the segments that revalidate are recomputed.
If an orphan layout depends on data established by an outer handler or
layout, that outer segment must also revalidate, or the orphan must
guard/reload the data independently.

```typescript
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

urls(({ path, layout, parallel }) => [
  path("/product/:slug", (ctx) => {
    const product = await fetchProduct(ctx.params.slug);
    ctx.set("product", product);
    return <ProductPage product={product} />;
  }, { name: "product" }, () => [
    layout((ctx) => {
      const product = ctx.get("product");
      return (
        <div>
          <Breadcrumb name={product?.name} />
          <Outlet />
          <ParallelOutlet name="@related" />
        </div>
      );
    }, () => [
      parallel({
        "@related": (ctx) => {
          const product = ctx.get("product");
          return <RelatedProducts category={product?.category} />;
        },
      }),
    ]),
  ]),
])
```

Orphan layouts can call `ctx.get()` to read data set by their parent
handler. They can also call `ctx.set()`, though the primary pattern is
for route handlers and middleware to write context variables and for
orphan layouts to read them.

## Layout Revalidation

Layouts don't revalidate by default. Control with `revalidate()`:

```typescript
layout(<ShopLayout />, () => [
  // Never revalidate (default behavior)
  revalidate(() => false),

  path("/shop", ShopIndex, { name: "shop" }),
])

// Or revalidate based on conditions
layout(<CartLayout />, () => [
  revalidate(({ actionId }) => actionId?.includes("Cart") || undefined),

  path("/cart", CartPage, { name: "cart" }),
])
```

If child segments read data that was established by this layout or by a
route handler above them, revalidate the outer segment too. Partial
revalidation does not re-run non-revalidated ancestors just to rebuild
their `ctx.set()` state.

### Revalidation Contracts

For shared upstream data, define named revalidation functions and reuse
them on both producer and consumer segments:

```typescript
// revalidation-contracts.ts
export const revalidateCartData = ({ actionId }) =>
  actionId?.includes("src/actions/cart.ts#addToCart") || undefined;
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
import { revalidate } from "@rangojs/router";

export const revalidateAuthData = ({ actionId }) =>
  actionId?.includes("src/actions/auth.ts#") || undefined;
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
import { urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function ShopLayout() {
  return (
    <div className="shop">
      <ParallelOutlet name="@promoBanner" />
      <nav>
        <a href="/shop">Home</a>
        <a href="/shop/cart">Cart</a>
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
      revalidate(({ actionId }) => actionId?.includes("Cart") || undefined),
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
