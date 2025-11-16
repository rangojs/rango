# Future API Ideas for RSC Router

This document captures future API enhancements and design explorations for the RSC Router framework.

---

## 🔄 Loader API - Server-Side Data Loading

### Concept

A `loader()` helper for declarative, type-safe server-side data loading that keeps data on the server (NOT serialized to client).

### Key Characteristics

- **Server-only**: Data stays on server, only processed results sent to client
- **Singleton pattern**: Loaders defined as constants, loaded once, reused multiple times
- **Type inference**: TypeScript automatically infers loader data types
- **Composable**: Mix and match loaders across routes and layouts
- **Execution order**: Runs AFTER middleware, BEFORE route handlers
- **Deduplication**: Same loader instance = single execution, cached result

### Comparison with Parallel Routes

| Feature | `loader()` | `parallel()` |
|---------|-----------|--------------|
| **Data location** | Server-only | Serialized to client |
| **Purpose** | Fetch and process data | Render UI slots |
| **Output** | Data objects | React components (RSC) |
| **Use case** | Database queries, APIs | Sidebars, widgets, UI |

### Basic Usage

```typescript
import { map, loader } from "rsc-router";

// Define loaders as reusable constants
const shopLoaders = loader({
  products: async () => {
    return await db.products.findMany();
  },
  categories: async () => {
    return await db.categories.findMany();
  }
});

const userLoaders = loader({
  user: async (ctx) => {
    const session = ctx.get('session');
    return await getUser(session);
  }
});

// Use in route handlers
export default map<typeof shopRoutes>(({ route, layout }) => [
  layout(<ShopLayout />, () => [
    shopLoaders,  // ✅ Type: Loader<{ products: Product[], categories: Category[] }>

    route('index', (ctx) => {
      // ✅ TypeScript knows these types from shopLoaders!
      const products = ctx.loader.get('products');       // Product[]
      const categories = ctx.loader.get('categories');   // Category[]

      // Filter/process on server, only send needed data to client
      const featured = products.filter(p => p.featured).slice(0, 10);

      return <FeaturedProducts products={featured} />;
    }),

    route('search', (ctx) => {
      // ✅ Same loaders, same types, data already loaded!
      const products = ctx.loader.get('products');
      const query = ctx.searchParams.get('q');

      const results = products.filter(p =>
        p.name.includes(query) || p.description.includes(query)
      );

      return <SearchResults results={results} />;
    })
  ])
]);
```

### Composing Multiple Loaders

```typescript
layout(<AccountLayout />, () => [
  shopLoaders,   // Reuse shop data
  userLoaders,   // Add user data

  route('account.orders', (ctx) => {
    // ✅ Access to ALL loader data
    const user = ctx.loader.get('user');           // User
    const products = ctx.loader.get('products');   // Product[]

    const userOrders = await db.orders.findMany({
      where: { userId: user.id }
    });

    return <OrderHistory orders={userOrders} products={products} />;
  })
])
```

### Security Benefits

```typescript
const authLoaders = loader({
  user: async (ctx) => {
    // Load FULL user data including sensitive fields
    return await db.user.findUnique({
      where: { id: ctx.get('userId') },
      include: {
        password: true,      // ← Stays on server!
        creditCards: true,   // ← Stays on server!
        addresses: true      // ← Stays on server!
      }
    });
  }
});

route('profile', (ctx) => {
  const user = ctx.loader.get('user');

  // Only send safe data to client
  return <Profile
    name={user.name}
    email={user.email}
    // password, creditCards NOT sent to client!
  />;
})
```

### Performance Optimization

```typescript
// ❌ BAD - All data sent to client
parallel({
  "@products": async () => {
    const products = await db.products.findMany(); // 10,000 products = 5MB payload!
    return <ProductList products={products} />;
  }
})

// ✅ GOOD - Data stays on server, minimal client payload
const dataLoaders = loader({
  allProducts: async () => db.products.findMany() // Loaded once on server
});

layout(<Shop />, () => [
  dataLoaders,

  route('index', (ctx) => {
    const products = ctx.loader.get('allProducts');
    const featured = products.filter(p => p.featured).slice(0, 10);
    return <ProductList products={featured} />; // Only 10 items = 50KB
  }),

  route('search', (ctx) => {
    const products = ctx.loader.get('allProducts'); // Same data, no re-fetch
    const query = ctx.searchParams.get('q');
    const results = products.filter(p => p.name.includes(query));
    return <SearchResults results={results} />;
  })
])
```

### Type Inference Mechanism

Loaders return type markers that TypeScript can extract:

```typescript
// Type marker pattern
type Loader<T> = {
  _brand: 'Loader';
  _data: T;
  execute: () => Promise<T>;
};

// Helper returns typed marker
function loader<T extends Record<string, (...args: any[]) => any>>(
  loaders: T
): Loader<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  // Implementation...
}

// TypeScript extracts loader types from use() return array
type ExtractLoaders<T> = T extends Loader<infer L> ? L : never;

// Route handler context is typed with merged loaders
type HandlerContext<TLoaders> = {
  loader: {
    get<K extends keyof TLoaders>(name: K): TLoaders[K];
  };
  // ... other context
};
```

### Advanced Features (Future)

#### Loader Dependencies

```typescript
loader({
  user: async (ctx) => await getUser(ctx),
  cart: async (ctx) => {
    const user = ctx.loader.get('user'); // ← Depends on user loader
    return await getCart(user.id);
  }
})
```

#### Loader with Revalidation

```typescript
const productLoaders = loader({
  products: async () => await db.products.findMany()
});

layout(<Shop />, () => [
  productLoaders,
  revalidate(({ currentUrl, nextUrl }) =>
    currentUrl.searchParams.get('filter') !== nextUrl.searchParams.get('filter')
  ),

  // Routes...
])
```

#### Loader with Tags (for invalidation)

```typescript
const productLoaders = loader({
  products: async () => await db.products.findMany()
});

layout(<Shop />, () => [
  productLoaders,
  tag('products'), // ← Can invalidate with invalidate('products')

  // Routes...
])

// Later, in a Server Action:
async function deleteProduct(id: string) {
  await db.products.delete({ where: { id } });
  invalidate('products'); // Revalidates all loaders tagged 'products'
}
```

#### Loader with Caching

```typescript
const categoryLoaders = loader({
  categories: async () => await db.categories.findMany()
});

layout(<Shop />, () => [
  categoryLoaders,
  cache({ staleTime: 60000, key: 'categories' }), // Cache for 1 minute

  // Routes...
])
```

#### Streaming Loaders (Suspense)

```typescript
loader({
  criticalData: async () => await fetchFast(),        // Loads immediately
  slowData: defer(async () => await fetchSlow())      // Streams later with Suspense
})
```

---

## 🏷️ Tag-Based Invalidation

### Concept

Tag routes, layouts, parallels, and loaders for fine-grained cache invalidation.

### Usage

```typescript
layout(<ShopLayout />, () => [
  tag('shop'),
  tag('products'),

  loader({
    products: async () => db.products.findMany()
  }),

  route('index', (ctx) => {
    const products = ctx.loader.get('products');
    return <ProductList products={products} />;
  })
])

// In a Server Action:
async function createProduct(data: ProductInput) {
  await db.products.create({ data });

  // Invalidate all routes/loaders tagged with 'products'
  invalidate('products');

  // Client automatically refetches tagged routes
}
```

### Client-Side Invalidation

```typescript
// Trigger re-render of tagged components
invalidate.client('basket');

// Refetch from server
invalidate.server('basket');

// Both
invalidate('basket');
```

---

## 🎨 Meta/SEO Helper

### Concept

Declarative SEO and metadata configuration.

### Usage

```typescript
route('products.detail', ProductDetailRoute, () => [
  meta({
    title: (ctx) => `Product: ${ctx.params.slug}`,
    description: 'Product details page',
    ogImage: '/og-product.jpg',
    canonical: (ctx) => `https://example.com/product/${ctx.params.slug}`
  })
])
```

---

## 💾 Cache Control

### Concept

Fine-grained caching configuration per route/layout/loader.

### Usage

```typescript
route('products', ProductsRoute, () => [
  cache({
    staleTime: 60000,  // 1 minute
    cacheKey: (params) => `products-${params.category}`,
    revalidateOnFocus: true
  })
])
```

---

## 🔍 Prefetch Hints

### Concept

Declare which routes should be prefetched.

### Usage

```typescript
route('products.category', CategoryRoute, () => [
  prefetch(['products.detail']), // Prefetch product detail route
])
```

---

## 🎯 Error Boundaries

### Concept

Route-level error handling.

### Usage

```typescript
route('products', ProductsRoute, () => [
  errorBoundary(<ProductsErrorUI />),
])
```

---

## ⏱️ Rate Limiting

### Concept

Built-in rate limiting per route.

### Usage

```typescript
route('api.search', SearchRoute, () => [
  rateLimit({
    max: 100,
    window: '1m'
  })
])
```

---

## 🧪 A/B Testing / Experiments

### Concept

Declarative A/B testing and feature flags.

### Usage

```typescript
route('checkout', CheckoutRoute, () => [
  experiment('new-checkout-flow', {
    variant: 'new-design',
    percentage: 50
  })
])
```

---

## 📊 Analytics

### Concept

Built-in analytics event tracking.

### Usage

```typescript
route('products.detail', ProductDetailRoute, () => [
  analytics({
    event: 'product_view',
    category: 'ecommerce',
    label: (ctx) => ctx.params.slug
  })
])
```

---

## Implementation Notes

### Design Principles

1. **Extensibility**: The `use()` pattern allows unlimited future extensions
2. **Type Safety**: Leverage TypeScript for full type inference
3. **Performance**: Minimal overhead, optimal bundle size
4. **DX**: Natural, intuitive API that reads like English
5. **LLM-Friendly**: Consistent patterns that AI can learn and apply

### Future Considerations

- Streaming and Suspense integration
- Progressive enhancement
- Server Actions integration
- Form handling patterns
- Authentication patterns
- Database transaction scoping
- WebSocket/SSE support

---

**Last Updated**: 2025-11-16
