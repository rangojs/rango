# RFC: useFetchLoader API

## Problem

Currently, loaders in rsc-router can only be accessed during route navigation. There's no way to:
1. Fetch loader data from arbitrary client components
2. Prefetch loader data before navigation
3. Use loaders for form submissions (file uploads, etc.)

## Proposed Solution

Add a `useFetchLoader` hook that allows fetching loader data directly from the client, with support for middleware and progressive enhancement.

## API Design

### Creating a Fetchable Loader

```typescript
import { createLoader } from "rsc-router";

// Basic loader (not directly fetchable)
const BasicLoader = createLoader("basic", async (ctx) => {
  "use server";
  return data;
});

// Fetchable loader (no middleware)
const PublicLoader = createLoader("public", async (ctx) => {
  "use server";
  return publicData;
}, true);

// Fetchable loader with middleware
const ProtectedLoader = createLoader("protected", async (ctx) => {
  "use server";
  return protectedData;
}, { middleware: [authMiddleware] });
```

### Third Parameter Options

| Value | Meaning |
|-------|---------|
| `undefined` | Not fetchable (default, current behavior) |
| `true` | Fetchable, no middleware |
| `{ middleware: [...] }` | Fetchable with middleware |

### Client Usage

```typescript
"use client";

import { useFetchLoader } from "rsc-router/client";
import { ProductLoader } from "./loaders";

function ProductCard({ id }: { id: string }) {
  const { data, isLoading, error, load } = useFetchLoader(ProductLoader);

  useEffect(() => {
    load({ params: { id } });
  }, [id]);

  if (isLoading) return <Skeleton />;
  if (error) return <Error error={error} />;

  return <div>{data.name}</div>;
}
```

### HTTP Methods

The `load()` function supports different HTTP methods:

```typescript
// GET (default) - for data fetching
await load({ params: { id: "123" } });
await load({ params: { id: "123", filter: "active" } });

// POST - file uploads with params
await load({
  method: "POST",
  params: { productId: "123" },
  body: formData,
});

// PUT/PATCH - updates
await load({
  method: "PUT",
  params: { id: "123" },
  body: { name: "Updated" },
});
```

### Load Options

```typescript
type LoadOptions =
  | {
      method?: "GET";
      params?: Record<string, string>;
    }
  | {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      params?: Record<string, string>;
      body?: FormData | Record<string, any>;
    };
```

The loader receives params via `ctx.params` (or `ctx.searchParams` for compatibility).

The loader receives method info in context:

```typescript
const FileLoader = createLoader("file", async (ctx) => {
  "use server";

  if (ctx.method === "POST" && ctx.formData) {
    const file = ctx.formData.get("file");
    return uploadFile(file);
  }

  return getFile(ctx.params.id);
}, { middleware: [authMiddleware] });
```

### Form Action (Progressive Enhancement)

```typescript
function FileUpload() {
  const { data, load } = useFetchLoader(FileLoader);

  return (
    <form action={load.action}>
      <input type="file" name="file" />
      <button type="submit">Upload</button>
    </form>
  );
}
```

## Implementation

### Core Mechanism

The key insight is that `createLoader` can create an inline server action that closes over `fn` and `middleware`:

```typescript
function createLoader<T>(
  name: string,
  fn: LoaderFn<T>,
  options?: true | { middleware: Middleware[] }
) {
  const middleware = options === true ? [] : options?.middleware || [];

  return {
    __brand: "loader",
    name,
    fn, // Server-only, stripped on client
    action: async (formData: FormData) => {
      "use server";

      // fn and middleware are available in closure on server!
      const ctx = buildContext(formData);

      // Run middleware chain
      for (const mw of middleware) {
        await mw(ctx, async () => {});
      }

      // Execute loader
      return fn(ctx);
    },
  };
}
```

### Why This Works

1. The `action` function has `"use server"` inline
2. When bundled, the action becomes a server reference callable from client
3. On the server, `fn` and `middleware` are available in the closure
4. No registry needed - each loader is self-contained

### Hook Implementation

```typescript
function useFetchLoader<T>(loader: LoaderDefinition<T>) {
  const [data, setData] = useState<T | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (options?: { params?: Record<string, string> }) => {
    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      if (options?.params) {
        for (const [key, value] of Object.entries(options.params)) {
          formData.set(key, value);
        }
      }
      const result = await loader.action(formData);
      setData(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setIsLoading(false);
    }
  }, [loader]);

  // Attach action for form usage
  load.action = loader.action;

  return { data, isLoading, error, load, refetch: load };
}
```

## Middleware Behavior

| Access Method | Middleware Used |
|---------------|-----------------|
| Route navigation (`useLoader`) | Route's middleware chain |
| Direct fetch (`useFetchLoader`) | Loader's declared middleware |

This separation is intentional:
- Route middleware handles route-level concerns
- Loader middleware handles data-access concerns
- No duplication when using both

## Comparison with Server Actions

| Concern | Server Actions | useFetchLoader |
|---------|---------------|----------------|
| HTTP Method | POST only | GET, POST, PUT, etc. |
| Caching | Not cacheable | Client-side cacheable (GET) |
| Parallel requests | Sequential | Parallel |
| Progressive enhancement | Yes | Yes |
| Middleware | No | Yes |

## Future Enhancements

1. **Client-side caching**: SWR-style stale-while-revalidate
2. **GET endpoint**: For browser/CDN caching of public data
3. **Deduplication**: Prevent duplicate in-flight requests
4. **Prefetching**: `prefetchLoader(ProductLoader, { params })`

## POC Validation

The approach was validated with a working test:

1. Created `createLoaderSimple` with inline `"use server"` action
2. Action closes over `fn` and `middleware`
3. Client calls action, server executes with closure access
4. Result returned successfully

Test location: `examples/vite-rsc-demo/src/loader-fetch-test/`
