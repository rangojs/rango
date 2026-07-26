---
name: parallel
description: Define parallel routes for multi-column layouts, sidebars, and modal slots in @rangojs/router. Use when a layout needs multiple independently-loading regions (e.g. a sidebar and main panel), or rendering more than one route segment at the same URL.
argument-hint: [@slot-name]
---

# Parallel Routes

Parallel routes render multiple components simultaneously in named slots.

## Not this skill if…

- You want a modal or slide-over that appears only on soft navigation and shows
  the full page on hard navigation — that is `intercept()`: see `/intercept`.
- You want a slot rendered conditionally on HOW the user navigated — parallel
  slots ALWAYS render alongside the page; see `/intercept`.

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

## Setting Handles (Meta, Breadcrumbs)

Parallel slot handlers can call `ctx.use(Meta)` or `ctx.use(Breadcrumbs)` to
push handle data. (Loader bodies can too — see `/loader` → "Writing Handles
from Loaders" — which often replaces the UI-less `@meta` slot below.) The data is associated with the **parent** layout or route
segment, not the parallel segment itself. This is because parallels execute
after their parent handler and inherit its segment scope.

This works well for document-level metadata — the handle data follows the
parent's lifecycle (appears when the parent is mounted, removed when it
unmounts).

```typescript
parallel({
  "@meta": (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Product Detail" });
    meta({ name: "description", content: "..." });
    return null; // UI-less slot, only sets metadata
  },
  "@sidebar": (ctx) => <Sidebar />,
})
```

Multiple parallels on the same parent can each push handle data — they all
accumulate under the parent segment ID.

### Pattern: `@meta` slot for per-route metadata overrides

A dedicated `@meta` parallel slot lets routes define metadata separately from
their handler logic. The layout sets defaults via a title template, and each
route overrides via its own `@meta` slot. Since child segments push after
parents and `collectMeta` uses last-wins deduplication, overrides work
naturally.

> **Loader-derived metadata: push from the loader instead.** This slot's
> `await ctx.use(ProductLoader)` routes the data through HANDLER consumption —
> the baked lane under `cache()`/PPR — just to reach a `ctx.use(Meta)` call.
> The loader can now push `Meta` itself (`/loader` → "Writing Handles from
> Loaders"), keeping the data on the live lane; add
> `loader(Def, { stream: "navigation" })` when the meta must be in the SSR'd
> head. Keep the `@meta` slot for metadata that is NOT loader-derived
> (templates, static descriptions, structured data with independent inputs).

```typescript
// Layout sets defaults
layout((ctx) => {
  ctx.use(Meta)({ title: { template: "%s | Store", default: "Store" } });
  return <StoreLayout />;
}, () => [
  // Route with @meta override — decoupled from handler rendering
  path("/:slug", ProductPage, { name: "product" }, () => [
    parallel({
      "@meta": async (ctx) => {
        const product = await ctx.use(ProductLoader);
        const meta = ctx.use(Meta);
        meta({ title: product.name });
        meta({ name: "description", content: product.description });
        meta({
          "script:ld+json": {
            "@context": "https://schema.org",
            "@type": "Product",
            name: product.name,
            description: product.description,
          },
        });
        return null; // UI-less slot
      },
    }),
  ]),
])
```

This keeps the route handler focused on rendering UI while metadata
(title, description, Open Graph, JSON-LD) lives in a composable slot that
can be added, removed, or swapped per route without touching the handler.

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

### Streaming Behavior

Parallels with `loading()` are **independent streaming units**. They don't
block the parent layout or sibling routes during SSR:

- **With `loading()`**: The skeleton renders immediately. The loader runs
  in the background and streams data to the client when ready. The rest
  of the page (layout, route content, other parallels) renders without
  waiting.
- **Without `loading()`**: The parallel's loaders block the parent layout's
  rendering. Use this when the data must be available before the page
  paints (e.g., critical above-the-fold content).
- **SPA navigation**: Parallel loaders resolve in the background. The
  existing parallel UI stays visible — no skeleton flash on route changes
  within the same layout.

```typescript
// Sidebar streams independently — page renders immediately
parallel(
  { "@sidebar": () => <Sidebar /> },
  () => [loader(SlowSidebarLoader), loading(<SidebarSkeleton />)]
)

// Cart data blocks layout — must be ready before paint
parallel(
  { "@cartBadge": () => <CartBadge /> },
  () => [loader(CartCountLoader)]  // No loading() = awaited
)
```

## Composable Slots via `handler.use`

Slot handlers can carry their own loader, loading, error/notFound boundaries, revalidation, and transition defaults via `.use`. The mount site then declares **just the slot names** — no per-call data wiring.

```typescript
const CartSummary: Handler = async (ctx) => {
  const cart = await ctx.use(CartLoader);
  return <CartSummaryView cart={cart} />;
};
CartSummary.use = () => [
  loader(CartLoader),
  loading(<CartSkeleton />),
  revalidate(revalidateCartData),
];

// Same slot, no copy-pasted plumbing across layouts.
layout(<DashboardLayout />, () => [
  parallel({ "@cart": CartSummary }),
  path("/dashboard", DashboardIndex, { name: "dashboard.index" }),
]);

layout(<AccountLayout />, () => [
  parallel({ "@cart": CartSummary }),
  path("/account", AccountIndex, { name: "account.index" }),
]);
```

A slot's `loading()` (whether from `handler.use` or explicit) makes that slot an independent streaming unit, exactly as in the **Streaming Behavior** section above.

Under a shared artifact (`cache()`, `"use cache"`, a PPR shell), the server-side `await ctx.use(CartLoader)` above is the BAKED lane — the capture-time value (identity reads included) freezes into the artifact; consume the loader client-side (`useLoader` in a `"use client"` component) to keep the slot live per request. One rule, stated once: `/rango` → Invariants ("the consumption-lane rule").

The `parallel` mount site has the narrowest allow-list for `handler.use` items — slots cannot bring their own middleware or layout, only `revalidate`, `loader`, `loading`, `errorBoundary`, `notFoundBoundary`, and `transition`. See [skills/handler-use](../handler-use/SKILL.md) for the full table and merge rules.

`transition` is allowed in the slot allow-list, but slot-level rendering does **not** currently apply a `<ViewTransition>` wrapper — only the layout/route wraps take effect at render time. For a modal-only morph today, use an element-level React `<ViewTransition>` inside the slot's component. The reverse direction is the useful guarantee: a layout-level `transition()` fires when the layout's default outlet content changes but **not** when a `<ParallelOutlet />` mounts new content (modal opens are not subtree updates of the layout VT). See [skills/view-transitions](../view-transitions/SKILL.md) for the wrap rules and the intercept caveat.

### Two scopes for explicit `use`: shared (broadcast) and slot-local

`parallel({...slots}, () => [...use])` runs the shared `use()` callback **once per slot** ([dsl-helpers.ts](../../src/route-definition/dsl-helpers.ts)) — items in that callback land on every slot's entry. That's the right behavior for the items the parallel allow-list permits and that accumulate (`loader`, `revalidate`, `errorBoundary`, `notFoundBoundary`, `transition`). (Slots cannot bring `middleware` or `layout` — see the allowed-types note above.)

For single-assignment items like `loading()`, broadcasting overwrites every slot's `handler.use` default. Pass a **slot descriptor** `{ handler, use }` instead — items in the descriptor's `use` apply only to that slot:

```typescript
// @cart gets a custom skeleton; @notifs keeps its handler.use default.
parallel({
  "@cart": {
    handler: Cart,
    use: () => [loading(<CustomCartSkeleton />)],
  },
  "@notifs": Notifs,
});

// Opt one slot out of streaming while siblings still stream the broadcast.
parallel(
  {
    "@cart": { handler: Cart, use: () => [loading(false)] },
    "@notifs": Notifs,
  },
  () => [loading(<BroadcastSkeleton />)],
);
```

Per-slot merge order is **handler.use → shared use → slot-local use**. Slot-local is the narrowest scope, so it wins for last-write-wins items. See [skills/handler-use § `loading()` is a single-assignment item — scope it correctly](../handler-use/SKILL.md#loading-is-a-single-assignment-item--scope-it-correctly) for the full reasoning.

Both a bare arrow slot handler (`"@cart": (ctx) => ...`) and an arrow inside a descriptor (`handler: (ctx) => ...`) infer their `ctx`; no explicit annotation is needed.

## Slot Override Semantics

When multiple `parallel()` calls define the same slot name, **the last
definition wins**. Earlier definitions of that slot are removed. Other
slots from the earlier call are preserved.

This enables composition patterns where included routes override
parent-defined slots:

```typescript
layout(DashboardLayout, () => [
  // Base slots
  parallel({
    "@sidebar": () => <DefaultSidebar />,
    "@footer": () => <Footer />,
  }),

  // Override just @sidebar — @footer is preserved
  parallel({ "@sidebar": () => <CustomSidebar /> }),

  path("/", DashboardIndex, { name: "index" }),
])
```

After resolution, the layout has two parallel entries:

- `{ "@footer": () => <Footer /> }` (first call, `@sidebar` removed)
- `{ "@sidebar": () => <CustomSidebar /> }` (second call, wins)

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
import * as CartActions from "./actions/cart";

parallel(
  {
    "@cart": () => <CartSummary />,
  },
  () => [
    loader(CartLoader),
    // Revalidate when cart actions occur
    revalidate((ctx) => ctx.isAction(CartActions) || undefined),
  ]
)
```

Where the slot sits decides its action default. A parallel under a
`path()` (or one of its orphan layouts) belongs to the route entry and
revalidates together with it on every action — handler-set data stays
consistent with no configuration. A parallel under a standalone
`layout()` entry follows the parent-chain default instead: skipped on
actions unless a `revalidate()` opts it in.

In either position, revalidating only the parallel does not re-run outer
handlers/layouts. If the slot reads `ctx.get()` data established above
it, opt the outer segment into revalidation as well (see `/rango` →
"Passing data down the tree").

A `revalidate()` callback may return a hard `boolean`, a soft
`{ defaultShouldRevalidate }` object, or nothing (`void` / `null` /
`undefined`) to defer to the next revalidator. See
[loader/SKILL.md#revalidate-return-shapes](../loader/SKILL.md#revalidate-return-shapes)
for the full contract — it's the same across `loader()`, `path()`,
`layout()`, `parallel()`, and `intercept()`.

A route-scoped slot revalidates on ANY params or search change by default —
including query-only navigations (`?tab=…`) its content doesn't depend on. If
the slot has no `loading()` of its own, that refresh suspends at the nearest
boundary above it: the route's `loading()`, replacing the entire route content
with the route skeleton while one slot refetches. Either scope the slot's
`revalidate()` (share the route's named contract, as above) or give the slot
its own `loading()` so the fallback stays local. Don't reach for a bare
`revalidate(() => false)`: the slot then never refreshes on param changes
either, and keeps the previous param's content on e.g. a product-to-product
navigation.

`revalidate()` decides whether to _re_-render a slot, never whether to render
it the first time. A slot the browser has not rendered yet has nothing cached
to keep showing, so returning `false` for it would just leave a hole. On that
first render the decision is clamped to `true` and your callback's `false` is
ignored; from the second visit onward it is honored and the browser keeps the
copy it already has. This is what makes `revalidate(() => false)` mean "render
once, then never refetch" rather than "sometimes never appear at all" — before
the clamp, landing on a sibling route and navigating in left the slot blank
until a full reload.

### Revalidation Contracts for Parallel Dependencies

Prefer named revalidation contracts shared by both the upstream producer and
the parallel consumer:

```typescript
// revalidation-contracts.ts
import * as CartActions from "./actions/cart";

export const revalidateCartData = (ctx) =>
  ctx.isAction(CartActions) || undefined;

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

export const revalidateCart = () => [revalidate(revalidateCartData)];

layout(CartLayout, () => [
  revalidateCart(),
  parallel({ "@cart": CartSummary }, () => [revalidateCart()]),
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
import * as CartActions from "./actions/cart";

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
        revalidate((ctx) => ctx.isAction(CartActions) || undefined),
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
