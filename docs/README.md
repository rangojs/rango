# RSC Router API Reference

Code-first, type-safe React Server Components router.

## Quick Start

```typescript
// 1. Define routes
import { route } from "rsc-router/server";

export const shopRoutes = route({
  index: "/",
  products: {
    category: "/products/:category",
    detail: "/product/:slug",
  },
  cart: "/cart",
});

// 2. Create router
import { createRouter } from "rsc-router/server";

const router = createRouter<AppContext>();
router.route("/shop", shopRoutes).map(() => import("./handlers/shop"));

// 3. Define handlers
import { map } from "rsc-router/server";

export default map<typeof shopRoutes>(({ route, layout, middleware, parallel, loader, revalidate, loading, errorBoundary, notFoundBoundary }) => [
  layout(<RootLayout />),
  layout(<ShopLayout />, () => [
    middleware(authMiddleware()),

    route("index", () => <ShopIndex />),
    route("products.detail", (ctx) => <ProductDetail slug={ctx.params.slug} />, () => [
      revalidate(({ currentParams, nextParams }) => currentParams.slug !== nextParams.slug),
      parallel({
        "@reviews": (ctx) => <Reviews slug={ctx.params.slug} />,
      }),
    ]),
  ]),
]);
```

## Route Definition

```typescript
import { route } from "rsc-router/server";

export const routes = route({
  index: "/",
  post: "/:slug",
  nested: {
    child: "/nested/:id",
  },
});
```

Routes are relative to mount point. When mounted at `/blog`, `/:slug` becomes `/blog/:slug`.

## Handler Helpers

All helpers are available in the `map()` callback:

| Helper | Purpose |
|--------|---------|
| `route(name, handler, use?)` | Define route handler |
| `layout(component, use?)` | Define layout wrapper |
| `middleware(...fns)` | Attach middleware |
| `parallel(slots, use?)` | Define parallel routes |
| `loader(loaderDef, use?)` | Attach data loader |
| `revalidate(fn)` | Control revalidation |
| `loading(component, skipSSR?)` | Loading UI |
| `errorBoundary(fallback)` | Error fallback |
| `notFoundBoundary(fallback)` | NotFound fallback |
| `intercept(slot, route, component, use?)` | Intercept for soft nav |

## Layout Composition

Layouts compose by position in array:

```typescript
map(({ layout, route }) => [
  layout(<A />),     // Wraps everything below
  layout(<B />),     // Stacks on A
  route("x", ...),   // Gets A -> B -> x
  route("y", ...),   // Gets A -> B -> y
]);
```

Route-scoped layouts:

```typescript
route("x", Handler, () => [
  layout(<OnlyForX />),  // Only wraps route x
]);
```

## Middleware

```typescript
middleware((ctx, next) => {
  if (!ctx.user) throw new Error("Unauthorized");
  next();
});
```

Middleware runs before handlers. Call `next()` to continue chain.

**Context methods:**
- `ctx.set(key, value)` / `ctx.get(key)` - Store/retrieve values
- `ctx.var` - Access all stored values
- `redirect(url)` - Soft redirect (SPA navigation)

## Parallel Routes

```typescript
parallel({
  "@sidebar": () => <Sidebar />,
  "@modal": (ctx) => <Modal id={ctx.params.id} />,
});
```

Render with `<Outlet name="@sidebar" />` in layouts.

## Intercepting Routes

Intercepts render alternative content in a named slot during soft navigation (client-side). Hard navigation (direct URL access) renders the normal route instead.

**Use case**: Modal overlays that preserve the background page.

### Definition

```typescript
layout(<KanbanLayout />, () => [
  // Intercept "card" route - renders in @modal slot during soft nav
  intercept("@modal", "card", <CardModal />, () => [
    loader(CardDetailLoader),
    revalidate(() => false),
  ]),
]),

// Hard navigation to /card renders this instead
route("card", () => <CardDetailPage />),
```

### Layout with Outlet

```tsx
function KanbanLayout({ children }) {
  return (
    <div>
      <KanbanBoard />
      <Outlet name="@modal" />  {/* Intercept content renders here */}
      <Outlet />                 {/* Normal route content */}
    </div>
  );
}
```

### Behavior

| Navigation Type | What Renders |
|-----------------|--------------|
| Click link to `/card` | `<CardModal />` in `@modal` slot, background preserved |
| Direct URL `/card` | `<CardDetailPage />` as full page |
| Back button from modal | Modal closes, background restored |

### With Loaders and Revalidation

```typescript
intercept("@modal", "products.detail", <ProductModal />, () => [
  loader(ProductLoader),
  revalidate(({ currentParams, nextParams }) =>
    currentParams.slug !== nextParams.slug
  ),
]),
```

## Data Loading

```typescript
import { createLoader } from "rsc-router";

export const ProductLoader = createLoader(async (ctx) => {
  return await db.products.findUnique({ where: { slug: ctx.params.slug } });
});

// In handler
route("products.detail", async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductDetail product={product} />;
}, () => [
  loader(ProductLoader),
]);
```

## Revalidation

Controls when segments re-render during client navigation:

```typescript
revalidate(({ currentParams, nextParams, defaultShouldRevalidate }) => {
  return currentParams.slug !== nextParams.slug;
});
```

**Return values:**
- `true` / `false` - Hard decision, stops evaluation
- `{ defaultShouldRevalidate: boolean }` - Soft decision, continues to next

**Default behavior:**
- Params changed -> revalidate
- Only query/hash changed -> skip

## Server Actions

```typescript
// actions/shop.ts
"use server";

export async function addToCart(productId: string) {
  await db.cart.add({ productId });
}

// In component
<form>
  <button formAction={addToCart.bind(null, product.id)}>
    Add to Cart
  </button>
</form>
```

Actions trigger automatic revalidation.

## Error Boundaries

```typescript
errorBoundary(({ error, reset }) => (
  <div>
    <p>Error: {error.message}</p>
    <button onClick={reset}>Try again</button>
  </div>
));
```

## NotFound Boundaries

```typescript
import { notFound } from "rsc-router";

route("products.detail", async (ctx) => {
  const product = await db.products.get(ctx.params.slug);
  if (!product) throw notFound("Product not found");
  return <ProductDetail product={product} />;
}, () => [
  notFoundBoundary(<ProductNotFound />),
]);
```

## Handle API

Accumulate data across route hierarchy (breadcrumbs, meta, etc.):

```typescript
// Define handle
import { createHandle } from "rsc-router/client";

export const Breadcrumbs = createHandle<{ label: string; href: string }>("breadcrumbs");

// Push from handler
const push = ctx.use(Breadcrumbs);
push({ label: "Shop", href: "/shop" });

// Consume in client component
import { useHandle } from "rsc-router/client";

function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  return <nav>{crumbs.map(c => <a href={c.href}>{c.label}</a>)}</nav>;
}
```

## Metadata

Built-in `Meta` handle for managing document metadata with automatic deduplication.

### Basic Usage

```typescript
import { Meta } from "rsc-router/server";
import { MetaTags } from "rsc-router/client";

// In route handler
route("products.detail", async (ctx) => {
  const meta = ctx.use(Meta);
  const product = await ctx.use(ProductLoader);

  meta({ title: product.name });
  meta({ name: "description", content: product.description });
  meta({ property: "og:title", content: product.name });
  meta({ property: "og:image", content: product.image });

  return <ProductDetail product={product} />;
});

// In root layout
function RootLayout({ children }) {
  return (
    <html>
      <head>
        <MetaTags />  {/* Renders collected meta tags */}
      </head>
      <body>{children}</body>
    </html>
  );
}
```

### Title Templates

Define a template in layouts, child routes automatically inherit it:

```typescript
// Layout sets template
layout((ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: { template: "%s | My Site", default: "My Site" } });
  return <Layout><Outlet /></Layout>;
});

// Child route - template applied automatically
route("about", (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "About" });  // Becomes "About | My Site"
  return <About />;
});

// Bypass template with absolute
route("landing", (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: { absolute: "Special Landing Page" } });  // No template
  return <Landing />;
});
```

**Title descriptor options:**

| Form | Example | Result |
|------|---------|--------|
| String | `{ title: "About" }` | Applies template if set |
| Template | `{ title: { template: "%s \| Site", default: "Site" } }` | Sets template for children |
| Absolute | `{ title: { absolute: "Custom" } }` | Bypasses template |

### Unset Meta

Remove inherited meta from parent layouts:

```typescript
// Parent layout sets defaults
layout((ctx) => {
  const meta = ctx.use(Meta);
  meta({ name: "robots", content: "index, follow" });
  meta({ property: "og:image", content: "/default.jpg" });
  return <Layout><Outlet /></Layout>;
});

// Child route removes specific meta
route("private", (ctx) => {
  const meta = ctx.use(Meta);
  meta({ unset: "name:robots" });           // Remove robots meta
  meta({ unset: "property:og:image" });     // Remove og:image
  return <PrivatePage />;
});
```

**Unset key format:**

| Meta Type | Unset Key |
|-----------|-----------|
| Title | `"title"` |
| Name | `"name:description"`, `"name:robots"` |
| Property | `"property:og:title"`, `"property:og:image"` |
| HTTP-Equiv | `"httpEquiv:refresh"` |

### Supported Descriptors

```typescript
meta({ charSet: "utf-8" });
meta({ title: "Page Title" });
meta({ name: "description", content: "..." });
meta({ property: "og:title", content: "..." });
meta({ httpEquiv: "refresh", content: "5" });
meta({ tagName: "link", rel: "canonical", href: "..." });
meta({ "script:ld+json": { "@type": "Product", name: "..." } });
```

### Async Meta (Streaming)

**Option 1: Await first, then set meta**

```typescript
route("product", async (ctx) => {
  const meta = ctx.use(Meta);
  const product = await ctx.use(ProductLoader);  // Await data first

  // Meta set after await - streams to client
  meta({ title: product.name });
  meta({ property: "og:title", content: product.name });

  return <Product product={product} />;
});
```

**Option 2: Pass a Promise directly**

Meta accepts `Promise<MetaDescriptor>` for deferred resolution:

```typescript
route("product", (ctx) => {
  const meta = ctx.use(Meta);

  // Pass async function result (Promise) - streams when resolved
  meta((async () => {
    const product = await fetchProduct(ctx.params.id);
    return { property: "og:description", content: product.description };
  })());

  // Or with explicit Promise
  meta(
    fetchProduct(ctx.params.id).then(product => ({
      property: "og:image",
      content: product.image
    }))
  );

  return <ProductSkeleton />;  // Renders immediately, meta streams in
});
```

This pattern is useful when you want the page to render immediately while meta streams in later.

### Deduplication

Later routes override earlier ones for the same key:

```typescript
// Root layout
meta({ title: "Site" });
meta({ name: "author", content: "Default Author" });

// Child route
meta({ title: "Blog" });  // Overrides root title
// author meta inherited from root
```

### Default Meta

These are included automatically (can be overridden):

```typescript
{ charSet: "utf-8" }
{ name: "viewport", content: "width=device-width, initial-scale=1" }
```

## Type-Safe Links

### Setup: Register Routes

For type-safe links, register your routes via module augmentation:

```typescript
// router.ts
import { createRouter, route } from "rsc-router/server";

const shopRoutes = route({
  index: "/",
  cart: "/cart",
  products: { detail: "/product/:slug" },
});

const router = createRouter<AppEnv>();
router.route("/shop", shopRoutes).map(() => import("./handlers/shop"));

// Extract route types from router
type AppRoutes = typeof router.routeMap;

// Register globally for type-safe href
declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

// Export for use throughout app
export { router };
export const reverse = router.reverse;
```

### Using router.reverse (Route Names)

Generate URLs from route names with type-safe params:

```typescript
import { reverse } from "./router";

// Routes without params
reverse("shop.index");  // "/shop"
reverse("shop.cart");   // "/shop/cart"

// Routes with params - TypeScript enforces required params
href("shop.products.detail", { slug: "my-product" });  // "/shop/product/my-product"
```

### Using href from client (Path Validation)

Validate paths at compile-time against registered routes:

```typescript
import { href } from "rsc-router/client";

// Valid paths (compile)
href("/shop/cart");              // matches /shop/cart
href("/shop/product/widget");    // matches /shop/product/:slug

// With query strings and hashes
href("/shop/cart?coupon=ABC");
href("/shop#featured");

// Invalid paths cause TypeScript errors
href("/nonexistent");  // Error: not assignable to ValidPaths
```

### Link Component

SPA navigation with prefetch support:

```tsx
import { Link } from "rsc-router/client";

// Basic usage
<Link to="/shop">Shop</Link>

// With type-safe href
<Link to={href("/shop/product/widget")}>View Product</Link>

// Options
<Link to="/checkout" replace>Checkout</Link>      // Replace history
<Link to="/about" scroll={false}>About</Link>     // Keep scroll position
<Link to="/docs" prefetch="hover">Docs</Link>     // Prefetch on hover
<Link to="/external" reloadDocument>Reload</Link> // Full page load

// With navigation state
<Link to="/product/123" state={{ from: "list" }}>View Product</Link>
```

### Navigation State

Pass typed state through navigation that persists in `history.state`.

#### Type-Safe State (Recommended)

Define state with `createLocationState` for type safety:

```tsx
// location-states.ts
import { createLocationState } from "rsc-router/client";

// Define typed state with a stable key
export const ProductState = createLocationState<{
  name: string;
  price: number;
}>("product");

export const ScrollState = createLocationState<{ scrollY: number }>("scroll");
```

Use in navigation:

```tsx
import { Link, useNavigation } from "rsc-router/client";
import { ProductState, ScrollState } from "./location-states";

// Via Link - pass array of state entries
<Link
  to="/product/123"
  state={[ProductState({ name: "Widget", price: 29 })]}
>
  View Product
</Link>

// Multiple states
<Link
  to="/checkout"
  state={[ProductState(product), ScrollState({ scrollY: window.scrollY })]}
>
  Checkout
</Link>

// Via navigate - same API
const { navigate } = useNavigation();
navigate("/product/123", {
  state: [ProductState({ name: "Widget", price: 29 })]
});
```

Read typed state:

```tsx
import { useLocationState } from "rsc-router/client";
import { ProductState } from "./location-states";

function ProductModal() {
  // Type-safe: returns { name: string; price: number } | undefined
  const product = useLocationState(ProductState);

  if (product) {
    return <div>Loading {product.name} (${product.price})...</div>;
  }
  return <div>Loading...</div>;
}
```

#### Lazy Evaluation

For values that should be captured at click time (not render time):

```tsx
// Pass a getter function - called when user clicks
<Link
  to="/product/123"
  state={[ScrollState(() => ({ scrollY: window.scrollY }))]}
>
  View
</Link>
```

#### Legacy Format (Backwards Compatible)

Simple untyped state still works:

```tsx
// Static state
<Link to="/product/123" state={{ from: "list" }}>View</Link>

// Navigate with legacy state
navigate("/product/123", { state: { from: "list" } });

// Read legacy state (untyped)
const state = useLocationState<{ from?: string }>();
```

State is preserved on browser back/forward navigation.

## Link Interception

By default, RSC Router intercepts clicks on same-origin anchor elements for SPA navigation. This behavior can be configured.

### Global Interception Toggle

Disable global link interception to rely solely on `<Link>` components:

```typescript
await initBrowserApp({
  rscStream,
  deps,
  linkInterception: false,  // Disable global interception
});
```

### Data Attributes

Control interception behavior on individual anchors:

| Attribute | Effect |
|-----------|--------|
| `data-link-component` | Link component marker (auto-added). These anchors handle their own navigation. |
| `data-external` | External link marker (auto-added by Link). Never intercepted. |
| `data-no-intercept="true"` | Opt-out individual anchors from global interception. |

```html
<!-- This anchor won't be intercepted -->
<a href="/legacy-page" data-no-intercept="true">Legacy Page</a>
```

### Interception Rules

Links are **not intercepted** when:
- Cross-origin (different host)
- Has `download` attribute
- Has `target` other than `_self`
- Has `data-no-intercept="true"`
- Has `data-link-component` (Link component)
- Has `data-external` (external link)
- Modifier keys pressed (Cmd/Ctrl/Shift/Alt)

## Client Components

```typescript
import { Outlet, Link, useNavigation, useAction, useLoader } from "rsc-router/client";

// Outlet renders child content
<Outlet />
<Outlet name="@sidebar" />

// Hooks
const { pathname, searchParams } = useNavigation();
const data = useLoader(ProductLoader);
```

## Handler Context

```typescript
route("post", (ctx) => {
  ctx.params.slug;        // Route params
  ctx.pathname;           // Current path
  ctx.searchParams;       // URLSearchParams
  ctx.request;            // Original Request
  ctx.url;                // URL object
  // + AppContext fields (db, user, env, etc.)
});
```

## Router Options

```typescript
createRouter<AppContext>({
  defaultErrorBoundary: ({ error }) => <DefaultError error={error} />,
  defaultNotFoundBoundary: ({ notFound }) => <DefaultNotFound />,
});
```
