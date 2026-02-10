---
name: response-routes
description: Response routes (path.json, path.text, urls.json, etc.) for non-RSC endpoints with typed responses
argument-hint: [json|text|html|xml|image|stream]
---

# Response Routes

Response routes skip the RSC pipeline entirely. Use them for JSON APIs, plain text endpoints,
XML feeds, image proxies, and any route that returns a `Response` instead of React components.

## Route-Level Tags: path.json(), path.text(), etc.

Inside any `urls()` callback, use `path.json()`, `path.text()`, or other tags alongside regular RSC routes:

```typescript
import { urls, RouterError } from "@rangojs/router/server";

export const urlpatterns = urls(({ path, layout, include }) => [
  // RSC routes (normal)
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),

  // JSON API route (inline, alongside RSC routes)
  path.json("/api/status", (ctx) => ({
    status: "ok",
    timestamp: Date.now(),
  }), { name: "status" }),

  // Text route
  path.text("/robots.txt", (ctx) => {
    return "User-agent: *\nAllow: /\nDisallow: /api/\n";
  }, { name: "robots" }),

  // Response route (full control, returns Response directly)
  path.image("/og/:slug.png", async (ctx) => {
    const image = await generateOgImage(ctx.params.slug);
    return new Response(image, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  }, { name: "ogImage" }),
]);
```

## Module-Level Tags: urls.json(), urls.text(), etc.

When an entire module is one MIME type, use `urls.json()` or `urls.text()` instead of `urls()`.
All routes in the module inherit the tag. Mount with `include()`:

```typescript
// api/urls.tsx
import { urls, RouterError } from "@rangojs/router/server";

export const apiPatterns = urls.json(({ path }) => [
  path("/health", (ctx) => ({
    status: "ok",
    timestamp: Date.now(),
  }), { name: "health" }),

  path("/products", (ctx) => [
    { id: "1", name: "Widget", price: 9.99 },
    { id: "2", name: "Gadget", price: 19.99 },
  ], { name: "products" }),

  path("/products/:id", (ctx) => {
    const product = products.find(p => p.id === ctx.params.id);
    if (!product) {
      throw new RouterError("NOT_FOUND", `Product ${ctx.params.id} not found`, { status: 404 });
    }
    return product;
  }, { name: "productDetail" }),
]);

// urls.tsx (main)
export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/api", apiPatterns, { name: "api" }),
]);
```

## Available Tags

| Tag | path.X() | urls.X() | Handler returns | Auto-wrap |
|-----|----------|----------|-----------------|-----------|
| `json` | `path.json()` | `urls.json()` | plain object/array | `{ data: T }` envelope |
| `text` | `path.text()` | `urls.text()` | string | text/plain Response |
| `html` | `path.html()` | `urls.html()` | string | text/html Response |
| `xml` | `path.xml()` | `urls.xml()` | string | application/xml Response |
| `image` | `path.image()` | `urls.image()` | Response | pass-through |
| `stream` | `path.stream()` | `urls.stream()` | Response | pass-through |
| `any` | `path.any()` | `urls.any()` | Response | pass-through |

## ResponseHandlerContext

Response route handlers receive a lighter context (no `ctx.use()`, no `ctx.res`):

```typescript
interface ResponseHandlerContext<TParams, TEnv> {
  request: Request;
  params: TParams;             // Typed from URL pattern
  env: Bindings;               // Extracted from RouterEnv (DB, KV, etc.)
  searchParams: URLSearchParams;
  url: URL;
  pathname: string;
  href: (name: string, params?: Record<string, string>) => string;
}
```

### Environment Type Extraction

`env` extracts bindings from `RouterEnv`, not the full env:

```typescript
type AppEnv = RouterEnv<{ DB: D1Database; KV: KVNamespace }, { user: User }>;

// In a response handler:
path.json("/api/data", (ctx) => {
  ctx.env.DB;    // D1Database (bindings extracted)
  ctx.env.KV;    // KVNamespace
  // ctx.env.user  -- NOT available (variables are not on response ctx.env)
  return { data: "ok" };
}, { name: "data" });
```

## JSON Envelope

`path.json()` and `urls.json()` handlers return plain data. The framework auto-wraps it
in a `ResponseEnvelope<T>` discriminated union:

```typescript
// Success: HTTP 200
{ "data": { "status": "ok", "timestamp": 1700000000 } }

// Error: HTTP 404 (or whatever status RouterError specifies)
{ "error": { "message": "Product 999 not found", "code": "NOT_FOUND" } }
```

### Error Handling with RouterError

Throw `RouterError` to return structured error envelopes:

```typescript
import { RouterError } from "@rangojs/router/server";

path.json("/api/users/:id", (ctx) => {
  const user = users.get(ctx.params.id);
  if (!user) {
    throw new RouterError("NOT_FOUND", `User ${ctx.params.id} not found`, { status: 404 });
  }
  if (!hasPermission(ctx)) {
    throw new RouterError("FORBIDDEN", "Access denied", { status: 403 });
  }
  return user;
}, { name: "user" });
```

### Returning Response Directly

JSON handlers can return `Response` to bypass auto-wrap (custom status, headers, streaming):

```typescript
path.json("/api/export", (ctx) => {
  const csv = generateCsv();
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=export.csv",
    },
  });
}, { name: "export" });
```

## Client-Side Type Safety

### ResponseEnvelope and isResponseError

```typescript
"use client";
import type { ResponseEnvelope, ResponseError } from "@rangojs/router/client";
import { isResponseError } from "@rangojs/router/client";

// Fetch a typed response
const res = await fetch("/api/products/1");
const result: ResponseEnvelope<Product> = await res.json();

if (isResponseError(result)) {
  // result.error: ResponseError  (message, code?, type?)
  // result.data: undefined
  console.error(result.error.message);
} else {
  // result.data: Product
  // result.error: undefined
  console.log(result.data.name);
}
```

### RouteResponse (scoped lookup by route name)

Look up response type from a `urls.json()` or `urls.text()` module by route name:

```typescript
import type { RouteResponse } from "@rangojs/router/server";

// From the apiPatterns module (before include)
type HealthData = RouteResponse<typeof apiPatterns, "health">;
// = ResponseEnvelope<{ status: string; timestamp: number }>

type ProductsData = RouteResponse<typeof apiPatterns, "products">;
// = ResponseEnvelope<{ id: string; name: string; price: number }[]>
```

### PathResponse (global lookup by URL pattern)

Look up response type from the merged route map by URL pattern:

```typescript
import type { PathResponse } from "@rangojs/router/client";

// After include("/api", apiPatterns) in main urls
type Health = PathResponse<"/api/health">;
// = ResponseEnvelope<{ status: string; timestamp: number }>

// RSC routes return ResponseEnvelope<never>
type Home = PathResponse<"/">;
// = ResponseEnvelope<never>
```

### ParamsFor with Response Routes

```typescript
import type { ParamsFor } from "@rangojs/router/client";

// Works for both RSC and response routes
type ProductParams = ParamsFor<"api.productDetail">;
// = { id: string }
```

## Links to Response Routes

### Client: href.json(), href.text(), etc.

Response route links need `data-external` to trigger hard navigation (skip RSC fetch).
Use `href.json()` which returns props to spread on `<Link>`:

```typescript
"use client";
import { href, Link } from "@rangojs/router/client";

function Nav() {
  return (
    <>
      {/* RSC link (client-side navigation) */}
      <Link to={href("/about")}>About</Link>

      {/* Response route link (hard navigation via data-external) */}
      <Link {...href.json("/api/health")}>API Health</Link>
      <Link {...href.text("/robots.txt")}>Robots</Link>
    </>
  );
}

// href.json("/api/health") returns:
// { to: "/api/health", "data-external": "" }
```

## Use Items

Response routes support only `middleware()` and `cache()` as use items.
No `loader`, `loading`, `layout`, or `parallel`.

```typescript
path.json("/api/users", handler, { name: "users" }, () => [
  cache({ ttl: 60, swr: 300 }),
]);
```

## Mountable Module Pattern

A self-contained module with RSC pages + JSON APIs, mountable via `include()`:

```typescript
// blog/api/urls.tsx
import { urls, RouterError } from "@rangojs/router/server";

export const blogApiPatterns = urls.json(({ path }) => [
  path("/stats", (ctx) => ({
    views: 1200, visitors: 450,
  }), { name: "stats" }),

  path("/:slug/likes", (ctx) => ({
    slug: ctx.params.slug,
    count: 42,
  }), { name: "likes" }),

  path("/:slug/comments", (ctx) => ([
    { id: "c1", body: "Great post", author: "alice" },
  ]), { name: "comments" }),
]);

// blog/urls.tsx
import { urls } from "@rangojs/router/server";
import { blogApiPatterns } from "./api/urls";

export const blogPatterns = urls(({ path, include }) => [
  path("/", BlogIndex, { name: "index" }),
  path("/:slug", BlogPost, { name: "post" }),
  path("/category/:catId", BlogCategory, { name: "category" }),

  include("/api", blogApiPatterns, { name: "api" }),
]);

// app/urls.tsx
import { urls } from "@rangojs/router/server";
import { blogPatterns } from "./blog/urls";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/blog", blogPatterns, { name: "blog" }),
]);
```

### Type safety after mounting

```typescript
import type { RouteResponse } from "@rangojs/router/server";
import type { PathResponse, ParamsFor } from "@rangojs/router/client";

// Scoped (before mount) -- use the module directly
type Stats = RouteResponse<typeof blogApiPatterns, "stats">;
// = ResponseEnvelope<{ views: number; visitors: number }>

// After mounting -- names get prefixed
type BlogStats = PathResponse<"/blog/api/stats">;
// = ResponseEnvelope<{ views: number; visitors: number }>

// Params work through nested includes
type LikesParams = ParamsFor<"blog.api.likes">;
// = { slug: string }
```

### ctx.reverse inside mounted modules

Response route handlers inside a mounted module can reference local names:

```typescript
// Inside blogApiPatterns handler
path("/:slug/likes", (ctx) => {
  // ctx.reverse resolves names relative to the mount point
  const commentsUrl = ctx.reverse("comments", { slug: ctx.params.slug });
  // -> "/blog/api/my-post/comments"

  return { slug: ctx.params.slug, count: 42, commentsUrl };
}, { name: "likes" });
```

## Content Negotiation

Multiple response types can share the same URL pattern. See `/mime-routes` for the
full content negotiation API (Accept header matching, Vary: Accept, multi-variant routes).

## How It Works

1. `path.json()` / `urls.json()` tag the route at the trie level with a MIME type
2. `coreRequestHandler()` checks the tag before the RSC pipeline
3. Tagged routes short-circuit: handler runs, Response is returned directly
4. JSON routes auto-wrap return values in `{ data }` / `{ error }` envelope
5. Client-side navigation to response routes gets `X-RSC-Reload` header, triggering hard navigation
6. Response types flow through `_responses` phantom type on `UrlPatterns`, propagated by `include()`
7. When multiple routes share a URL pattern, the trie merges them for content negotiation (see `/mime-routes`)
