---
name: intercept
description: Define intercept routes for modals, slide-overs, and soft navigation patterns in @rangojs/router
argument-hint: [@slot-name] [route-to-intercept]
---

# Intercept Routes

Intercept routes render a different component during soft navigation (client-side) while preserving the background route. Hard navigation (direct URL) shows the full page.

## Basic Intercept

```typescript
import { urls } from "@rangojs/router/server";
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

| Navigation Type | What Renders |
|-----------------|--------------|
| Click link `/shop/product/abc` | `<ProductModal />` in `@modal`, background preserved |
| Direct URL `/shop/product/abc` | Full `<ProductPage />` page |
| Browser back | Close modal, restore previous state |

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
import { useNavigation } from "@rangojs/router/client";

function ModalWrapper({ children }) {
  const { goBack } = useNavigation();

  return (
    <div className="modal-overlay" onClick={goBack}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button onClick={goBack}>Close</button>
        {children}
      </div>
    </div>
  );
}
```

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
import { urls } from "@rangojs/router/server";

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
