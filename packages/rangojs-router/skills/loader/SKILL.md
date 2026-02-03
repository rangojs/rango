---
name: loader
description: Define data loaders for fetching data in routes with createLoader
argument-hint: [loader-name]
---

# Data Loaders

Loaders fetch data for routes and make it available to handlers and client components.

## Creating a Loader

```typescript
import { createLoader, notFound } from "@rangojs/router/server";

export const ProductLoader = createLoader(async (ctx) => {
  const product = await db.products.findUnique({
    where: { slug: ctx.params.slug },
  });

  if (!product) {
    throw notFound("Product not found");
  }

  return product;
});
```

## Loader Context

The loader receives a context with:

```typescript
export const MyLoader = createLoader(async (ctx) => {
  ctx.params;      // Route parameters { id: string, slug: string }
  ctx.query;       // Query string parameters
  ctx.url;         // Full URL object
  ctx.pathname;    // Current path
  ctx.method;      // HTTP method
  ctx.request;     // Raw Request object

  // Variables from middleware
  const user = ctx.get("user");

  // Use other loaders
  const related = await ctx.use(RelatedLoader);

  return { user, related };
});
```

## Registering Loaders on Routes

```typescript
import { map } from "@rangojs/router/server";
import { ProductLoader } from "../loaders/product";

export default map<typeof routes>(({ route, loader, loading }) => [
  route("products.detail", async (ctx) => {
    const product = await ctx.use(ProductLoader);
    return <ProductPage product={product} />;
  }, () => [
    loader(ProductLoader),
    loading(<ProductSkeleton />),
  ]),
]);
```

## Loader with Middleware

Add middleware specific to a loader:

```typescript
export const UserProfileLoader = createLoader(
  async (ctx) => {
    const userId = ctx.get("validatedUserId");
    return db.users.findUnique({ where: { id: userId } });
  },
  {
    middleware: [
      async (ctx, next) => {
        const userId = ctx.params.id;

        // Validate user ID
        if (!isValidUUID(userId)) {
          throw new Error("Invalid user ID");
        }

        ctx.set("validatedUserId", userId);
        await next();
      },
    ],
  }
);
```

## Using Loaders in Handlers

```typescript
route("products.detail", async (ctx) => {
  // Fetch loader data
  const product = await ctx.use(ProductLoader);

  // Multiple loaders
  const [product, reviews, related] = await Promise.all([
    ctx.use(ProductLoader),
    ctx.use(ReviewsLoader),
    ctx.use(RelatedProductsLoader),
  ]);

  return (
    <ProductPage
      product={product}
      reviews={reviews}
      related={related}
    />
  );
}, () => [
  loader(ProductLoader),
  loader(ReviewsLoader),
  loader(RelatedProductsLoader),
])
```

## Loader Revalidation

Control when loaders refetch:

```typescript
route("products.detail", ProductHandler, () => [
  loader(ProductLoader),

  // Revalidate when params change
  revalidate(({ currentParams, nextParams }) =>
    currentParams.slug !== nextParams.slug
  ),

  // Revalidate on specific actions
  revalidate(({ actionId }) =>
    actionId?.includes("updateProduct") ?? false
  ),
])
```

### Soft vs Hard Revalidation

```typescript
// Hard decision - stops evaluation
revalidate(({ currentParams, nextParams }) => {
  return currentParams.id !== nextParams.id; // boolean
});

// Soft decision - continues to next revalidator
revalidate(({ actionId, defaultShouldRevalidate }) => {
  if (actionId?.includes("cart")) {
    return true; // Hard: must revalidate
  }
  // Soft: defer to next revalidator
  return { defaultShouldRevalidate };
});
```

## Client-Side Loader Access

### useLoader() - Strict access

```tsx
"use client";
import { useLoader } from "@rangojs/router";
import { ProductLoader } from "../loaders/product";

function ProductPrice() {
  // Data guaranteed (throws if not in context)
  const { data } = useLoader(ProductLoader);
  return <span>${data.price}</span>;
}
```

### useFetchLoader() - Flexible access

```tsx
"use client";
import { useFetchLoader } from "@rangojs/router";
import { SearchLoader } from "../loaders/search";

function SearchResults() {
  const { data, load, isLoading } = useFetchLoader(SearchLoader);

  const handleSearch = async (query: string) => {
    await load({ params: { query } });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch(e.target.value)} />
      {isLoading && <Spinner />}
      {data?.results.map(r => <Result key={r.id} {...r} />)}
    </div>
  );
}
```

## Async/Streaming Loaders

Return promises for streaming:

```typescript
export const RecommendationsLoader = createLoader(async (ctx) => {
  return {
    // Immediate data
    product: await db.products.findUnique({ where: { id: ctx.params.id } }),

    // Streams while other content renders
    recommendations: db.recommendations.findAsync(ctx.params.id),
  };
});
```

## Loader Caching

```typescript
route("products.detail", ProductHandler, () => [
  loader(ProductLoader, () => [
    // Cache this loader's results
    revalidate(({ currentParams, nextParams }) =>
      currentParams.slug !== nextParams.slug
    ),
  ]),
])

// Or use cache boundaries
cache({ ttl: 60, swr: 300 }, () => [
  loader(ProductLoader),
  route("products.detail", ProductHandler),
])
```

## Loader Error Handling

```typescript
export const ProductLoader = createLoader(async (ctx) => {
  try {
    const product = await db.products.findUnique({
      where: { slug: ctx.params.slug },
    });

    if (!product) {
      throw notFound("Product not found");
    }

    return product;
  } catch (error) {
    if (error instanceof DatabaseError) {
      throw new Error("Failed to load product");
    }
    throw error;
  }
});

// Handle in route
route("products.detail", ProductHandler, () => [
  loader(ProductLoader),
  errorBoundary(({ error, reset }) => (
    <div>
      <p>Error loading product: {error.message}</p>
      <button onClick={reset}>Retry</button>
    </div>
  )),
])
```

## Parallel Slot Loaders

```typescript
parallel(
  {
    "@sidebar": async (ctx) => {
      const categories = await ctx.use(CategoriesLoader);
      return <CategorySidebar categories={categories} />;
    },
  },
  () => [
    loader(CategoriesLoader),
    loading(<SidebarSkeleton />),
    revalidate(({ actionId }) => actionId?.includes("category") ?? false),
  ]
)
```

## Loader Composition

```typescript
// Base loader
export const UserLoader = createLoader(async (ctx) => {
  return db.users.findUnique({ where: { id: ctx.get("userId") } });
});

// Composed loader
export const UserWithOrdersLoader = createLoader(async (ctx) => {
  const user = await ctx.use(UserLoader);
  const orders = await db.orders.findMany({
    where: { userId: user.id },
  });

  return { user, orders };
});
```

## Loader Type Safety

```typescript
// Loader type is inferred
export const ProductLoader = createLoader(async (ctx) => {
  return { id: "1", name: "Widget", price: 99 };
});

// In handler - type is { id: string; name: string; price: number }
const product = await ctx.use(ProductLoader);

// In client - same type
const { data } = useLoader(ProductLoader);
// data: { id: string; name: string; price: number }
```

## Common Patterns

### List with pagination

```typescript
export const ProductListLoader = createLoader(async (ctx) => {
  const page = parseInt(ctx.query.page ?? "1");
  const limit = 20;

  const [products, total] = await Promise.all([
    db.products.findMany({
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.products.count(),
  ]);

  return {
    products,
    pagination: {
      page,
      totalPages: Math.ceil(total / limit),
      total,
    },
  };
});
```

### Conditional loading

```typescript
export const AdminDataLoader = createLoader(async (ctx) => {
  const user = ctx.get("user");

  if (!user || user.role !== "admin") {
    return null;
  }

  return db.adminStats.get();
});
```
