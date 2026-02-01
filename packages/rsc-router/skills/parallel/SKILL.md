---
name: parallel
description: Define parallel routes for multi-column layouts, sidebars, and modal slots in rsc-router
argument-hint: [@slot-name]
---

# Parallel Routes

Parallel routes render multiple components simultaneously in named slots.

## Basic Parallel Routes

```typescript
import { map } from "rsc-router/server";
import { ParallelOutlet } from "rsc-router";

// Handler definition
export default map<typeof routes>(({ route, layout, parallel }) => [
  layout(
    () => (
      <DashboardLayout>
        <aside>
          <ParallelOutlet name="@sidebar" />
        </aside>
        <main>
          <Outlet />
        </main>
        <div className="notifications">
          <ParallelOutlet name="@notifications" />
        </div>
      </DashboardLayout>
    ),
    () => [
      parallel({
        "@sidebar": () => <Sidebar />,
        "@notifications": () => <NotificationPanel />,
      }),

      route("dashboard.index", DashboardIndex),
      route("dashboard.analytics", Analytics),
    ]
  ),
]);
```

## Parallel Routes with Context

Access route params and loaders in parallel slots:

```typescript
parallel({
  "@sidebar": (ctx) => {
    const user = ctx.get("user");
    return <UserSidebar user={user} />;
  },
  "@details": async (ctx) => {
    const data = await ctx.use(DetailsLoader);
    return <DetailsPanel data={data} productId={ctx.params.id} />;
  },
})
```

## Parallel Routes with Configuration

Add loaders, loading states, and revalidation to slots:

```typescript
parallel(
  {
    "@sidebar": async (ctx) => {
      const categories = await ctx.use(CategoriesLoader);
      return <CategorySidebar categories={categories} />;
    },
    "@cart": async (ctx) => {
      const cart = await ctx.use(CartLoader);
      return <CartPreview cart={cart} />;
    },
  },
  () => [
    loader(CategoriesLoader),
    loader(CartLoader),
    loading(<SidebarSkeleton />),
    revalidate(({ actionId }) => actionId?.includes("cart") ?? false),
  ]
)
```

## Independent Slot Revalidation

Each parallel slot can control its own revalidation:

```typescript
layout(<DashboardLayout />, () => [
  // Sidebar only revalidates on sidebar actions
  parallel(
    { "@sidebar": SidebarComponent },
    () => [
      revalidate(({ actionId }) => actionId?.includes("sidebar") ?? false),
    ]
  ),

  // Main content revalidates on route changes
  parallel(
    { "@main": MainComponent },
    () => [
      revalidate(({ currentParams, nextParams }) =>
        currentParams.id !== nextParams.id
      ),
    ]
  ),

  route("dashboard.index", DashboardIndex),
])
```

## Parallel Routes for Modals

Use parallel routes with intercept for modal patterns:

```typescript
layout(
  () => (
    <ShopLayout>
      <Outlet />
      <ParallelOutlet name="@modal" />
    </ShopLayout>
  ),
  () => [
    parallel({
      "@modal": () => null, // Empty by default
    }),

    // Intercept product detail into modal
    intercept(
      "@modal",
      "products.detail",
      (ctx) => <ProductModal id={ctx.params.id} />,
      () => [
        loader(ProductLoader),
        loading(<ProductModalSkeleton />),
      ]
    ),

    route("products.index", ProductList),
    route("products.detail", ProductDetail),
  ]
)
```

## Conditional Parallel Content

```typescript
parallel({
  "@sidebar": (ctx) => {
    const user = ctx.get("user");
    if (!user) return null; // Hide for guests
    if (user.role === "admin") {
      return <AdminSidebar />;
    }
    return <UserSidebar />;
  },
})
```

## Parallel Routes with Error Boundaries

```typescript
parallel(
  {
    "@sidebar": async (ctx) => {
      const data = await ctx.use(SidebarLoader);
      return <Sidebar data={data} />;
    },
  },
  () => [
    loader(SidebarLoader),
    errorBoundary(({ error, reset }) => (
      <div className="sidebar-error">
        <p>Sidebar failed to load</p>
        <button onClick={reset}>Retry</button>
      </div>
    )),
  ]
)
```

## ParallelOutlet Component

```typescript
import { ParallelOutlet } from "rsc-router";

function Layout() {
  return (
    <div className="layout">
      {/* Named slot - renders content from parallel() */}
      <ParallelOutlet name="@sidebar" />

      {/* Main route content */}
      <Outlet />

      {/* Another slot */}
      <ParallelOutlet name="@footer" />
    </div>
  );
}
```

## Dashboard Example

```typescript
// Complete dashboard with multiple panels
export default map<typeof routes>(({ route, layout, parallel, loader }) => [
  layout(
    () => (
      <div className="dashboard-grid">
        <header>
          <ParallelOutlet name="@header" />
        </header>
        <nav>
          <ParallelOutlet name="@nav" />
        </nav>
        <main>
          <Outlet />
        </main>
        <aside>
          <ParallelOutlet name="@activity" />
        </aside>
      </div>
    ),
    () => [
      parallel({
        "@header": () => <DashboardHeader />,
        "@nav": (ctx) => <Navigation user={ctx.get("user")} />,
        "@activity": async (ctx) => {
          const activity = await ctx.use(ActivityLoader);
          return <ActivityFeed items={activity} />;
        },
      }, () => [
        loader(ActivityLoader),
        revalidate(({ actionId }) => actionId?.includes("activity") ?? false),
      ]),

      route("dashboard.index", DashboardHome),
      route("dashboard.projects", Projects),
      route("dashboard.settings", Settings),
    ]
  ),
]);
```

## Slot Naming Convention

- Prefix with `@` (e.g., `@sidebar`, `@modal`, `@header`)
- Use lowercase with hyphens for multi-word names (`@user-panel`)
- Common names: `@sidebar`, `@modal`, `@header`, `@footer`, `@notifications`, `@breadcrumbs`
