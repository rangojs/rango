# Composable Router Modules

Design exploration for third-party module composition (CMS, Shop, etc.)

## Current Composability

The router already supports composition through:
- Routes as plain objects (can be merged/spread)
- Handlers return arrays (can spread module routes inline)
- Layouts can be abstracted (`...CommonLayouts()`)

## Module Interface

Standard export shape for router modules:

```typescript
interface RouterModule<TRoutes extends RouteDefinition> {
  routes: TRoutes;
  handlers: (ctx: MapContext<TRoutes>) => BuilderItem[];
  // Optional
  layouts?: () => BuilderItem[];
  middleware?: MiddlewareSpec[];
}
```

## Example: CMS Module

```typescript
// @acme/cms-module/routes.ts
export const cmsRoutes = route({
  posts: "/posts",
  post: "/posts/:slug",
  pages: "/pages",
  page: "/pages/:slug",
  media: "/media",
});

// @acme/cms-module/handlers.ts
export const cmsHandlers = ({ route, layout, middleware }) => [
  layout(<CMSLayout />, () => [
    middleware(...cmsAuthMiddleware),
    route("posts", PostsListPage),
    route("post", PostEditorPage),
    route("pages", PagesListPage),
    route("page", PageEditorPage),
    route("media", MediaLibrary),
  ]),
];

// @acme/cms-module/index.ts
export const cmsModule: RouterModule<typeof cmsRoutes> = {
  routes: cmsRoutes,
  handlers: cmsHandlers,
};
```

## Example: Shop Module

```typescript
// @acme/shop-module/routes.ts
export const shopRoutes = route({
  products: "/products",
  product: "/products/:slug",
  cart: "/cart",
  checkout: "/checkout",
});

// @acme/shop-module/handlers.ts
export const shopHandlers = ({ route, layout, parallel }) => [
  layout(<ShopLayout />, () => [
    route("products", ProductsPage),
    route("product", ProductPage, () => [
      parallel({ "@related": RelatedProducts }),
    ]),
    route("cart", CartPage),
    route("checkout", CheckoutPage),
  ]),
];
```

## App Integration

### Routes Composition

```typescript
// app/routes.ts
import { cmsModule } from "@acme/cms-module";
import { shopModule } from "@acme/shop-module";

export const appRoutes = route({
  index: "/",
  admin: {
    ...prefixRoutes(cmsModule.routes, "/admin"),
  },
  shop: {
    ...prefixRoutes(shopModule.routes, "/shop"),
  },
  about: "/about",
});
```

### Handlers Composition

```typescript
// app/handlers/main.tsx
import { cmsModule } from "@acme/cms-module";
import { shopModule } from "@acme/shop-module";

export default map<typeof appRoutes>(
  (ctx) => [
    layout(<RootLayout />),

    route("index", HomePage),
    route("about", AboutPage),

    // Mount CMS under admin shell
    layout(<AdminShell />, () => [
      ...cmsModule.handlers(ctx),
    ]),

    // Mount shop at top level
    ...shopModule.handlers(ctx),
  ]
);
```

## Required Utilities

### 1. prefixRoutes

Remaps all paths in a route definition:

```typescript
function prefixRoutes<T extends RouteDefinition>(
  routes: T,
  prefix: string
): T {
  // Recursively prefix all path values
  // "/posts" -> "/admin/posts"
}

// Usage
prefixRoutes(cmsRoutes, "/admin")
// { posts: "/admin/posts", post: "/admin/posts/:slug", ... }
```

### 2. mount (optional sugar)

Combines prefix + handler spread:

```typescript
function mount<T>(
  prefix: string,
  module: RouterModule<T>
): {
  routes: T;  // Prefixed
  handlers: (ctx: MapContext<T>) => BuilderItem[];
}

// Usage in routes.ts
export const appRoutes = route({
  index: "/",
  ...mount("/admin", cmsModule).routes,
});

// Usage in handlers
map((ctx) => [
  ...mount("/admin", cmsModule).handlers(ctx),
])
```

### 3. mergeRoutes

Type-safe merge of multiple route objects:

```typescript
function mergeRoutes<A, B>(a: A, b: B): A & B {
  return { ...a, ...b };
}

// With namespace
function mergeRoutes<A, B>(
  a: A,
  b: B,
  namespace?: { a?: string; b?: string }
): { [namespace.a]: A } & { [namespace.b]: B }
```

## Module Configuration

Modules may need app-specific configuration:

```typescript
// Module with config
export function createCmsModule(config: {
  basePath?: string;
  enableMedia?: boolean;
  authMiddleware?: MiddlewareSpec;
}): RouterModule<typeof cmsRoutes> {
  return {
    routes: config.basePath
      ? prefixRoutes(cmsRoutes, config.basePath)
      : cmsRoutes,
    handlers: ({ route, layout, middleware }) => [
      layout(<CMSLayout />, () => [
        config.authMiddleware && middleware(...config.authMiddleware),
        route("posts", PostsListPage),
        config.enableMedia && route("media", MediaLibrary),
      ].filter(Boolean)),
    ],
  };
}

// Usage
const cms = createCmsModule({
  basePath: "/admin",
  enableMedia: true,
  authMiddleware: requireAdmin,
});
```

## Type Safety Considerations

The challenge is maintaining type safety when:
1. Prefixing routes (path types change)
2. Merging route objects (union of keys)
3. Passing context to module handlers (generic inference)

```typescript
// The ctx passed to module handlers must match the module's route type
// NOT the app's combined route type

// This works because handlers are generic over their own routes
cmsModule.handlers(ctx)  // ctx is MapContext<typeof cmsRoutes>
```

## Open Questions

1. **How do modules declare dependencies?** (e.g., CMS needs auth system)
2. **How do modules share state?** (e.g., cart count in header)
3. **How do modules extend each other?** (e.g., shop reviews in CMS)
4. **Naming conflicts** - what if two modules use "index" route name?
5. **Layout inheritance** - should modules be able to declare "must be wrapped by X"?

## Next Steps

1. Implement `prefixRoutes` utility
2. Define `RouterModule` interface in types
3. Create example modules to test the pattern
4. Document conventions for module authors
