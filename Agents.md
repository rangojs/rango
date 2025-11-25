# RSC Router - Agent Reference Guide

Quick reference for understanding the routing API, segment system, and key patterns.

## Core Concepts

### Route Definition (routes.ts)

Routes are plain objects with type-safe keys:

```typescript
export const shopRoutes = route({
  index: "/",
  products: {
    category: "/products/:category",
    detail: {
      view: "/product/:slug",
    },
  },
  cart: "/cart",
  checkout: {
    index: "/checkout",
    payment: "/checkout/payment",
  },
});
```

- Nesting creates dotted keys: `products.detail.view`
- Params use `:paramName` syntax
- Route names are used in handlers as type-safe references

### Handler Definition (handlers/*.tsx)

Handlers use `map()` with array-based builder pattern:

```typescript
export default map<typeof shopRoutes>(
  ({ route, layout, middleware, parallel, revalidate }) => [
    layout(<RootLayout />),
    layout(<ShopLayout />, () => [
      route("index", IndexPage),
      route("cart", CartPage),
    ]),
  ]
);
```

## Layout Patterns

### Orphan Layouts (Stacking)

Layouts WITHOUT routes inside are "orphans" - they stack as siblings and wrap all routes below:

```typescript
map(() => [
  layout(<RootLayout />),     // Orphan - wraps everything below
  layout(<ShopLayout />),     // Orphan - wraps everything below
  layout(<PromoBar />),       // Orphan - wraps everything below

  route("index", IndexPage),  // Wrapped by all 3 layouts above
  route("cart", CartPage),    // Wrapped by all 3 layouts above
])
```

Benefits:
- Flat structure, no deep nesting
- Easy to read and generate
- Layouts stack in order (top to bottom = outer to inner)

### Nested Layouts (Scoping)

Layouts WITH routes inside scope those routes:

```typescript
map(() => [
  layout(<RootLayout />),  // Orphan - wraps everything

  layout(<ShopLayout />, () => [
    route("index", IndexPage),      // Wrapped by RootLayout + ShopLayout
    route("cart", CartPage),        // Wrapped by RootLayout + ShopLayout
  ]),

  layout(<CheckoutLayout />, () => [
    route("checkout.index", ...),   // Wrapped by RootLayout + CheckoutLayout (NOT ShopLayout)
  ]),
])
```

Use nesting when different routes need different layout groups.

### Route-Owned Layouts (belongsToRoute)

Layouts inside a route's callback belong to that route:

```typescript
route("products.detail", ProductPage, () => [
  layout(<ProductWrapper />),      // Belongs to this route
  parallel({ "@related": ... }),   // Belongs to this route
  revalidate(productRevalidation), // Revalidates this route
])
```

Key behavior:
- Route-owned segments have `belongsToRoute: true`
- They revalidate WITH the route (on param changes, actions)
- React keys include params (forces remount on param change)

## Segment System

### Segment Types

| Type | Description |
|------|-------------|
| `layout` | Wraps child content via `<Outlet />` |
| `route` | The leaf content for a URL |
| `parallel` | Named slots rendered via `<ParallelOutlet name="@slot" />` |

### belongsToRoute Flag

Determines revalidation and React key behavior:

| Segment Location | `belongsToRoute` | Revalidates on Action | Params in Key |
|------------------|------------------|----------------------|---------------|
| Parent chain layout | `false` | No | No |
| Parent chain parallel | `false` | No | No |
| Route | `true` | Yes | Yes |
| Inside route callback (orphan) | `true` | Yes | Yes |

### Revalidation Rules

**On Navigation (GET):**
- Routes revalidate when params change
- Parent chain layouts/parallels do NOT revalidate by default
- Use `revalidate()` to opt-in

**On Actions (POST):**
- Routes always revalidate
- Route-owned segments (`belongsToRoute: true`) revalidate
- Parent chain segments do NOT revalidate

### Custom Revalidation

```typescript
route("post", PostPage, () => [
  revalidate(({ currentParams, nextParams, defaultShouldRevalidate }) => {
    // Hard decision (boolean) - short-circuits
    return currentParams.slug !== nextParams.slug;

    // OR soft decision (object) - continues to next revalidator
    return { defaultShouldRevalidate: true };
  }),
])
```

## Parallel Routes

Named slots for rendering multiple components at the same level:

```typescript
layout(
  <>
    <ParallelOutlet name="@sidebar" />
    <Outlet />
  </>,
  () => [
    parallel({
      "@sidebar": () => <Sidebar />,
    }),
    route("index", IndexPage),
  ]
)
```

Route-specific parallels:

```typescript
route("cart", CartPage, () => [
  parallel({
    "@summary": () => <OrderSummary />,
  }),
])
```

## Code Organization

### Recommended: Co-locate Routes, Abstract Layouts

```typescript
// common/layouts.ts
export const CommonLayouts = () => [
  layout(<RootLayout />),
  layout(<PromoBar />),
];

// handlers/shop.tsx
map(() => [
  ...CommonLayouts(),

  // Routes stay here - visible, traceable
  layout(<ShopLayout />, () => [
    route("index", IndexPage),
    route("cart", CartPage),
  ]),
])
```

Rule: **Abstract layouts, co-locate routes.**

### Plugin Pattern

For extensible admin/plugin systems:

```typescript
// plugins/analytics.ts
export const AnalyticsPlugin = {
  routes: () => [
    route("analytics.index", AnalyticsDashboard),
    route("analytics.reports", ReportsPage),
  ],
};

// handlers/admin.tsx
const plugins = [AnalyticsPlugin, SEOPlugin];

map(() => [
  ...CommonLayouts(),
  layout(<AdminLayout />, () => [
    // Core routes visible
    route("index", AdminDashboard),
    route("settings", SettingsPage),

    // Plugin routes explicit
    ...plugins.flatMap(p => p.routes()),
  ]),
])
```

## Segment System Primer

### What is a Segment?

A segment is a unit of UI that can be independently rendered and cached. The router builds a tree of segments for each route match.

```
URL: /shop/product/shoe-a

Segments (top to bottom):
├── L0 (RootLayout)           belongsToRoute: false
├── L1 (ShopLayout)           belongsToRoute: false
├── L2.@sidebar (Sidebar)     belongsToRoute: false (parallel)
├── L3 (ProductWrapper)       belongsToRoute: true  (inside route callback)
├── L3.@related (Related)     belongsToRoute: true  (inside route callback)
└── R4 (ProductPage)          belongsToRoute: true  (the route itself)
```

### Segment ID Format

IDs encode the hierarchy:
- `L0` - Layout at depth 0
- `R1` - Route at depth 1
- `L2.@sidebar` - Parallel slot on layout at depth 2
- `$root.$0.$1.index` - Full namespace path

### How Segments are Built

1. **Route match** - Find the matching route entry
2. **Traverse parent chain** - Walk from root to leaf via `entry.parent`
3. **Resolve each entry** - Execute handlers, collect segments
4. **Process orphans** - Layouts inside route callbacks

```typescript
// Traversal order (root to leaf)
for (const entry of traverseBack(manifestEntry)) {
  const segments = await resolveSegment(entry, ...);
}
```

### Segment Resolution

For each entry in the chain:

```typescript
// Parent chain layout
{
  id: entry.shortCode,
  type: "layout",
  component: <LayoutComponent />,
  belongsToRoute: false,  // Shared across routes
}

// Route entry
{
  id: entry.shortCode,
  type: "route",
  component: <RouteComponent />,
  belongsToRoute: true,   // This is the matched route
}

// Orphan layout (inside route callback)
{
  id: orphan.shortCode,
  type: "layout",
  component: <OrphanComponent />,
  belongsToRoute: true,   // Belongs to the route
}
```

### renderSegments() - Building the React Tree

Segments are rendered bottom-to-top using `OutletProvider`:

```typescript
// Input segments (top to bottom):
[RootLayout, ShopLayout, ProductPage]

// Output tree (nested):
<OutletProvider content={...}>
  <RootLayout>
    <OutletProvider content={...}>
      <ShopLayout>
        <OutletProvider content={null}>
          <ProductPage />
        </OutletProvider>
      </ShopLayout>
    </OutletProvider>
  </RootLayout>
</OutletProvider>
```

The `<Outlet />` component reads from `OutletContext` to render children.

### Parallel Segments

Parallels attach to their parent segment:

```typescript
// Segments with parallel
[
  { id: "L0", type: "layout", ... },
  { id: "L0.@sidebar", type: "parallel", slot: "@sidebar", ... },
  { id: "R1", type: "route", ... },
]

// segmentTreeWalk groups them
yield { segment: L0, parallel: [L0.@sidebar] }
yield { segment: R1, parallel: [] }
```

Rendered via `<ParallelOutlet name="@sidebar" />`.

## Segment Serialization (Server to Client)

### RSC Payload Structure

```typescript
type RscPayload = {
  root: ReactNode;        // Full tree OR null (partial)
  metadata: {
    pathname: string;
    segments: ResolvedSegment[];
    matched: string[];    // All segment IDs for current route
    diff: string[];       // Only segments that changed
    isPartial?: boolean;
  };
  returnValue?: { ok: boolean; data: any };
};
```

### Partial Rendering Flow

1. Server sends `matched` (all segment IDs) + `diff` (changed segments with components)
2. Client stores segments in `Map<string, ResolvedSegment>`
3. Client rebuilds full tree using `matched` IDs + stored segments
4. Only changed segments come over the wire

### React Key Generation

Keys include params for route-owned segments to force remount:

```typescript
// Route-owned (belongsToRoute: true)
key = "0-R1.index-slug=shoe-a"  // Params in key

// Parent chain (belongsToRoute: false)
key = "0-L0"  // No params - stays mounted across param changes
```

## Quick Rules

1. **Orphan layouts stack** - no callback means wraps everything below
2. **Nested layouts scope** - callback with routes inside scopes those routes
3. **Route callbacks = ownership** - anything inside belongs to that route
4. **belongsToRoute = revalidates together** - route-owned segments share lifecycle
5. **Routes are source of truth** - define in routes.ts, reference in handlers
6. **Abstract layouts, co-locate routes** - keep route structure visible
