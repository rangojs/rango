---
name: intercept
description: Define intercept routes for modals, slide-overs, and soft navigation patterns in @rangojs/router
argument-hint: [@slot-name] [route-to-intercept]
---

# Intercept Routes

Intercept routes render a different component during soft navigation (client-side) while preserving the background route. Hard navigation (direct URL) shows the full page.

Canonical semantics reference:
[docs/execution-model.md](../../docs/internal/execution-model.md)

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

export const urlpatterns = urls(({ path, layout, intercept, loader }) => [
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

Wrap intercept content in a modal layout:

```typescript
intercept(
  "@modal",
  "product",
  <ProductModalContent />,
  () => [
    layout(<ModalWrapper />),  // Wraps the modal content
    loader(ProductLoader),
    loading(<ProductModalSkeleton />),
  ]
)
```

## Intercept Middleware

Intercepts support their own middleware chain via the use callback. The full chain for an intercept request is:

```
global mw (router.use) -> route mw (urls middleware()) -> intercept mw -> intercept handler -> intercept loaders
```

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

## Conditional Intercept with when()

Only intercept based on navigation context:

```typescript
intercept(
  "@modal",
  "product",
  <ProductModal />,
  () => [
    // Only intercept when coming from a different section
    when(({ from }) => !from.pathname.startsWith("/shop/product/")),
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
import { useRouter } from "@rangojs/router/client";

function ModalWrapper({ children }) {
  const router = useRouter();

  return (
    <div className="modal-overlay" onClick={() => router.back()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => router.back()}>Close</button>
        {children}
      </div>
    </div>
  );
}
```

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
  intercept("@modal", ".detail", <ProductModal />, () => [
    when(({ from }) => from.pathname.startsWith("/shop")),
    loader(ProductLoader),
  ]),
])
```

Build-time behavior:

- The intercept handler (`<ProductModal />`) is resolved with BuildContext
- Result is stored under the key `"detail/paramHash/i"` (intercept variant)
- `when()` conditions are skipped at build time (all intercepts pre-rendered unconditionally)
- `when()` is still evaluated at runtime by the intercept-resolution middleware

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
// components/ProductModal.tsx
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function ShopLayout() {
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

function ModalWrapper({ children }) {
  return (
    <div className="modal-overlay">
      <div className="modal">{children}</div>
    </div>
  );
}

// urls/shop.tsx
import { urls } from "@rangojs/router";

export const shopPatterns = urls(({
  path,
  layout,
  parallel,
  intercept,
  loader,
  loading,
  when,
}) => [
  layout(<ShopLayout />, () => [
    parallel({
      "@promoBanner": () => <PromoBanner />,
    }),

    // Intercept product detail into modal
    intercept(
      "@modal",
      "product",  // Route name (without prefix)
      <ProductModalContent />,
      () => [
        when(({ from }) => !from.pathname.startsWith("/shop/product/")),
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
