# RSC Router API Design

## Route Definition API

### Basic Routes

```typescript
import { route } from "rsc-router";

// Define route map with patterns (relative paths for mounting)
export const blogRoutes = route({
  index: "/",           // Will be /blog when mounted at /blog
  post: "/:slug",       // Will be /blog/:slug
  category: "/:category/:id",  // Will be /blog/:category/:id
});

// Mount at /blog prefix in router
router.route('/blog', blogRoutes).map(() => import('./blog.js'));
```

### Nested Routes (Relative Paths)

```typescript
// Routes defined relative to mount point (no /admin prefix)
export const adminRoutes = route({
  dashboard: "/", // Becomes /admin when mounted at /admin
  users: {
    list: "/users", // Becomes /admin/users
    detail: "/users/:id", // Becomes /admin/users/:id
    edit: "/users/:id/edit", // Becomes /admin/users/:id/edit
  },
  settings: "/settings", // Becomes /admin/settings
});

// Mount at /admin - routes are automatically prefixed
router.route("/admin", adminRoutes);

// Routes are reusable - can be mounted elsewhere
router.route("/dashboard", adminRoutes); // /dashboard/users, /dashboard/settings, etc.
```

### Nested Routes - Handler Example

```typescript
import { map, layout, middleware } from 'rsc-router';

export default map<typeof adminRoutes>({
  // Global layouts - apply to ALL admin routes
  [layout('*', 'root')]: <RootLayout />,
  [layout('*', 'admin')]: <AdminLayout />,

  // Global middleware - apply to ALL admin routes
  [middleware('*', 'auth')]: [requireAuth()],

  // Additional middleware only for edit route
  [middleware('users.edit', 'adminCheck')]: [requireAdmin()],

  // Route handlers - use dot notation for nested routes
  dashboard: () => <AdminDashboard />,
  'users.list': () => <UsersList />,
  'users.detail': (ctx) => <UserDetail id={ctx.params.id} />,
  'users.edit': (ctx) => <UserEdit id={ctx.params.id} />,
  settings: () => <AdminSettings />
});
// All routes get: RootLayout → AdminLayout → requireAuth()
// users.edit additionally gets: requireAdmin()
```

### Complex Example: E-commerce Site

```typescript
// routes/shop.routes.ts
export const shopRoutes = route({
  index: '/',
  products: {
    list: '/products',
    category: '/products/category/:category',
    detail: '/products/:slug',
  },
  cart: '/cart',
  checkout: {
    index: '/checkout',
    shipping: '/checkout/shipping',
    payment: '/checkout/payment',
    confirmation: '/checkout/confirmation/:orderId',
  },
  account: {
    index: '/account',
    orders: '/account/orders',
    orderDetail: '/account/orders/:orderId',
  }
});

// handlers/shop.handlers.tsx
import { map, layout, parallel, middleware, revalidate } from 'rsc-router';

export default map<typeof shopRoutes>({
  // ===== LAYOUTS =====

  // Global layout - applies to ALL routes
  [layout('*', 'root')]: <RootLayout />,

  // Shop layout - applies to shop and product routes
  [layout('index', 'shop')]: <ShopLayout />,
  [layout('products.list', 'shop')]: <ShopLayout />,
  [layout('products.category', 'shop')]: <ShopLayout />,
  [layout('products.detail', 'shop')]: <ShopLayout />,
  [layout('cart', 'shop')]: <ShopLayout />,

  // Products - with breadcrumbs
  [layout('products.list', 'breadcrumbs')]: (ctx) => <BreadcrumbsLayout path={ctx.pathname} />,
  [layout('products.category', 'breadcrumbs')]: (ctx) => <BreadcrumbsLayout path={ctx.pathname} />,

  // Cart - with cart context
  [layout('cart', 'cart')]: async (ctx) => {
    const cart = await getCart(ctx.session.cartId);
    return <CartProvider cart={cart} />;
  },

  // Checkout layouts
  [layout('checkout.index', 'checkout')]: <CheckoutLayout />,
  [layout('checkout.shipping', 'checkout')]: <CheckoutLayout />,
  [layout('checkout.payment', 'checkout')]: <CheckoutLayout />,
  [layout('checkout.confirmation', 'minimal')]: <MinimalLayout />,

  // Account layouts
  [layout('account.index', 'account')]: <AccountLayout />,
  [layout('account.orders', 'account')]: <AccountLayout />,
  [layout('account.orderDetail', 'account')]: <AccountLayout />,

  // ===== PARALLEL ROUTES =====

  // Product detail - show related products and reviews
  [parallel('products.detail', 'slots')]: {
    '@related': async (ctx) => {
      const related = await getRelatedProducts(ctx.params.slug);
      return <RelatedProducts products={related} />;
    },
    '@reviews': async (ctx) => {
      const reviews = await getProductReviews(ctx.params.slug);
      return <ProductReviews reviews={reviews} />;
    }
  },

  // Cart - show recommendations
  [parallel('cart', 'slots')]: {
    '@recommendations': async (ctx) => {
      const cart = await getCart(ctx.session.cartId);
      const recommendations = await getRecommendations(cart);
      return <Recommendations products={recommendations} />;
    }
  },

  // Checkout - show order summary sidebar
  [parallel('checkout.shipping', 'slots')]: {
    '@summary': async (ctx) => {
      const cart = await getCart(ctx.session.cartId);
      return <OrderSummary cart={cart} />;
    }
  },

  [parallel('checkout.payment', 'slots')]: {
    '@summary': async (ctx) => {
      const order = await getOrder(ctx.session.orderId);
      return <OrderSummary order={order} />;
    }
  },

  // ===== MIDDLEWARE =====

  // Checkout requires authentication
  [middleware('checkout.index', 'auth')]: [requireAuth()],
  [middleware('checkout.shipping', 'auth')]: [requireAuth()],
  [middleware('checkout.payment', 'auth')]: [requireAuth()],
  [middleware('checkout.confirmation', 'auth')]: [requireAuth()],

  // Account routes require authentication
  [middleware('account.index', 'auth')]: [requireAuth()],
  [middleware('account.orders', 'auth')]: [requireAuth()],
  [middleware('account.orderDetail', 'auth')]: [requireAuth()],

  // Cart tracking
  [middleware('cart', 'analytics')]: [trackCartView()],

  // ===== REVALIDATION =====

  // Revalidate product detail when slug changes
  [revalidate('products.detail')]: ({ prevParams, nextParams }) =>
    prevParams.slug !== nextParams.slug,

  // Revalidate order detail when orderId changes
  [revalidate('account.orderDetail')]: ({ prevParams, nextParams }) =>
    prevParams.orderId !== nextParams.orderId,

  [revalidate('checkout.confirmation')]: ({ prevParams, nextParams }) =>
    prevParams.orderId !== nextParams.orderId,

  // ===== ROUTE HANDLERS =====

  index: () => <ShopHome />,

  'products.list': async (ctx) => {
    const products = await getProducts();
    return <ProductsList products={products} />;
  },

  'products.category': async (ctx) => {
    const products = await getProductsByCategory(ctx.params.category);
    return <ProductsCategory category={ctx.params.category} products={products} />;
  },

  'products.detail': async (ctx) => {
    const product = await getProduct(ctx.params.slug);
    return <ProductDetail product={product} />;
  },

  cart: async (ctx) => {
    const cart = await getCart(ctx.session.cartId);
    return <Cart cart={cart} />;
  },

  'checkout.index': () => <CheckoutStart />,

  'checkout.shipping': async (ctx) => {
    const cart = await getCart(ctx.session.cartId);
    return <CheckoutShipping cart={cart} />;
  },

  'checkout.payment': async (ctx) => {
    const order = await getOrder(ctx.session.orderId);
    return <CheckoutPayment order={order} />;
  },

  'checkout.confirmation': async (ctx) => {
    const order = await getOrder(ctx.params.orderId);
    return <CheckoutConfirmation order={order} />;
  },

  'account.index': async (ctx) => {
    const user = await getUser(ctx.user.id);
    return <AccountDashboard user={user} />;
  },

  'account.orders': async (ctx) => {
    const orders = await getUserOrders(ctx.user.id);
    return <OrdersList orders={orders} />;
  },

  'account.orderDetail': async (ctx) => {
    const order = await getOrder(ctx.params.orderId);
    return <OrderDetail order={order} />;
  }
});
```

## Handler Definition API

### Pattern-Based Type-Safe API

The router uses **string patterns** for metadata association. You can use raw strings or helper functions - both are fully type-safe.

#### Basic Example (String Patterns)

```typescript
// handlers/blog.handlers.tsx
import { map } from 'rsc-router';
import type { blogRoutes } from '../routes/blog.routes';

export default map<typeof blogRoutes>({
  // Global layouts - apply to all routes (using wildcard '*')
  "$layout.*.root": <RootLayout />,
  "$layout.*.blog": <BlogLayout />,

  // Global middleware
  "$middleware.*.logger": [
    (_ctx, next) => {
      console.log('Blog route accessed');
      next();
    }
  ],

  // Per-route layouts
  "$layout.post.content": <ContentLayout />,

  // Per-route parallel routes
  "$parallel.post.slots": {
    '@sidebar': (ctx) => <PostSidebar slug={ctx.params.slug} />,
    '@comments': (ctx) => <Comments postId={ctx.params.slug} />
  },

  // Revalidation
  "$revalidate.post": ({ prevParams, nextParams }) =>
    prevParams.slug !== nextParams.slug,

  // Route handlers
  index: () => <BlogIndex />,
  post: (ctx) => <BlogPost slug={ctx.params.slug} />
});
```

#### Using Helper Functions (Recommended)

For better readability and type safety, use the provided helper functions:

```typescript
// handlers/blog.handlers.tsx
import { map, layout, parallel, middleware, revalidate } from 'rsc-router';
import type { blogRoutes } from '../routes/blog.routes';

export default map<typeof blogRoutes>({
  // Global layouts - apply to all routes
  [layout('*', 'root')]: <RootLayout />,
  [layout('*', 'blog')]: <BlogLayout />,

  // Global middleware
  [middleware('*', 'logger')]: [
    (_ctx, next) => {
      console.log('Blog route accessed');
      next();
    }
  ],

  // Per-route layouts
  [layout('post', 'content')]: <ContentLayout />,

  // Per-route parallel routes
  [parallel('post', 'slots')]: {
    '@sidebar': (ctx) => <PostSidebar slug={ctx.params.slug} />,
    '@comments': (ctx) => <Comments postId={ctx.params.slug} />
  },

  // Revalidation
  [revalidate('post')]: ({ prevParams, nextParams }) =>
    prevParams.slug !== nextParams.slug,

  // Route handlers (both forms supported)
  index: () => <BlogIndex />,                    // Shorthand
  [route('post')]: (ctx) => <BlogPost />,        // Explicit (optional)
});
```

**Note**: The helper functions are purely for convenience and type safety - they generate the same string patterns shown in the basic example.
- `layout('post', 'content')` → `"$layout.post.content"`
- `middleware('*', 'auth')` → `"$middleware.*.auth"`
- `route('index')` → `"index"` (pass-through for consistency)

### Helper Functions

#### `layout(routeName, layoutName)`

Defines a layout for a specific route. Returns a type-safe string pattern `$layout.{routeName}.{layoutName}`.

Layouts can be:
- **ReactNode**: Direct component `<RootLayout />`
- **Handler function**: Sync/async function `(ctx) => <Layout />` or `async (ctx) => <Layout />`

**Important**: Each layout must have a unique name. To define multiple layouts for a route, use separate `layout()` calls with different names. This enables granular revalidation control.

**Special Route Name**: Use `'*'` as the route name to apply a layout to **all routes** in the route definition.

```typescript
// Global layout - applies to ALL routes
[layout('*', 'root')]: <RootLayout />

// Per-route layouts
[layout('index', 'home')]: <HomeLayout />,
[layout('dashboard', 'auth')]: (ctx) => <AuthLayout user={ctx.user} />,

// Handler function (async)
[layout('post', 'data')]: async (ctx) => {
  const data = await fetchData(ctx.params.slug);
  return <DataLayout data={data} />;
}

// Multiple layouts for the same route (separate declarations with unique names)
[layout('admin', 'root')]: <RootLayout />,
[layout('admin', 'auth')]: (ctx) => <AuthLayout user={ctx.user} />,
[layout('admin', 'data')]: async (ctx) => {
  const userData = await fetchUserData(ctx.user.id);
  return <DataLayout data={userData} />;
}

// Example combining global and per-route layouts:
export default map<typeof blogRoutes>({
  // Global layout for all blog routes
  [layout('*', 'root')]: <RootLayout />,
  [layout('*', 'blog')]: <BlogLayout />,

  // Additional layout only for post route
  [layout('post', 'content')]: <ContentLayout />,

  index: () => <BlogIndex />,
  post: (ctx) => <BlogPost slug={ctx.params.slug} />
});
// Result for index: RootLayout → BlogLayout → BlogIndex
// Result for post: RootLayout → BlogLayout → ContentLayout → BlogPost
```

Each layout name acts as a unique identifier for revalidation tracking and segment management.

#### `parallel(routeName, parallelName)`

Defines parallel routes for a specific route. Returns a type-safe string pattern `$parallel.{routeName}.{parallelName}`.

**Special Route Name**: Use `'*'` as the route name to apply parallel routes to **all routes** in the route definition.

```typescript
// Per-route parallel slots
[parallel('dashboard', 'slots')]: {
  '@sidebar': (ctx) => <DashboardSidebar />,
  '@footer': (ctx) => <DashboardFooter />,
  '@modal': (ctx) => <ModalSlot />
}

// Global parallel slots - apply to ALL routes
[parallel('*', 'global')]: {
  '@footer': () => <GlobalFooter />,
  '@toast': () => <ToastContainer />
}
```

#### `middleware(routeName, middlewareName)`

Defines middleware for a specific route. Returns a type-safe string pattern `$middleware.{routeName}.{middlewareName}`.

The `middlewareName` is for organizational purposes only (e.g., 'auth', 'logging', 'tracking') and doesn't affect revalidation.

**Special Route Name**: Use `'*'` as the route name to apply middleware to **all routes** in the route definition.

```typescript
// Global middleware - applies to ALL routes
[middleware('*', 'analytics')]: [
  logger(),
  tracker()
]

// Per-route middleware
[middleware('admin', 'auth')]: [
  (ctx, next) => {
    if (!ctx.user?.isAdmin) {
      throw new Error('Admin access required');
    }
    next();
  }
]

// Multiple middleware functions for the same route (use arrays)
[middleware('api', 'security')]: [
  rateLimiter(),
  authenticator(),
  validator()
]
```

#### `revalidate(routeName)`

Defines revalidation logic for a specific route. Returns a type-safe string pattern `$revalidate.{routeName}`.

```typescript
[revalidate('post')]: ({ prevParams, nextParams }) => {
  // Only revalidate if slug changed
  return prevParams.slug !== nextParams.slug;
}
```

### Type Safety

The pattern-based API provides full type safety:

1. **Route name validation**: TypeScript ensures `routeName` matches defined routes
2. **Parameter types**: Handler context has correctly typed `params` based on route pattern
3. **Autocomplete**: IDE provides autocomplete for route names and params

```typescript
// ✅ Type-safe - 'post' exists in blogRoutes and ctx.params.slug is string
[layout('post', 'blog')]: <BlogLayout />,
post: (ctx) => <div>{ctx.params.slug}</div>

// ❌ Type error - 'invalid' doesn't exist in blogRoutes
[layout('invalid', 'blog')]: <BlogLayout />

// ❌ Type error - 'index' route has no params
index: (ctx) => <div>{ctx.params.slug}</div>
```

## Router Creation API

### Generic Context Type

```typescript
import { createRSCRouter } from "rsc-router";

// Define app-specific context
interface AppContext {
  db: Database;
  user?: User;
  env: Env;
  session: Session;
}

// Create typed router
const router = createRSCRouter<AppContext>();
```

### Route Registration

```typescript
import { blogRoutes } from "./routes/blog.routes";
import { shopRoutes } from "./routes/shop.routes";

router
  .route("/blog", blogRoutes) // Registration ID: 0
  .map(() => import("./handlers/blog.handlers"))

  .route("/shop", shopRoutes) // Registration ID: 1
  .map(() => import("./handlers/shop.handlers"));
```

### Inline Handlers (Eager)

```typescript
import { layout } from 'rsc-router';

router
  .route('/about', aboutRoutes)
  .map({
    [layout('index', 'root')]: <RootLayout />,
    index: () => <AboutPage />
  });
```

## Handler Context API

### Context Shape

```typescript
type HandlerContext<TParams, TAppContext> = {
  params: TParams; // Extracted from route pattern
  request: Request; // Original request
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
} & TAppContext; // App-specific context
```

### Usage in Handlers

```typescript
export default map<typeof blogRoutes>({
  post: (ctx) => {
    // From route pattern
    ctx.params.slug  // string

    // From Request
    ctx.request      // Request
    ctx.pathname     // string
    ctx.url          // URL
    ctx.searchParams // URLSearchParams

    // From AppContext
    ctx.db           // Database
    ctx.user         // User | undefined
    ctx.env          // Env
    ctx.session      // Session

    return <BlogPost />;
  }
});
```

## Router Match API

### Full Render

```typescript
// entry.rsc.tsx
const result = await router.match(request, context);

// Result shape
result = {
  segments: ResolvedSegment[],  // Full segments with components
  matched: string[],             // All segment IDs: ['L0.0', 'L1.0', 'R2.0']
  diff: string[]                 // Same as matched for full render
}
```

### Partial Render

```typescript
// entry.rsc.tsx
// Router extracts previous URL from header
const result = await router.matchPartial(request, context);

// Internally:
// - Reads X-RSC-Router-Client-Path header for previous URL
// - Reads _rsc_segments query param for client segment IDs
// - Compares previous route vs current route
// - Returns only changed segments

// Result shape
result = {
  segments: ResolvedSegment[],  // Only changed segments with components
  matched: string[],             // All segment IDs for new route
  diff: string[]                 // Only rendered segment IDs
}
```

## Segment System

### Segment Structure

```typescript
interface ResolvedSegment {
  id: string; // 'L0.0', 'R2.1', etc.
  type: "layout" | "route";
  index: number; // Position in segment array
  component: ReactNode; // React component
  params?: Record<string, string>;
}
```

### Segment ID Format

```
{Type}{Position}.{RegistrationId}

L0.0  = Layout position 0, registration 0
L1.0  = Layout position 1, registration 0
R2.0  = Route position 2, registration 0
L0.1  = Layout position 0, registration 1
```

### Globally Unique IDs

**Key Decision**: Each `.route()` registration gets unique ID space.

```typescript
router
  .route("/blog", blogRoutes) // IDs: L0.0, L1.0, R2.0
  .map(blogHandlers)
  .route("/shop", shopRoutes) // IDs: L0.1, L1.1, R2.1
  .map(shopHandlers);

// Even if both use RootLayout, they have different IDs
// /blog: L0.0 (RootLayout)
// /shop: L0.1 (RootLayout)
```

## Outlet Component API

### Layout Usage

```typescript
function BlogLayout() {
  return (
    <div>
      <h1>Blog</h1>
      <nav>...</nav>
      <Outlet />  {/* Renders child content */}
    </div>
  );
}
```

### Future: useOutlet Hook

```typescript
function BlogLayout() {
  const outlet = useOutlet();  // ReactNode | null

  return (
    <div>
      <h1>Blog</h1>
      {outlet}  {/* Manual rendering */}
    </div>
  );
}

function BlogPost() {
  const outlet = useOutlet();  // null (leaf node)
  return <article>...</article>;
}
```

**Key Decision**: Every segment wrapped in OutletProvider, regardless of type.

## Partial Rendering Protocol

### Request Format

```typescript
// Full render (initial page load)
GET /blog/hello

// Partial render (navigation)
GET /blog/world?_rsc_partial=true&_rsc_segments=L0.0,L1.0,R2.0
Headers:
  X-RSC-Router-Client-Path: /blog/hello?queries=asd#even-hash

// Server action (form submission)
POST /blog/world?_rsc_partial=true&_rsc_segments=L0.0,L1.0,R2.0
Headers:
  X-RSC-Router-Client-Path: /blog/hello?queries=asd#even-hash
```

### Parameter Definitions

**Query Params:**

- `_rsc_partial=true` - Request partial update
- `_rsc_segments` - Comma-separated segment IDs client already has

**Headers:**

- `X-RSC-Router-Client-Path` - Full current browser URL including query params and hash

**Key Decision**: Previous URL in header (not query param) to avoid URL length limits and preserve full URL with queries/hash.

### Client Navigation Request

```typescript
// entry.browser.tsx
const currentUrl = window.location.href; // Full URL: /blog/hello?queries=asd#hash
const currentSegments = ["L0.0", "L1.0", "R2.0"];

const fetchUrl = new URL("/blog/world", window.location.origin);
fetchUrl.searchParams.set("_rsc_partial", "true");
fetchUrl.searchParams.set("_rsc_segments", currentSegments.join(","));

const payload = await fetch(fetchUrl, {
  headers: {
    "X-RSC-Router-Client-Path": currentUrl, // Full URL with queries & hash
  },
});
```

### Prefetching

```typescript
// Prefetch URL (query params only - no header needed for prefetch)
<link rel="prefetch"
      href="/blog/world?_rsc_partial=true&_rsc_segments=L0.0,L1.0,R2.0" />

// Note: Prefetch doesn't send headers, but that's OK - server can handle
// missing X-RSC-Router-Client-Path by skipping revalidation checks
```

**Key Decision**: Prefetch uses query params only. Server gracefully handles missing header.

## Response Payload API

### Full Render Payload

```typescript
{
  root: ReactNode,           // Full composed tree with OutletProvider wrapping
  metadata: {
    pathname: string,
    segments: SegmentMetadata[]  // Metadata only (no components)
  }
}

// segments metadata shape:
[
  { id: 'L0.0', type: 'layout', index: 0 },
  { id: 'L1.0', type: 'layout', index: 1 },
  { id: 'R2.0', type: 'route', index: 2, params: { slug: 'hello' } }
]
```

**Key Decision**: Duplication of structure (root + segments) accepted for MVP.

### Partial Render Payload

```typescript
{
  root: null,                // No tree - client builds it
  metadata: {
    pathname: string,
    segments: ResolvedSegment[],  // Full segments WITH components
    isPartial: true,
    matched: string[],        // All segment IDs: ['L0.0', 'L1.0', 'R2.0']
    diff: string[]            // Only rendered IDs: ['R2.0']
  }
}

// segments shape (WITH components):
[
  {
    id: 'R2.0',
    type: 'route',
    index: 2,
    component: <BlogPost />,
    params: { slug: 'world' }
  }
]
```

## Revalidation Logic

Revalidation controls when route segments re-render during client-side navigation (partial rendering). Inspired by [React Router's shouldRevalidate](https://reactrouter.com/start/data/route-object#shouldrevalidate).

### When Revalidation Runs

Revalidation **only applies during partial rendering** (SPA navigation):
- ✅ Client has the segment already
- ✅ Same route handler (not navigating to different route)
- ❌ NOT on initial page load (full render always happens)
- ❌ NOT when navigating to different route (full render)
- ❌ NOT for NEW segments (always render regardless of revalidation functions)

### Critical: What Triggers defaultShouldRevalidate?

**`defaultShouldRevalidate = true` when:**
- Route params (:slug, :id, etc.) change
- Example: `/product/shoe-1` → `/product/shoe-2` (id changed)

**`defaultShouldRevalidate = false` when:**
- Only query string changes
- Example: `/product/shoe-1?tab=1` → `/product/shoe-1?tab=2` (id unchanged)
- Only hash changes
- Example: `/product/shoe-1#reviews` → `/product/shoe-1#specs`

**NEW segments ALWAYS render:**
- Bypass revalidation functions entirely
- Revalidation only checks segments client already has

### Default Behavior Examples

#### Route Param Change → defaultShouldRevalidate = TRUE

```typescript
// Navigate /blog/hello → /blog/world
// Route param changes: { slug: 'hello' } → { slug: 'world' }

// For each segment:
// L0.0 (RootLayout): No params → defaultShouldRevalidate = false → Skip
// L1.0 (BlogLayout): No params → defaultShouldRevalidate = false → Skip
// R2.0 (BlogPost): params.slug changed → defaultShouldRevalidate = TRUE → Re-render

// Result: Only R2.0 re-renders
```

#### Query String Change → defaultShouldRevalidate = FALSE

```typescript
// Navigate /blog/hello?tab=1 → /blog/hello?tab=2
// Route params unchanged: { slug: 'hello' } → { slug: 'hello' }
// Only query string changed

// For each segment:
// L0.0 (RootLayout): No params → defaultShouldRevalidate = false → Skip
// L1.0 (BlogLayout): No params → defaultShouldRevalidate = false → Skip
// R2.0 (BlogPost): params.slug UNCHANGED → defaultShouldRevalidate = FALSE → Skip

// Result: Nothing re-renders (optimized!)

// To revalidate on query changes, use custom revalidation:
[revalidate('post')]: ({ currentUrl, nextUrl }) => {
  return currentUrl.search !== nextUrl.search; // Revalidate if query changed
}
```

#### NEW Segment → ALWAYS Renders (No Revalidation Check)

```typescript
// Navigate /dashboard → /dashboard/settings
// Different route within same handler, new segments

// Client has: ['L0.0', 'L1.0', 'R2.0']
// Server returns: ['L0.0', 'L1.0', 'R3.0'] (R3.0 is NEW)

// For each segment:
// L0.0: Client has, no params → Skip
// L1.0: Client has, no params → Skip
// R3.0: Client DOESN'T have → Re-render (bypass revalidation functions)

// NEW segments always render regardless of revalidation functions
```

### Custom Revalidation API

#### Basic Example - Defer to Default

```typescript
import { map, revalidate } from 'rsc-router';

export default map<typeof blogRoutes>({
  // Simple revalidation - defer to default param checking
  [revalidate('post')]: ({ defaultShouldRevalidate }) => {
    console.log('[Blog] Checking if post should revalidate');
    return defaultShouldRevalidate; // true if slug changed
  },

  post: (ctx) => <BlogPost slug={ctx.params.slug} />
});
```

#### Multiple Named Revalidations - Short-Circuit OR

```typescript
export default map<typeof shopRoutes>({
  // Multiple revalidations execute in order, short-circuit on first true
  [revalidate('products.detail', 'auth')]: ({ context }) => {
    // Check 1: Did user login/logout?
    if (context.user?.id !== context.prevUser?.id) {
      console.log('[Shop] User changed - force refresh');
      return true; // Stop here, re-render
    }
    return false; // Continue to next check
  },

  [revalidate('products.detail', 'cache')]: ({ currentUrl, nextUrl }) => {
    // Check 2: Did cache-busting param change?
    if (currentUrl.searchParams.get('v') !== nextUrl.searchParams.get('v')) {
      console.log('[Shop] Version changed - refresh');
      return true; // Stop here, re-render
    }
    return false; // Continue to next check
  },

  [revalidate('products.detail', 'slug')]: ({ currentParams, nextParams }) => {
    // Check 3: Did slug change?
    const changed = currentParams.slug !== nextParams.slug;
    console.log(`[Shop] Slug changed: ${changed}`);
    return changed; // Final check
  },

  'products.detail': (ctx) => <ProductDetail slug={ctx.params.slug} />
});
```

#### Global Revalidation - Applies to All Routes

```typescript
export default map<typeof shopRoutes>({
  // Global revalidation runs for EVERY route in this handler
  [revalidate('*', 'tracking')]: ({ currentUrl, nextUrl }) => {
    console.log('[Shop] Global revalidation hook');
    // Could track analytics, check session, etc.
    return false; // Don't force revalidation
  },

  // Still runs after global for specific routes
  [revalidate('cart')]: () => {
    console.log('[Shop] Cart always refreshes');
    return true; // Always get fresh cart data
  }
});
```

#### Always/Never Revalidate

```typescript
// Always revalidate (ignore params, always fresh)
[revalidate('dashboard')]: () => true;

// Never revalidate (static content, optimize)
[revalidate('about')]: () => false;

// Custom condition (ignore param changes)
[revalidate('post')]: ({ currentUrl, nextUrl }) => {
  // Only revalidate if ?refresh=true query param present
  return nextUrl.searchParams.has('refresh');
};
```

### Execution Order - Soft/Hard Decision Pattern

Revalidations execute with **soft/hard decision pattern**:

**Hard Decision (boolean):**
- Returns `true` or `false`
- **Short-circuits** immediately - stops execution
- Definitive answer - no other revalidators run

**Soft Decision (object):**
- Returns `{ defaultShouldRevalidate: boolean }`
- **Continues** to next revalidator with updated suggestion
- Allows downstream revalidators to override

**Execution Flow:**
```typescript
1. Start with built-in defaultShouldRevalidate (true if params changed)
2. Execute global revalidators ('*') first
3. Then route-specific revalidators
4. Each can make:
   - Hard decision → STOP immediately, use that value
   - Soft decision → UPDATE suggestion, continue
5. If all soft decisions → use final suggestion
```

**Example:**
```typescript
// Global provides default, allows override
[revalidate('*', 'global')]: () => {
  return { defaultShouldRevalidate: true }; // SOFT: suggest yes, but keep checking
}

// Route-specific can override
[revalidate('post')]: ({ currentParams, nextParams }) => {
  return currentParams.slug !== nextParams.slug; // HARD: definitive answer, stop
}
```

### Function Signature

```typescript
type ShouldRevalidateFn = (args: {
  currentParams: GenericParams;     // Previous route params ({ [key: string]: string | undefined })
  currentUrl: URL;                  // Previous URL object
  nextParams: GenericParams;        // Next route params
  nextUrl: URL;                     // Next URL object
  defaultShouldRevalidate: boolean; // Current suggestion (updated by soft decisions)
  context: TContext;                // App context (db, user, etc.)
  // Future action support:
  actionResult?: any;               // Result from server action
  formData?: FormData;              // Form data submitted
  formMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}) => boolean | { defaultShouldRevalidate: boolean }; // Hard or soft decision

// Helper type for stricter params
type RevalidateParams<TParams = GenericParams> = Parameters<ShouldRevalidateFn<TParams>>[0];

// Usage with inline typing:
[revalidate('post')]: ((params: RevalidateParams<{ slug: string }>) => {
  return params.currentParams.slug !== params.nextParams.slug;
})
```

### Real-World Examples

#### Ecommerce Product Page

```typescript
[revalidate('product', 'inventory')]: ({ currentParams, nextParams, context }) => {
  // Same product? Check if inventory changed in context
  if (currentParams.id === nextParams.id) {
    return context.inventoryVersion !== context.prevInventoryVersion;
  }
  // Different product - always revalidate
  return true;
},
```

#### User Dashboard with Auth

```typescript
[revalidate('*', 'auth')]: ({ context }) => {
  // Force revalidation if user session changed
  return context.user?.sessionId !== context.prevUser?.sessionId;
},
```

#### Static Marketing Pages

```typescript
// Never revalidate (content doesn't change)
[revalidate('about')]: () => false,
[revalidate('pricing')]: () => false,
[revalidate('features')]: () => false,
```

## Client-Side Reconstruction

### Full Render (Server Builds)

```typescript
// Server
const segments = await router.match(request, context);
const root = renderSegments(segments.segments); // Build tree
return { root, metadata };

// Client
hydrateRoot(document, payload.root); // Use pre-built tree
```

### Partial Render (Client Builds)

```typescript
// Server
const result = await router.matchPartial(request, context);
return { root: null, metadata: { segments: result.segments, ... } };

// Client
const { segments, matched, diff } = payload.metadata;

// Merge: Keep old segments, replace changed ones
const fullSegments = matched.map(id => {
  if (diff.includes(id)) {
    return segments.find(s => s.id === id);  // New from server
  } else {
    return currentSegments.find(s => s.id === id);  // Keep existing
  }
});

// Build tree on client
const root = renderSegments(fullSegments);
setPayload({ root, metadata: payload.metadata });
```

**Key Decision**: Server renders tree for full, client reconstructs for partial.

## Example: Complete Flow

### 1. Define Routes

```typescript
// routes/blog.routes.ts
export const blogRoutes = route({
  index: "/",
  post: "/:slug",
});

// Mount at /blog in router
router.route('/blog', blogRoutes).map(() => import('./blog.handlers.js'));
```

### 2. Define Handlers

```typescript
// handlers/blog.handlers.tsx
import { map, layout } from 'rsc-router';

export default map<typeof blogRoutes>({
  [layout('index', 'root')]: <RootLayout />,
  [layout('index', 'blog')]: <BlogLayout />,
  [layout('post', 'root')]: <RootLayout />,
  [layout('post', 'blog')]: <BlogLayout />,

  index: (ctx) => <BlogIndex />,
  post: (ctx) => <BlogPost slug={ctx.params.slug} />
});
```

### 3. Register Routes

```typescript
// router.ts
const router = createRSCRouter<AppContext>();

router.route("/blog", blogRoutes).map(() => import("./handlers/blog.handlers"));
```

### 4. Match Requests

```typescript
// entry.rsc.tsx
export function createRSCHandler(router: RSCRouter) {
  return async (request: Request) => {
    const context: AppContext = {
      db: getDb(),
      user: await getUser(request),
      env: getEnv(),
      session: await getSession(request),
    };

    const url = new URL(request.url);
    const isPartial = url.searchParams.has("_rsc_partial");

    if (isPartial) {
      const result = await router.matchPartial(request, context);
      return {
        root: null,
        metadata: {
          pathname: url.pathname,
          segments: result.segments,
          isPartial: true,
          matched: result.matched,
          diff: result.diff,
        },
      };
    } else {
      const result = await router.match(request, context);
      const root = renderSegments(result.segments);
      return {
        root,
        metadata: {
          pathname: url.pathname,
          segments: result.segments.map((s) => ({
            id: s.id,
            type: s.type,
            index: s.index,
            params: s.params,
          })),
        },
      };
    }
  };
}
```

## Key Technical Decisions

1. **Generic Context Type**: `createRSCRouter<TAppContext>()` for type-safe context flow
2. **Separate Routes from Handlers**: Type-only imports, lazy handler execution
3. **Globally Unique Segment IDs**: `{Type}{Position}.{RegistrationId}` format
4. **Pattern-Based Metadata Keys**: Helper functions (`layout()`, `parallel()`, `middleware()`, `revalidate()`) generate type-safe string patterns for explicit metadata association
5. **Per-Route Metadata**: All metadata (layouts, parallel routes, middleware) is explicitly defined per route
6. **Previous URL in Header**: `X-RSC-Router-Client-Path` header (not query param) to avoid URL length limits
7. **Segments in Query Param**: `_rsc_segments` query param for CDN caching and prefetching
8. **Client Tracks Segment IDs**: Explicit state vs pathname diffing
9. **Server Builds Full Tree**: Client builds partial tree from merged segments
10. **Universal OutletProvider Wrapping**: All segments wrapped regardless of type
11. **Parallel Routes as Siblings**: Route + parallel segments rendered as siblings (Fragment), not nested
12. **Prefetch Graceful Degradation**: Prefetch works without header, server skips revalidation checks
13. **Payload Duplication in Full Render**: root + segments metadata (optimize post-MVP)
14. **Params-Based Revalidation**: Default re-render when params change

## Parallel Routes

### Basic Usage

```typescript
import { map, layout, parallel } from 'rsc-router';

export default map<typeof routes>({
  [layout('dashboard', 'main')]: <DashboardLayout />,

  // Parallel routes render as siblings to main route
  [parallel('dashboard', 'slots')]: {
    '@sidebar': (ctx) => <Sidebar />,
    '@analytics': (ctx) => <Analytics />
  },

  dashboard: (ctx) => <DashboardMain />
});
```

**Rendered structure:**

```tsx
<DashboardLayout>
  <Outlet /> {/* Renders: */}
  {/* <><DashboardMain /><Sidebar /><Analytics /></> */}
</DashboardLayout>
```

### Per-Route Parallel Slots

```typescript
import { map, parallel } from 'rsc-router';

export default map<typeof routes>({
  // Parallel slots for index route
  [parallel('index', 'slots')]: {
    '@footer': (ctx) => <Footer />,
    '@sidebar': (ctx) => <IndexSidebar />
  },
  index: (ctx) => <Index />,

  // Parallel slots for post route
  [parallel('post', 'slots')]: {
    '@footer': (ctx) => <Footer />,
    '@sidebar': (ctx) => <PostSidebar slug={ctx.params.slug} />,
    '@comments': (ctx) => <Comments postId={ctx.params.slug} />
  },
  post: (ctx) => <Post slug={ctx.params.slug} />
});
```

**Result for post route:**

- Parallel slots: `@footer`, `@sidebar`, `@comments`
- All render as siblings: `<><Post /><Footer /><PostSidebar /><Comments /></>`

### Segment IDs for Parallel Routes

```
L0.0 - Layout
R1.0 - Main route
P2.0 - @footer (global parallel)
P3.0 - @sidebar (per-route parallel)
P4.0 - @comments (per-route parallel)
```

Parallel segments participate fully in partial rendering and revalidation.

## Middleware

Middleware functions execute **before route handlers and layouts**, allowing you to:
- Authenticate/authorize requests
- Modify context (add user, permissions, etc.)
- Log requests and track analytics
- Rate limit or throttle requests
- Short-circuit execution (throw errors, redirect)

### Execution Flow

```
Request → Middleware Chain → Handlers (layouts + route + parallel)
         ↓ (can modify ctx)
         ↓ (can throw/stop)
```

Middleware executes:
- ✅ Before any handlers (layouts, routes, parallel)
- ✅ On both full and partial renders
- ✅ Once per request (not per segment)
- ✅ Can modify context passed to all handlers

###Execution Order

**Chaining with Global + Per-Route:**

```typescript
export default map<typeof shopRoutes>({
  // 1. Global middleware (runs for ALL routes)
  [middleware('*', 'logger')]: [
    (ctx, next) => {
      console.log(`Request: ${ctx.pathname}`);
      next(); // Call next to continue chain
    }
  ],

  [middleware('*', 'auth')]: [
    (ctx, next) => {
      ctx.user = await authenticate(ctx.request);
      next();
    }
  ],

  // 2. Per-route middleware (runs only for specific route)
  [middleware('checkout', 'validate')]: [
    (ctx, next) => {
      if (!ctx.user) throw new Error('Unauthorized');
      next();
    }
  ],

  // Handlers execute AFTER all middleware
  checkout: (ctx) => <Checkout user={ctx.user} />
});
```

**Order**: Global middleware (in definition order) → Per-route middleware (in definition order) → Handlers

### Context Modification

Middleware can modify the context object, and changes flow to all handlers:

```typescript
[middleware('*', 'auth')]: [
  async (ctx: any, next) => {
    // Add user to context
    const token = ctx.request.headers.get('Authorization');
    ctx.user = await validateToken(token);
    ctx.permissions = await getPermissions(ctx.user.id);

    console.log(`Authenticated: ${ctx.user.name}`);
    next();
  }
],

// Handler receives modified context
"account": (ctx: any) => {
  // ctx.user is available!
  return <div>Welcome, {ctx.user.name}!</div>;
}
```

### Multiple Middleware (Chaining)

```typescript
[middleware('api', 'security')]: [
  // 1. Rate limiting (runs first)
  async (ctx: any, next) => {
    const remaining = await checkRateLimit(ctx.request);
    if (remaining === 0) {
      throw new Error('Rate limit exceeded');
    }
    ctx.rateLimitRemaining = remaining;
    next();
  },

  // 2. Authentication (runs second)
  async (ctx: any, next) => {
    ctx.user = await authenticate(ctx.request);
    if (!ctx.user) {
      throw new Error('Unauthorized');
    }
    next();
  },

  // 3. Authorization (runs third)
  async (ctx: any, next) => {
    const canAccess = await checkPermissions(ctx.user, 'api');
    if (!canAccess) {
      throw new Error('Forbidden');
    }
    next();
  }
]
```

**All middleware must call `next()` for the chain to continue.**

### Short-Circuit (Stop Execution)

**Option 1: Throw Error**
```typescript
[middleware('admin', 'auth')]: [
  (ctx: any, next) => {
    if (!ctx.user?.isAdmin) {
      throw new Error('Unauthorized'); // Stops execution
    }
    next();
  }
]
```

**Option 2: Don't Call next()**
```typescript
[middleware('maintenance', 'check')]: [
  (ctx: any, next) => {
    if (isMaintenanceMode()) {
      // Don't call next() - stops chain
      return;
    }
    next();
  }
]
```

### Global Middleware

Use `'*'` to apply middleware to all routes:

```typescript
export default map<typeof shopRoutes>({
  // Runs for every shop route
  [middleware('*', 'logger')]: [
    (ctx, next) => {
      console.log(`Shop route accessed: ${ctx.pathname}`);
      next();
    }
  ],

  // Runs for every shop route
  [middleware('*', 'auth')]: [
    async (ctx: any, next) => {
      ctx.user = await getCurrentUser(ctx.request);
      next();
    }
  ],

  // All routes get logger → auth → handler
  index: (ctx: any) => <ProductList user={ctx.user} />,
  cart: (ctx: any) => <Cart user={ctx.user} />
});
```

### Real-World Examples

#### Authentication with Context Modification

```typescript
[middleware('*', 'auth')]: [
  async (ctx: any, next) => {
    const sessionId = ctx.request.headers.get('Cookie')
      ?.match(/session=([^;]+)/)?.[1];

    if (sessionId) {
      ctx.user = await db.getUserBySession(sessionId);
      ctx.permissions = await db.getPermissions(ctx.user.id);
    }

    next();
  }
],

// Protected routes
[middleware('account', 'requireAuth')]: [
  (ctx: any, next) => {
    if (!ctx.user) {
      throw new Error('Please login');
    }
    next();
  }
]
```

#### Rate Limiting

```typescript
const requestCounts = new Map();

[middleware('*', 'rateLimit')]: [
  (ctx: any, next) => {
    const ip = ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
    const count = requestCounts.get(ip) || 0;

    if (count > 100) {
      throw new Error('Rate limit exceeded');
    }

    requestCounts.set(ip, count + 1);
    ctx.rateLimitRemaining = 100 - count;

    next();
  }
]
```

#### Logging & Analytics

```typescript
[middleware('*', 'analytics')]: [
  async (ctx, next) => {
    const startTime = Date.now();

    await next(); // Execute rest of chain

    const duration = Date.now() - startTime;
    console.log(`${ctx.pathname} - ${duration}ms`);

    // Send to analytics service
    await trackPageView(ctx.pathname, duration);
  }
]
```

## Loading & Error Boundaries (Future)

```typescript
import { map, loading, error } from 'rsc-router';

export default map<typeof routes>({
  [loading('post')]: <PostLoading />,
  [error('post')]: <PostError />,
  post: (ctx) => <BlogPost />
});
```
