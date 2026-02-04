# Route Composition Research

Exploring ways to make rsc-router more composable beyond the current `route()` + `map()` pattern.

## Current Pattern

```typescript
// 1. Define routes (paths only)
export const shopRoutes = route({
  products: "/products",
  product: "/product/:slug",
  cart: "/cart",
});

// 2. Map handlers separately
export default map<typeof shopRoutes>(
  ({ route, layout, loader, middleware }) => [
    layout(<ShopLayout />),
    middleware(authMiddleware),

    route("products", <ProductsPage />, () => [
      loader(ProductsLoader),
    ]),

    route("product", <ProductPage />, () => [
      loader(ProductLoader),
    ]),
  ]
);
```

## Current Limitations

### 1. Tight Coupling of Routes + Handlers
The `map()` is bound to a specific `typeof routes`. Can't easily:
- Share handler configurations across different route trees
- Create reusable "route fragments"
- Compose routes from multiple sources

### 2. No Reusable Patterns
Common combinations must be repeated:

```typescript
// This pattern repeats everywhere
route("someRoute", Handler, () => [
  middleware(authMiddleware),
  middleware(loggingMiddleware),
  loader(SomeLoader),
  revalidate(standardRevalidation),
]);
```

### 3. Hard to Create Feature Modules
A "comments" feature that works on any route requires manual wiring each time.

### 4. Monolithic Handler Files
All handlers for a route tree live in one `map()`. Can't split by feature.

---

## Use Cases for Better Composition

### Use Case 1: Shared Middleware Stacks

**Goal:** Define once, apply to many routes

```typescript
// Current: repeat everywhere
route("admin.users", UsersPage, () => [
  middleware(authMiddleware),
  middleware(adminOnlyMiddleware),
  middleware(loggingMiddleware),
]);

route("admin.settings", SettingsPage, () => [
  middleware(authMiddleware),
  middleware(adminOnlyMiddleware),
  middleware(loggingMiddleware),
]);

// Desired: compose stacks
const adminStack = compose(
  middleware(authMiddleware),
  middleware(adminOnlyMiddleware),
  middleware(loggingMiddleware),
);

route("admin.users", UsersPage, () => [adminStack]);
route("admin.settings", SettingsPage, () => [adminStack]);
```

### Use Case 2: Feature Modules

**Goal:** Self-contained features that attach to any route

```typescript
// A "comments" feature module
const commentsFeature = defineFeature(({ parallel, loader }) => ({
  // Adds a parallel route for comments
  parallel: {
    "@comments": CommentsPanel,
  },
  loaders: [CommentsLoader],
  // Optional: adds child routes
  routes: {
    "comments/:id": CommentDetail,
  },
}));

// Attach to any route
route("blog.post", BlogPost, () => [
  loader(PostLoader),
  use(commentsFeature),  // Adds @comments parallel + loader
]);

route("product", ProductPage, () => [
  loader(ProductLoader),
  use(commentsFeature),  // Same feature, different context
]);
```

### Use Case 3: Route Fragments / Partials

**Goal:** Define partial route trees that can be merged

```typescript
// Shared CRUD routes pattern
const crudRoutes = <T extends string>(resource: T) => ({
  [`${resource}`]: `/${resource}`,
  [`${resource}.create`]: `/${resource}/new`,
  [`${resource}.edit`]: `/${resource}/:id/edit`,
  [`${resource}.detail`]: `/${resource}/:id`,
});

// Compose into main routes
const routes = route({
  ...crudRoutes("users"),
  ...crudRoutes("products"),
  dashboard: "/dashboard",
});

// Handler fragment
const crudHandlers = <T extends string>(
  resource: T,
  handlers: { List, Create, Edit, Detail }
) => (helpers) => [
  helpers.route(`${resource}`, handlers.List),
  helpers.route(`${resource}.create`, handlers.Create),
  helpers.route(`${resource}.edit`, handlers.Edit),
  helpers.route(`${resource}.detail`, handlers.Detail),
];
```

### Use Case 4: Plugin System

**Goal:** Third-party packages can provide routes

```typescript
// @my-org/auth-routes package
export const authPlugin = definePlugin({
  routes: {
    "auth.login": "/login",
    "auth.logout": "/logout",
    "auth.callback": "/auth/callback",
  },
  handlers: ({ route }) => [
    route("auth.login", LoginPage),
    route("auth.logout", LogoutHandler),
    route("auth.callback", OAuthCallback),
  ],
});

// Main app
const router = createRouter()
  .use(authPlugin)  // Adds routes + handlers
  .routes(appRoutes)
  .map(appHandlers);
```

### Use Case 5: Conditional Routes

**Goal:** Include/exclude routes based on config

```typescript
const router = createRouter()
  .routes(baseRoutes)
  .map(baseHandlers)
  .when(config.enableBeta, (r) =>
    r.routes(betaRoutes).map(betaHandlers)
  )
  .when(config.enableAdmin, (r) =>
    r.routes("/admin", adminRoutes).map(adminHandlers)
  );
```

### Use Case 6: Layout Regions / Slots

**Goal:** Layouts define named regions, routes fill them

```typescript
// Layout defines slots
const DashboardLayout = () => (
  <div className="dashboard">
    <Slot name="sidebar" fallback={<DefaultSidebar />} />
    <main>
      <Outlet />
    </main>
    <Slot name="inspector" />
  </div>
);

// Routes can fill slots
route("dashboard.users", UsersPage, () => [
  slot("sidebar", <UsersSidebar />),
  slot("inspector", <UserInspector />),
]);
```

---

## Potential API Designs

### Design A: Composable Items

Make route items first-class composable values:

```typescript
// Items are standalone, not callbacks
const authMiddlewares = [
  middleware(authMiddleware),
  middleware(loggingMiddleware),
];

const withAuth = compose(...authMiddlewares);

// Use in map
map<typeof routes>(({ route, layout }) => [
  layout(<AppLayout />),

  route("public", PublicPage),

  // Spread composed items
  ...withAuth([
    route("dashboard", DashboardPage),
    route("settings", SettingsPage),
  ]),
]);
```

### Design B: Route Decorators

Higher-order functions that wrap routes:

```typescript
const withAuth = (routeConfig) => ({
  ...routeConfig,
  middleware: [authMiddleware, ...routeConfig.middleware],
});

const withCache = (ttl: number) => (routeConfig) => ({
  ...routeConfig,
  cache: { ttl },
});

// Compose decorators
const protectedCached = compose(withAuth, withCache(300));

map<typeof routes>(({ route }) => [
  route("products", protectedCached({
    handler: ProductsPage,
    loader: ProductsLoader,
  })),
]);
```

### Design C: Builder Pattern per Route

Each route gets its own builder:

```typescript
map<typeof routes>((r) => [
  r.layout(<AppLayout />),

  r.route("products")
    .middleware(authMiddleware)
    .loader(ProductsLoader)
    .revalidate(onParamChange)
    .handler(<ProductsPage />),

  r.route("product")
    .use(productFeature)  // Apply feature module
    .handler(<ProductPage />),
]);
```

### Design D: Declarative Object Config

Replace callbacks with plain objects:

```typescript
const handlers: RouteHandlers<typeof routes> = {
  layouts: [
    { component: <AppLayout /> },
    { component: <ShopLayout />, scope: ["products", "product"] },
  ],

  routes: {
    products: {
      handler: <ProductsPage />,
      loader: ProductsLoader,
      middleware: [authMiddleware],
    },
    product: {
      handler: <ProductPage />,
      loader: ProductLoader,
      features: [commentsFeature],
    },
  },
};

export default handlers;
```

### Design E: Nested Routers (Nested `map()`)

Allow `map()` results to be composed:

```typescript
// Feature map
const shopHandlers = map<typeof shopRoutes>(({ route, layout }) => [
  layout(<ShopLayout />),
  route("products", ProductsPage),
  route("cart", CartPage),
]);

// Admin map
const adminHandlers = map<typeof adminRoutes>(({ route }) => [
  route("users", UsersPage),
  route("settings", SettingsPage),
]);

// Compose maps
const router = createRouter()
  .mount("/", shopRoutes, shopHandlers)
  .mount("/admin", adminRoutes, adminHandlers, {
    middleware: [adminAuthMiddleware],  // Applies to all admin routes
  });
```

---

## Comparison Matrix

| Design | Reusable Patterns | Feature Modules | Type Safety | Migration Effort |
|--------|-------------------|-----------------|-------------|------------------|
| A: Composable Items | ✅ Good | ⚠️ Partial | ✅ Good | Low |
| B: Route Decorators | ✅ Good | ⚠️ Partial | ⚠️ Complex | Medium |
| C: Builder per Route | ✅ Excellent | ✅ Good | ✅ Good | Medium |
| D: Declarative Object | ⚠️ Limited | ✅ Good | ✅ Excellent | High |
| E: Nested Routers | ✅ Good | ✅ Excellent | ✅ Good | Medium |

---

## Core Principle: Discoverability First

**The #1 goal is making it easy to find what renders when and where.**

If you can't grep `"products"` and immediately find the component that renders, the abstraction has failed.

### Rules

1. **`route(name, Handler)` must always show the Handler inline** - never wrapped, never hidden
2. **Composition is additive** - adds behavior to segments, doesn't replace them
3. **`use()` augments, never wraps** - receives segment context, returns additions

### What's Greppable

```typescript
// GOOD: grep "products" → find <ProductsPage />
route("products", <ProductsPage />, () => [
  use(withComments),
  loader(ProductsLoader),
]);

// BAD: grep "products" → find... what?
route("products", withFeatures(ProductsPage))
use(shopFeature)  // handler hidden inside
```

---

## Recommended API: `use()` Pattern

### How It Works

`use()` receives context about the segment it's applied to and returns additions:

```typescript
const withComments = defineUse((segment) => {
  // segment provides context:
  // { type: 'route' | 'layout' | 'parallel', name: string, params: string[] }

  return {
    // Can add any of these:
    middleware: [commentsAuthMiddleware],
    loaders: [CommentsLoader],
    parallel: {
      "@comments": <CommentsPanel />,
    },
    intercept: {
      "@modal": { route: "comment", handler: <CommentModal /> },
    },
    revalidate: [commentRevalidation],
    cache: { ttl: 300 },  // Future
  };
});
```

### Usage - Handler Always Visible

```typescript
map<typeof routes>(({ route, layout, use }) => [
  layout(<AppLayout />),

  // Handler is RIGHT HERE - easy to find
  route("blog.post", <BlogPost />, () => [
    loader(PostLoader),
    use(withComments),  // Adds @comments parallel + loader
  ]),

  // Same feature, different route - still greppable
  route("product", <ProductPage />, () => [
    loader(ProductLoader),
    use(withComments),
  ]),
]);
```

### Segment-Aware Features

Features can behave differently based on segment type:

```typescript
const withAnalytics = defineUse((segment) => {
  if (segment.type === 'layout') {
    // For layouts: add page view tracking
    return {
      middleware: [pageViewMiddleware],
    };
  }

  if (segment.type === 'route') {
    // For routes: add specific event tracking
    return {
      middleware: [routeEventMiddleware(segment.name)],
      loaders: [AnalyticsLoader],
    };
  }

  return {};
});
```

### Composing Multiple `use()` Calls

```typescript
// Simple - just call use() multiple times
route("admin.users", <UsersPage />, () => [
  use(withAuth),
  use(withAnalytics),
  use(withComments),
  loader(UsersLoader),
]);

// Or compose them if you have a common pattern
const adminFeatures = composeUse(withAuth, withAnalytics, withAuditLog);

route("admin.users", <UsersPage />, () => [
  use(adminFeatures),
  loader(UsersLoader),
]);
```

### What `use()` Can Return

```typescript
interface UseResult {
  // Execution pipeline
  middleware?: MiddlewareFn[];
  loaders?: LoaderDefinition[];
  revalidate?: RevalidateFn[];

  // Parallel content
  parallel?: Record<`@${string}`, ReactNode | Handler>;

  // Intercepts for soft navigation
  intercept?: Record<`@${string}`, {
    route: string;
    handler: ReactNode | Handler;
    loaders?: LoaderDefinition[];
  }>;

  // Handler modifications
  wrap?: (handler: ReactNode) => ReactNode;  // Wrap the handler
  replace?: ReactNode;                        // Replace entirely (rare)

  // Future: caching
  cache?: {
    ttl?: number;
    condition?: (ctx: CacheContext) => boolean;
    tags?: string[] | ((ctx: CacheContext) => string[]);
  };
}
```

### Handler Wrapping

`use()` can wrap or even replace the handler - but the **original is still visible** at the `route()` call:

```typescript
const withErrorBoundary = defineUse(() => ({
  wrap: (handler) => (
    <ErrorBoundary fallback={<ErrorFallback />}>
      {handler}
    </ErrorBoundary>
  ),
}));

const withProviders = defineUse((segment) => ({
  wrap: (handler) => (
    <ThemeProvider>
      <FeatureFlagsProvider>
        {handler}
      </FeatureFlagsProvider>
    </ThemeProvider>
  ),
}));

// Original handler is RIGHT HERE - grep "ProductsPage" finds it
// Wrapping is explicit via use() calls
route("products", <ProductsPage />, () => [
  use(withErrorBoundary),
  use(withProviders),
  loader(ProductsLoader),
]);
```

**Why this works:**
- Grep `"ProductsPage"` → finds it immediately
- The wrapping is explicit: you see `use(withErrorBoundary)`
- No hidden HOC magic: `withFeatures(ProductsPage)` hides the wrapper name

### Conditional Handler Replacement

For advanced cases, `use()` can conditionally replace the handler entirely:

```typescript
const withABTest = defineUse((segment, ctx) => {
  // ctx could provide request info, feature flags, etc.
  if (ctx.featureFlags.newCheckout && segment.name === 'checkout') {
    return {
      replace: <NewCheckoutPage />,  // Swap the handler
    };
  }
  return {};  // Keep original
});

// Original handler visible - replacement is explicit via use()
route("checkout", <CheckoutPage />, () => [
  use(withABTest),
]);
```

**When to use `replace`:**
- A/B testing different implementations
- Feature flag rollouts
- Gradual migrations

**The rule still holds:** the `route()` call shows the default/original handler. Replacements are explicit via `use()`.

---

## Examples

### Auth + Admin Stack

```typescript
const withAuth = defineUse(() => ({
  middleware: [authMiddleware, sessionMiddleware],
}));

const withAdmin = defineUse((segment) => ({
  middleware: [adminOnlyMiddleware],
  loaders: [AdminContextLoader],
}));

// Usage
route("admin.dashboard", <AdminDashboard />, () => [
  use(withAuth),
  use(withAdmin),
]);
```

### Comments Feature (Parallel + Loader)

```typescript
const withComments = defineUse((segment) => ({
  parallel: {
    "@comments": <CommentsPanel resourceType={segment.name} />,
  },
  loaders: [CommentsLoader],
  intercept: {
    "@modal": {
      route: "comment.edit",
      handler: <EditCommentModal />,
    },
  },
}));

// Grep "blog.post" → find <BlogPost />
// Comments panel is clearly an addition via use()
route("blog.post", <BlogPost />, () => [
  use(withComments),
]);
```

### Cached Public Routes

```typescript
const withPublicCache = defineUse(() => ({
  cache: {
    ttl: 300,
    condition: (ctx) => !ctx.request.headers.get('cookie'),
  },
}));

route("products", <ProductsPage />, () => [
  use(withPublicCache),
  loader(ProductsLoader),
]);
```

---

## Open Questions

1. **How do features access parent context?**
   - Do they inherit params from parent route?
   - Can they declare dependencies on parent loaders?

2. **Type inference across compositions?**
   - How to maintain href type safety when routes are spread/merged?
   - Can we infer feature slot requirements?

3. **Lazy loading composed handlers?**
   - Can feature modules be code-split?
   - What about composed middleware?

4. **Testing composed routes?**
   - How to unit test a feature module in isolation?
   - Can we mount partial route trees for testing?

---

## Next Steps

1. Prototype `compose()` helper for middleware/loader stacks
2. Design `defineFeature()` API
3. Explore `mount()` API for nested handlers
4. Test type inference with composed routes
