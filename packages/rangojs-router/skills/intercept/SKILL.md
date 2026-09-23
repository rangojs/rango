---
name: intercept
description: Define intercept routes for modals, slide-overs, and soft navigation patterns in @rangojs/router. Use when opening a route as a modal/overlay on top of the current page while keeping the URL shareable, or asking "how do I show this page in a modal".
argument-hint: [@slot-name] [route-to-intercept]
---

# Intercept Routes

Intercept routes render a different component during soft navigation (client-side) while preserving the background route. Hard navigation (direct URL) shows the full page.

`intercept(slot, routeName, handler, config?, use?)`:

- `slot` — the `@name` slot the intercept renders into; the layout places it
  with `<ParallelOutlet name="@modal" />`.
- `routeName` — the target route. A dot prefix (`".product"`) resolves inside
  the current `include()` scope; a bare name (`"product"`) is the global route
  name. Declare the intercept in a layout that wraps the target route — the
  router finds intercepts by walking up the target route's own layout chain.
- `handler` — the component or handler rendered in the slot.
- `config` — optional `{ when }` (see "Conditional Intercept"); pass the `use`
  callback as the 4th argument when there is no config.

## Not this skill if…

- You want a slot that ALWAYS renders alongside the page (sidebar, multi-column
  layout) — that is a permanent `parallel()` slot: see `/parallel`.
- You want the same component regardless of soft vs hard navigation —
  intercepts only swap on soft navigation; see `/parallel`.

## Basic Intercept

```typescript
import { urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function ShopLayout() {
  return (
    <div className="shop">
      <Outlet />
      <ParallelOutlet name="@modal" />
    </div>
  );
}

export const urlpatterns = urls(({ path, layout, intercept, loader, loading }) => [
  layout(<ShopLayout />, () => [
    // Intercept product detail - shows modal during soft navigation
    intercept(
      "@modal",              // Slot name
      "product",             // Route name to intercept
      <ProductModal />,      // Modal component
      () => [
        loader(ProductLoader),
        loading(<ProductModalSkeleton />),
      ]
    ),

    // Normal routes
    path("/shop", ShopIndex, { name: "index" }),
    path("/shop/product/:slug", ProductPage, { name: "product" }),
  ]),
]);
```

## Navigation Behavior

| Navigation Type                | What Renders                                         |
| ------------------------------ | ---------------------------------------------------- |
| Click link `/shop/product/abc` | `<ProductModal />` in `@modal`, background preserved |
| Direct URL `/shop/product/abc` | Full `<ProductPage />` page                          |
| Browser back                   | Close modal, restore previous state                  |

## Intercept with Layout

Wrap intercept content in a modal layout. The layout renders the intercept
content through `<Outlet />` (not a `children` prop):

```typescript
intercept(
  "@modal",
  "product",
  <ProductModalContent />,
  () => [
    layout(<ModalWrapper />),  // Wraps the modal content via <Outlet />
    loader(ProductLoader),
    loading(<ProductModalSkeleton />),
  ]
)
```

Only the first `layout()` in an intercept's `use()` is applied.

## Intercept Middleware

Intercepts support their own middleware chain via the use callback. The full chain for an intercept request is:

```
global mw (router.use) -> route mw (urls middleware()) -> intercept mw -> intercept loaders + handler
```

The intercept's loaders are started before its handler is called, so they run
in parallel with it. If intercept middleware returns a `Response` (e.g. a
redirect), the intercept stops there.

```typescript
intercept(
  "@modal",
  "product",
  <ProductModal />,
  () => [
    middleware(async (ctx, next) => {
      // Runs only for this intercept, after global and route middleware
      ctx.set("interceptSource", "modal");
      await next();
    }),
    loader(ProductLoader),
  ]
)
```

The intercept handler can read context variables set by all upstream middleware layers (global, route, and intercept-specific).

Handler/layout `ctx.set()` data follows the same rule as elsewhere:
intercepts see data produced in the current render pass, but partial
action revalidation only recomputes segments that actually revalidate.
If an intercept depends on data established by an outer layout/handler,
revalidate that outer segment too or reload/guard the data inside the
intercept.

### Revalidation Contracts for Intercept Dependencies

Use named revalidation contracts on both the outer producer and the intercept
consumer when they share `ctx.set()` data:

```typescript
import type { Revalidate } from "@rangojs/router";
import * as ProductActions from "./actions/product";

export const revalidateProductShell: Revalidate = (ctx) =>
  ctx.isAction(ProductActions) || undefined;

layout(ProductLayout, () => [
  revalidate(revalidateProductShell), // producer reruns
  intercept("@modal", "product", <ProductModal />, () => [
    revalidate(revalidateProductShell), // consumer reruns
    loader(ProductLoader),
  ]),
]);
```

Compose multiple contracts if the intercept depends on multiple upstream
domains.

Helper handoff style keeps intercept trees terse:

```typescript
import { revalidate } from "@rangojs/router";

export const revalidateProduct = () => [
  revalidate(revalidateProductShell),
];

layout(ProductLayout, () => [
  revalidateProduct(),
  intercept("@modal", "product", <ProductModal />, () => [
    revalidateProduct(),
    loader(ProductLoader),
  ]),
]);
```

## Conditional Intercept with the `when` config

Only intercept based on navigation context. `when` goes in the config object
(4th argument); the use-items then move to the 5th-argument callback. The
config type is not exported — pass an object literal.

```typescript
intercept(
  "@modal",
  "product",
  <ProductModal />,
  // Only intercept when coming from a different section
  { when: ({ from }) => !from.pathname.startsWith("/shop/product/") },
  () => [
    loader(ProductLoader),
  ]
)
```

`when` is a synchronous match-time selector. It receives `from` / `to` (URLs),
`fromRouteName` / `toRouteName` (named routes only), `params` (the target's),
`segments` (the client's current segment path and ids), `request`, and `env`.
Pass an array of predicates for AND logic (all must return true). Omit `when`
entirely and the intercept always activates. `when` is not re-evaluated during
action revalidation, so an open modal stays open after an action.

```typescript
// Intercept only when opened from the shop index
intercept("@modal", "product", <ProductModal />, {
  when: ({ fromRouteName }) => fromRouteName === "index",
})
```

```typescript
intercept(
  "@modal",
  "product",
  <ProductModal />,
  {
    when: [
      ({ from }) => from.pathname.startsWith("/shop"),
      ({ params }) => params.slug !== "featured",
    ],
  },
  () => [
    loader(ProductLoader),
  ]
)
```

## Multiple Loaders in Intercept

```typescript
intercept(
  "@modal",
  "product",
  <ProductModal />,
  () => [
    loader(ProductLoader, () => [cache()]),
    loader(ProductCartLoader, () => [revalidate(() => true)]),
    loader(RecommendationsLoader),
  ]
)
```

## Closing the Modal

Use navigation to close:

```typescript
"use client";
import { Outlet, useRouter } from "@rangojs/router/client";

// Used as the intercept's layout: layout(<ModalWrapper />)
export function ModalWrapper() {
  const router = useRouter();

  return (
    <div className="modal-overlay" onClick={() => router.back()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => router.back()}>Close</button>
        <Outlet />
      </div>
    </div>
  );
}
```

## Interaction with View Transitions

A layout that owns the `@modal` slot can also configure `transition()` for page
fades — opening a modal does **not** fire the layout's view transition. Rango
narrows the layout's `<ViewTransition>` wrap to the layout's default outlet
content, so `<ParallelOutlet />` (the slot where the modal mounts) is a sibling
of the wrap, not inside its subtree. Form actions submitted from inside an open
modal also commit without firing the underlying layout's transition, and the
modal subtree identity is preserved across revalidation (no remount,
`useActionState` survives). Closing the modal restores the page without a
stray transition.

For a modal-only morph (e.g. when intercepted URLs change while the modal
stays open), use an element-level React `<ViewTransition>` inside the modal
component — `transition()` accepted on `intercept()` via the DSL is not
applied to slot rendering today.

Caveat: route-level `transition()` wraps the route component itself, so a
`<ParallelOutlet />` rendered directly inside that route component would still
be inside the route's VT subtree. Mount the slot in a layout instead when you
combine intercept modals with route-level transitions.

See [skills/view-transitions](../view-transitions/SKILL.md) for the full
contract and direction-aware examples.

## Interaction with Prerender

When the target route of an intercept uses `Prerender`, the intercept handler is
also resolved at build time and stored alongside the main pre-rendered segments.
This means intercept navigations to pre-rendered routes are served from the
prerender store without executing handler code at runtime.

```typescript
// The detail route is pre-rendered
export const ProductDetail = Prerender(
  async () => [{ slug: "shoes" }, { slug: "jacket" }],
  async (ctx) => <ProductPage slug={ctx.params.slug} />,
);

// urls.tsx
layout(ShopLayout, () => [
  path("/:slug", ProductDetail, { name: "detail" }, () => [
    loader(ProductLoader),
  ]),

  // This intercept is also pre-rendered at build time
  intercept(
    "@modal",
    ".detail",
    <ProductModal />,
    { when: ({ from }) => from.pathname.startsWith("/shop") },
    () => [loader(ProductLoader)],
  ),
])
```

Build-time behavior:

- The intercept handler (`<ProductModal />`) is resolved with BuildContext
- Result is stored under the key `"detail/paramHash/i"` (intercept variant)
- `when` config conditions are skipped at build time (all intercepts pre-rendered unconditionally)
- `when` is still evaluated at runtime by the intercept-resolution middleware

Runtime behavior:

- Intercept navigation: prerender store serves the `/i` variant (frozen handler + fresh loaders)
- Direct navigation: prerender store serves the main variant (full page)
- If no intercept prerender entry exists, falls through to live intercept resolution

Loaders inside the intercept always run fresh at request time, same as regular
pre-rendered routes.

During action-driven partial revalidation, this same partial rule applies:
refreshing the intercept does not implicitly rebuild non-revalidated outer
segments.

## Complete Example

```typescript
// components/shop-layout.tsx
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

export function ShopLayout() {
  return (
    <div className="shop">
      <ParallelOutlet name="@promoBanner" />
      <main>
        <Outlet />
      </main>
      <ParallelOutlet name="@modal" />
    </div>
  );
}

// components/modal-wrapper.tsx (see "Closing the Modal" for a closable version)
import { Outlet } from "@rangojs/router/client";

export function ModalWrapper() {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <Outlet />
      </div>
    </div>
  );
}

// urls/shop.tsx — mounted with include("/shop", shopPatterns, { name: "shop" })
import { urls } from "@rangojs/router";
import { ShopLayout } from "../components/shop-layout";
import { ModalWrapper } from "../components/modal-wrapper";

export const shopPatterns = urls(({
  path,
  layout,
  parallel,
  intercept,
  loader,
  loading,
  cache,
}) => [
  layout(<ShopLayout />, () => [
    parallel({
      "@promoBanner": () => <PromoBanner />,
    }),

    // Intercept product detail into modal
    intercept(
      "@modal",
      ".product", // dot-local: resolves to "shop.product" in this include
      <ProductModalContent />,
      { when: ({ from }) => !from.pathname.startsWith("/shop/product/") },
      () => [
        layout(<ModalWrapper />),
        loading(<ProductModalSkeleton />),
        loader(ProductLoader, () => [cache()]),
        loader(RecommendationsLoader),
      ]
    ),

    // Normal routes
    path("/", ShopIndex, { name: "index" }),
    path("/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader),
      loading(<ProductPageSkeleton />),
    ]),
  ]),
]);
```

## Handler-attached `.use`

Intercept handlers can carry their own middleware, loaders, loading state, error/notFound boundaries, and even nested `layout`/`route` defaults via `.use` — useful for self-contained modal components that travel with their own data and chrome. (Conditional activation is set via the `when` config on the mount-site `intercept()` call, not inside `.use`.)

```typescript
import { layout, loader, loading, type Handler } from "@rangojs/router";

const QuickViewModal: Handler = async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <QuickView product={product} />;
};
QuickViewModal.use = () => [
  loader(ProductLoader),
  loading(<QuickViewSkeleton />),
  layout(<ModalChrome />), // ModalChrome renders <Outlet />
];

intercept("@modal", "product", QuickViewModal);
```

Explicit `use()` at the mount site merges with `handler.use` (handler defaults first, explicit second). See [skills/handler-use](../handler-use/SKILL.md) for merge order and the per-mount-site allowed-types table.
