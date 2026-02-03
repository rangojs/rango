---
name: layout
description: Define layout routes that wrap child routes in @rangojs/router
argument-hint: [layout-name]
---

# Layout Routes

Layouts wrap child routes and stack vertically from parent to child.

## Basic Layout

```typescript
import { map } from "@rangojs/router/server";
import { Outlet } from "@rangojs/router";

// Layout component
function ShopLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shop">
      <ShopHeader />
      <div className="shop-content">
        {children}
      </div>
      <ShopFooter />
    </div>
  );
}

// Handler definition
export default map<typeof routes>(({ route, layout }) => [
  layout(<ShopLayout />, () => [
    route("index", ShopIndex),
    route("products", ProductList),
    route("cart", Cart),
  ]),
]);
```

## Nested Layouts

Layouts can be nested - they stack from parent to child:

```typescript
export default map<typeof routes>(({ route, layout }) => [
  // Root layout wraps everything
  layout(<RootLayout />, () => [
    route("index", HomePage),

    // Shop layout nested inside root
    layout(<ShopLayout />, () => [
      route("shop.index", ShopIndex),
      route("shop.products", ProductList),

      // Account layout nested inside shop
      layout(<AccountLayout />, () => [
        route("shop.account.index", AccountIndex),
        route("shop.account.orders", OrderList),
      ]),
    ]),

    // Blog layout also inside root (sibling to shop)
    layout(<BlogLayout />, () => [
      route("blog.index", BlogIndex),
      route("blog.post", BlogPost),
    ]),
  ]),
]);
```

Result for `/shop/account/orders`:
```
<RootLayout>
  <ShopLayout>
    <AccountLayout>
      <OrderList />
    </AccountLayout>
  </ShopLayout>
</RootLayout>
```

## Layout with Data Loading

Layouts can fetch data and use middleware:

```typescript
export default map<typeof routes>(({ route, layout, loader, middleware }) => [
  layout(
    async (ctx) => {
      const user = await ctx.use(UserLoader);
      return (
        <DashboardLayout user={user}>
          <Outlet />
        </DashboardLayout>
      );
    },
    () => [
      loader(UserLoader),
      middleware(authMiddleware),

      route("dashboard.index", DashboardIndex),
      route("dashboard.settings", Settings),
    ]
  ),
]);
```

## Orphan Layouts

A layout without children extends the parent layout:

```typescript
layout(<RootLayout />, () => [
  // This route uses RootLayout + ShopLayout
  layout(<ShopLayout />),
  route("shop.index", ShopIndex),

  // This route only uses RootLayout
  route("about", About),
]);
```

## Layout with Parallel Slots

```typescript
layout(
  (ctx) => (
    <DashboardLayout>
      <ParallelOutlet name="@sidebar" />
      <main>
        <Outlet />
      </main>
      <ParallelOutlet name="@notifications" />
    </DashboardLayout>
  ),
  () => [
    parallel({
      "@sidebar": () => <Sidebar />,
      "@notifications": () => <NotificationPanel />,
    }),
    route("dashboard.index", DashboardIndex),
  ]
)
```

## Layout with Handle Accumulation

```typescript
import { createHandle } from "@rangojs/router";

export const Breadcrumbs = createHandle<{ label: string; href: string }>();

export default map<typeof routes>(({ route, layout }) => [
  layout(
    (ctx) => {
      const push = ctx.use(Breadcrumbs);
      push({ label: "Home", href: "/" });
      return <RootLayout><Outlet /></RootLayout>;
    },
    () => [
      layout(
        (ctx) => {
          const push = ctx.use(Breadcrumbs);
          push({ label: "Shop", href: "/shop" });
          return <ShopLayout><Outlet /></ShopLayout>;
        },
        () => [
          route("shop.index", ShopIndex),
        ]
      ),
    ]
  ),
]);

// In client component
function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // crumbs = [{ label: "Home", href: "/" }, { label: "Shop", href: "/shop" }]
}
```

## Layout Configuration Options

```typescript
layout(<MyLayout />, () => [
  loader(LayoutLoader),            // Data for layout
  middleware(authMiddleware),       // Auth check before layout
  loading(<LayoutSkeleton />),      // Loading state
  errorBoundary(<LayoutError />),   // Error boundary
  revalidate(shouldRevalidate),     // Cache control

  // Child routes
  route("index", IndexHandler),
])
```

## Layout Component Pattern

```typescript
// layouts/ShopLayout.tsx
import { Outlet } from "@rangojs/router";

export function ShopLayout({ children }: { children?: React.ReactNode }) {
  return (
    <div className="shop-layout">
      <ShopNav />
      <main>
        {children ?? <Outlet />}
      </main>
      <ShopFooter />
    </div>
  );
}
```

Use `children` for direct children or `<Outlet />` for route content.
