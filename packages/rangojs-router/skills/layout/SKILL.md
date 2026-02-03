---
name: layout
description: Define layout routes that wrap child routes in @rangojs/router
argument-hint: [component]
---

# Layouts with layout()

Layouts wrap child routes and persist during navigation within their scope.

## Basic Layout

```typescript
import { urls } from "@rangojs/router/server";
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
layout(ShopLayout, () => [
  path("/shop", ShopIndex, { name: "shop" }),
])
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
  revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),

  path("/cart", CartPage, { name: "cart" }),
])
```

## Complete Example

```typescript
import { urls } from "@rangojs/router/server";
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
      revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
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
