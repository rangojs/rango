---
name: parallel
description: Define parallel routes for multi-column layouts, sidebars, and modal slots in @rangojs/router
argument-hint: [@slot-name]
---

# Parallel Routes

Parallel routes render multiple components simultaneously in named slots.

Canonical semantics reference:
[docs/execution-model.md](../../docs/internal/execution-model.md)

## Basic Parallel Routes

```typescript
import { urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>
        <ParallelOutlet name="@sidebar" />
      </aside>
      <main>
        <Outlet />
      </main>
      <div className="notifications">
        <ParallelOutlet name="@notifications" />
      </div>
    </div>
  );
}

export const urlpatterns = urls(({ path, layout, parallel }) => [
  layout(<DashboardLayout />, () => [
    parallel({
      "@sidebar": () => <Sidebar />,
      "@notifications": () => <NotificationPanel />,
    }),

    path("/dashboard", DashboardIndex, { name: "dashboard.index" }),
    path("/dashboard/analytics", Analytics, { name: "dashboard.analytics" }),
  ]),
]);
```

## Parallel Routes with Context

Access route params and loaders in parallel slots:

```typescript
parallel({
  "@sidebar": (ctx) => <Sidebar userId={ctx.params.userId} />,
  "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
})
```

## Reading Handler Data

Parallels can read `ctx.set()` values from their parent handler or layout
via `ctx.get()`. The handler always executes before its parallels
(handler-first).

Visibility follows tree structure:

- Layout-level parallels see layout data, but not path handler data
  (the path is a separate entry).
- Parallels inside a path (or its orphan layouts) see both layout and
  path handler data.

This applies to full render passes. During partial action revalidation,
only revalidated segments are recomputed. If a parallel depends on data
set by an outer handler or layout, revalidate that outer segment too, or
have the parallel reload/guard the data itself.

```typescript
path("/dashboard/:id", (ctx) => {
  const user = await getUser(ctx.params.id);
  ctx.set("user", user);
  return <DashboardPage user={user} />;
}, { name: "dashboard" }, () => [
  layout(DashboardLayout, () => [
    parallel({
      "@sidebar": (ctx) => {
        const user = ctx.get("user");
        return <Sidebar role={user?.role} />;
      },
    }),
  ]),
])
```

## Parallel Routes with Loaders

Add loaders and loading states to parallel routes:

```typescript
parallel(
  {
    "@sidebar": () => <CategorySidebar />,
  },
  () => [
    loader(CategoriesLoader),
    loading(<SidebarSkeleton />),
    revalidate(() => false),  // Never revalidate sidebar
  ]
)
```

## Multiple Parallel Slots

```typescript
layout(<ShopLayout />, () => [
  parallel({
    "@promoBanner": () => (
      <div className="promo-banner">
        Summer Sale! 50% off selected items
      </div>
    ),
    "@sidebar": () => <CategorySidebar />,
    "@cartPreview": () => <CartPreview />,
    "@notification": () => <CartNotification />,
  }),

  path("/shop", ShopIndex, { name: "shop" }),
])
```

## Conditional Parallel Content

Render different content based on context:

```typescript
parallel({
  "@sidebar": (ctx) => {
    const user = ctx.get("user");
    return user ? <UserSidebar user={user} /> : <GuestSidebar />;
  },
})
```

## Parallel Routes with Revalidation

Control when parallel routes revalidate:

```typescript
parallel(
  {
    "@cart": () => <CartSummary />,
  },
  () => [
    loader(CartLoader),
    // Revalidate when cart actions occur
    revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
  ]
)
```

Revalidating only the parallel does not re-run outer handlers/layouts.
If the slot reads `ctx.get()` data established above it, opt the outer
segment into revalidation as well.

### Revalidation Contracts for Parallel Dependencies

Prefer named revalidation contracts shared by both the upstream producer and
the parallel consumer:

```typescript
// revalidation-contracts.ts
export const revalidateCartData = ({ actionId }) =>
  actionId?.includes("src/actions/cart.ts#") ?? false;

layout(CartLayout, () => [
  revalidate(revalidateCartData), // producer reruns
  parallel(
    { "@cart": CartSummary },
    () => [revalidate(revalidateCartData)], // consumer reruns
  ),
]);
```

If the slot consumes multiple upstream domains, compose the contracts on both
segments.

Handoff helper style also works:

```typescript
import { revalidate } from "@rangojs/router";

export const revalidateCart = () => [
  revalidate(revalidateCartData),
];

layout(CartLayout, () => [
  revalidateCart(),
  parallel(
    { "@cart": CartSummary },
    () => [revalidateCart()],
  ),
]);
```

## Named Outlets

Use `ParallelOutlet` to render slots in layouts:

```typescript
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function MyLayout() {
  return (
    <div>
      <header>
        <ParallelOutlet name="@header" />
      </header>

      <div className="content">
        <aside>
          <ParallelOutlet name="@sidebar" />
        </aside>

        <main>
          <Outlet />  {/* Main route content */}
        </main>

        <aside>
          <ParallelOutlet name="@rightPanel" />
        </aside>
      </div>

      <footer>
        <ParallelOutlet name="@footer" />
      </footer>
    </div>
  );
}
```

## Complete Example

```typescript
import { urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function ShopLayout() {
  return (
    <div className="shop">
      <ParallelOutlet name="@promoBanner" />
      <div className="content">
        <aside>
          <ParallelOutlet name="@sidebar" />
        </aside>
        <main>
          <Outlet />
        </main>
        <aside>
          <ParallelOutlet name="@cartPreview" />
        </aside>
      </div>
      <ParallelOutlet name="@notification" />
    </div>
  );
}

export const shopPatterns = urls(({
  path,
  layout,
  parallel,
  loader,
  loading,
  revalidate,
}) => [
  layout(<ShopLayout />, () => [
    // Simple parallel slot
    parallel({
      "@promoBanner": () => <PromoBanner />,
    }),

    // Parallel slot with loader
    parallel(
      { "@sidebar": () => <CategorySidebar /> },
      () => [
        loader(CategoriesLoader),
        revalidate(() => false),
      ]
    ),

    // Parallel slot with revalidation
    parallel(
      { "@cartPreview": () => <CartPreview /> },
      () => [
        loader(CartLoader),
        loading(<CartSkeleton />),
        revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
      ]
    ),

    // Notification slot
    parallel({
      "@notification": () => <CartNotification />,
    }),

    // Routes
    path("/", ShopIndex, { name: "index" }),
    path("/product/:slug", ProductPage, { name: "product" }),
  ]),
]);
```
