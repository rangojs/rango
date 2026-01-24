---
name: intercept
description: Define intercept routes for modals, slide-overs, and soft navigation patterns in rsc-router
argument-hint: [@slot-name] [route-to-intercept]
---

# Intercept Routes

Intercept routes render a different component during soft navigation (client-side) while preserving the background route. Hard navigation (direct URL) shows the full page.

## Basic Intercept

```typescript
import { map } from "rsc-router/server";
import { ParallelOutlet } from "rsc-router";

export default map<typeof routes>(({ route, layout, parallel, intercept, loader }) => [
  layout(
    () => (
      <ShopLayout>
        <Outlet />
        <ParallelOutlet name="@modal" />
      </ShopLayout>
    ),
    () => [
      // Define empty modal slot
      parallel({
        "@modal": () => null,
      }),

      // Intercept product detail into modal
      intercept(
        "@modal",                              // Slot name
        "products.detail",                     // Route to intercept
        (ctx) => <ProductModal id={ctx.params.id} />, // Modal component
      ),

      route("products.index", ProductList),
      route("products.detail", ProductDetail), // Full page version
    ]
  ),
]);
```

## Navigation Behavior

| Navigation Type | What Renders |
|-----------------|--------------|
| Click link `/product/abc` | `<ProductModal />` in `@modal`, background preserved |
| Direct URL `/product/abc` | Full `<ProductDetail />` page |
| Back button from modal | Modal closes, background restored |
| Refresh in modal | Full page loads |

## Intercept with Configuration

```typescript
intercept(
  "@modal",
  "products.detail",
  async (ctx) => {
    const product = await ctx.use(ProductLoader);
    return <ProductModal product={product} />;
  },
  () => [
    loader(ProductLoader),
    loading(<ProductModalSkeleton />),
    revalidate(({ actionId }) => actionId?.includes("cart") ?? false),
    errorBoundary(<ModalErrorFallback />),
  ]
)
```

## Conditional Intercept with `when()`

Only intercept under certain conditions:

```typescript
intercept(
  "@modal",
  "products.detail",
  (ctx) => <ProductModal id={ctx.params.id} />,
  () => [
    // Only intercept when NOT coming from product pages
    when(({ from }) => !from.pathname.startsWith("/products/")),
  ]
)
```

The `when()` callback receives:

```typescript
when(({ from, to }) => {
  from.pathname  // Where user is coming from
  from.params    // Params of source route
  to.pathname    // Where user is going
  to.params      // Params of target route

  return true;   // true = intercept, false = full navigation
})
```

## Multiple Intercepts

```typescript
layout(<ShopLayout />, () => [
  parallel({
    "@modal": () => null,
    "@slideOver": () => null,
  }),

  // Product detail opens as modal
  intercept(
    "@modal",
    "products.detail",
    (ctx) => <ProductModal id={ctx.params.id} />,
  ),

  // Quick view opens as slide-over
  intercept(
    "@slideOver",
    "products.quickView",
    (ctx) => <QuickViewPanel id={ctx.params.id} />,
  ),

  // Cart opens as slide-over
  intercept(
    "@slideOver",
    "cart",
    () => <CartSlideOver />,
  ),

  route("products.index", ProductList),
  route("products.detail", ProductDetail),
  route("products.quickView", ProductQuickView),
  route("cart", CartPage),
])
```

## Intercept with Layout

Wrap the intercepted content:

```typescript
intercept(
  "@modal",
  "products.detail",
  (ctx) => <ProductModalContent id={ctx.params.id} />,
  () => [
    layout(<ModalWrapper />, () => [
      // Configuration applies to modal
      loader(ProductLoader),
      loading(<ProductModalSkeleton />),
    ]),
  ]
)

// ModalWrapper provides chrome around content
function ModalWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal-container">
        <CloseButton />
        {children}
      </div>
    </div>
  );
}
```

## Intercept with Middleware

```typescript
intercept(
  "@modal",
  "account.settings",
  (ctx) => <SettingsModal user={ctx.get("user")} />,
  () => [
    middleware(async (ctx, next) => {
      // Verify user is logged in for modal
      const user = ctx.get("user");
      if (!user) {
        throw redirect("/login");
      }
      await next();
    }),
  ]
)
```

## Photo Gallery Example

```typescript
// Instagram-style photo gallery with modal
export default map<typeof routes>(({ route, layout, parallel, intercept }) => [
  layout(
    () => (
      <GalleryLayout>
        <Outlet />
        <ParallelOutlet name="@lightbox" />
      </GalleryLayout>
    ),
    () => [
      parallel({
        "@lightbox": () => null,
      }),

      // Photo opens in lightbox on soft nav
      intercept(
        "@lightbox",
        "photos.detail",
        (ctx) => (
          <Lightbox>
            <PhotoViewer id={ctx.params.id} />
          </Lightbox>
        ),
        () => [
          loader(PhotoLoader),
          loading(<PhotoSkeleton />),
          // Only intercept from gallery pages
          when(({ from }) => from.pathname.startsWith("/gallery")),
        ]
      ),

      route("photos.index", PhotoGrid),
      route("photos.detail", PhotoPage), // Full page with comments, etc.
    ]
  ),
]);
```

## Form Modal Example

```typescript
// Edit form in modal, full page fallback
intercept(
  "@modal",
  "posts.edit",
  async (ctx) => {
    const post = await ctx.use(PostLoader);
    return (
      <EditModal>
        <PostForm post={post} />
      </EditModal>
    );
  },
  () => [
    loader(PostLoader),
    middleware(authMiddleware),
    // Revalidate after save action
    revalidate(({ actionId }) => actionId === "savePost"),
  ]
)
```

## Closing the Modal

From within the modal, use navigation:

```typescript
"use client";

import { useRouter } from "rsc-router";

function CloseButton() {
  const router = useRouter();

  return (
    <button onClick={() => router.back()}>
      Close
    </button>
  );
}

// Or navigate to a specific route
function CloseButton() {
  const router = useRouter();

  return (
    <button onClick={() => router.push("/products")}>
      Close
    </button>
  );
}
```

## Key Points

1. **Intercept requires a parallel slot** - Define with `parallel({ "@modal": () => null })`
2. **Soft nav only** - Only works for client-side navigation, not direct URLs
3. **Preserves background** - The route behind the modal stays rendered
4. **Full page fallback** - Direct URL always shows the full route handler
5. **Back button works** - Browser back closes modal naturally
6. **SEO friendly** - Search engines see the full page, users get the modal UX
