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

### Key Benefit: No Refetch Needed

When using `load.action`, the loader handles both the mutation AND returns updated data. No separate refetch call is required:

```typescript
// Server loader handles mutation + returns updated data
const NotesLoader = createLoader("notes", async (ctx) => {
  "use server";

  const noteText = ctx.formData?.get("note");
  if (noteText) addNote(noteText);  // mutation

  return { notes: getAllNotes() };  // returns updated data
}, true);

// Client - no refetch needed!
const { data, load } = useFetchLoader(NotesLoader);

useEffect(() => { load(); }, [load]);  // initial GET

<form action={load.action}>  {/* mutation updates data automatically */}
  <input name="note" />
</form>
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

## GET-based Fetching with RSC Serialization

The current server action approach uses POST for all requests, which is not cacheable. For data fetching, we want GET-based requests with RSC serialization.

### Problem with Server Actions for Data Fetching

| Concern | Server Actions (POST) | GET + RSC |
|---------|----------------------|-----------|
| HTTP Method | POST only | GET |
| Browser caching | Not cacheable | Cacheable |
| CDN caching | Not cacheable | Cacheable |
| Semantics | For mutations | For data fetching |
| Response format | Action-specific | RSC stream |

### Architecture for GET-based Fetching

```
Client                          Server (RSC Handler)
  │                                    │
  │ fetch(/_rsc?_rsc_loader=name&...)  │
  ├───────────────────────────────────►│
  │                                    │ 1. Parse _rsc_loader param
  │                                    │ 2. Load loader via action ID
  │                                    │ 3. Execute loader function
  │                                    │ 4. renderToReadableStream(result)
  │◄───────────────────────────────────┤
  │ RSC Stream (x-component)           │
  │                                    │
  │ createFromFetch() deserialize      │
  │                                    │
```

### Loader Action Reference

When a fetchable loader is created, the server action gets an ID from the bundler:

```typescript
const ProductLoader = createLoader("product", async (ctx) => {
  "use server";
  return db.products.get(ctx.params.id);
}, true);

// Internally creates:
// - action: server action function
// - actionId: bundler-generated ID (e.g., "loaders.ts#_action_abc123")
```

The loader stores the action ID, which can be used for GET requests.

### RSC Handler Extension

```typescript
// In rsc/index.ts handler
const isLoaderRequest = url.searchParams.has("_rsc_loader");

if (isLoaderRequest) {
  const actionId = url.searchParams.get("_rsc_loader_action");
  const paramsJson = url.searchParams.get("_rsc_loader_params");
  const params = paramsJson ? JSON.parse(paramsJson) : {};

  // Load the action function
  const action = await loadServerAction(actionId);

  // Build context
  const ctx = {
    method: "GET",
    params,
    // ... other context fields
  };

  // Execute loader
  const result = await action(ctx);

  // Serialize result with RSC
  const payload = { loaderResult: result };
  const rscStream = renderToReadableStream(payload);

  return new Response(rscStream, {
    headers: {
      "content-type": "text/x-component;charset=utf-8",
      "cache-control": "public, max-age=60", // Cacheable!
    },
  });
}
```

### Client-side Changes

```typescript
export function useFetchLoader<T>(loader: LoaderDefinition<T>) {
  // ...

  const load = useCallback(async (options?: LoadOptions) => {
    if (!loader.action) {
      throw new Error(`Loader "${loader.name}" is not fetchable.`);
    }

    const method = options?.method || "GET";

    if (method === "GET") {
      // Use fetch + RSC deserialization for GET requests
      const url = new URL("/_rsc", window.location.origin);
      url.searchParams.set("_rsc_loader", loader.name);
      url.searchParams.set("_rsc_loader_action", loader.actionId!);

      if (options?.params) {
        url.searchParams.set("_rsc_loader_params", JSON.stringify(options.params));
      }

      const response = fetch(url);
      const payload = await createFromFetch<{ loaderResult: T }>(response);
      setData(payload.loaderResult);
      return payload.loaderResult;
    } else {
      // Use server action for mutations (POST, PUT, DELETE, etc.)
      const result = await loader.action(options);
      setData(result);
      return result;
    }
  }, [loader]);

  // ...
}
```

### Benefits of GET-based Approach

1. **Browser caching**: GET requests can be cached by the browser
2. **CDN caching**: Public loaders can be cached at the edge
3. **Prefetching**: Can use `<link rel="prefetch">` for loader data
4. **Semantic correctness**: GET for reading, POST for mutations
5. **RSC serialization**: Full React component support in responses

### Implementation Steps

1. Add `actionId` to `LoaderDefinition` type
2. Extract action ID from server action in `createLoader`
3. Extend RSC handler to detect `_rsc_loader` requests
4. Update `useFetchLoader` to use fetch for GET, server action for POST
5. Expose `createFromFetch` to the hook (via deps or context)

### Implemented: Loader Registry with Hashed IDs

The GET-based fetching is implemented using a server-side loader registry and Vite plugin:

**How it works:**
1. `exposeLoaderId` Vite plugin scans for fetchable loaders in user code
2. Generates `$$id` for each loader:
   - **Dev mode**: Readable format `filePath#exportName`
   - **Production**: SHA-256 hash (12 chars) to avoid exposing file paths
3. Server registry maps `$$id` → loader function
4. GET requests use `$$id` to look up and execute the loader

**ID Format Examples:**
```
Dev:  src/handlers/loaders.ts#ProductLoader
Prod: a1b2c3d4e5f6
```

**Security:** Production builds use hashed IDs so file paths are never exposed to clients.

## Future Enhancements

1. **Client-side caching**: SWR-style stale-while-revalidate
2. **Deduplication**: Prevent duplicate in-flight requests
3. **Prefetching**: `prefetchLoader(ProductLoader, { params })`
4. **Cache headers**: Automatic cache-control based on loader config

## Implementation Status

**Fully implemented.** See demo at `/loaders` route in `examples/vite-rsc-demo`.

Demo includes:
- `useLoader` - SSR/navigation data access
- `useFetchLoader` - Client-side GET fetching
- `load.action` - Form-based mutations
- File uploads via FormData
- RSC content (loaders returning ReactNode)
