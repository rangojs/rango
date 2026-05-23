---
name: response-routes
description: Response routes (path.json, path.text, etc.) for non-RSC endpoints with typed responses
argument-hint: [json|text|html|xml|md|image|stream]
---

# Response Routes

Response routes skip the RSC pipeline entirely. Use them for JSON APIs, plain text endpoints,
XML feeds, image proxies, and any route that returns a `Response` instead of React components.

## Route-Level Tags: path.json(), path.text(), etc.

Inside any `urls()` callback, use `path.json()`, `path.text()`, or other tags alongside regular RSC routes:

```typescript
import { urls, RouterError } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout, include }) => [
  // RSC routes (normal)
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),

  // JSON API route (inline, alongside RSC routes)
  path.json(
    "/api/status",
    (ctx) => ({
      status: "ok",
      timestamp: Date.now(),
    }),
    { name: "status" },
  ),

  // Text route
  path.text(
    "/robots.txt",
    (ctx) => {
      return "User-agent: *\nAllow: /\nDisallow: /api/\n";
    },
    { name: "robots" },
  ),

  // Markdown route
  path.md(
    "/docs/:slug.md",
    (ctx) => {
      return `# ${ctx.params.slug}\n\nDocumentation content here.`;
    },
    { name: "docs" },
  ),

  // Response route (full control, returns Response directly)
  path.image(
    "/og/:slug.png",
    async (ctx) => {
      const image = await generateOgImage(ctx.params.slug);
      return new Response(image, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    },
    { name: "ogImage" },
  ),
]);
```

## Available Tags

| Tag      | Usage           | Handler returns    | Auto-wrap                |
| -------- | --------------- | ------------------ | ------------------------ |
| `json`   | `path.json()`   | plain object/array | `{ data: T }` envelope   |
| `text`   | `path.text()`   | string             | text/plain Response      |
| `html`   | `path.html()`   | string             | text/html Response       |
| `xml`    | `path.xml()`    | string             | application/xml Response |
| `md`     | `path.md()`     | string             | text/markdown Response   |
| `image`  | `path.image()`  | Response           | pass-through             |
| `stream` | `path.stream()` | Response           | pass-through             |
| `any`    | `path.any()`    | Response           | pass-through             |

## ResponseHandlerContext

Response route handlers receive a lighter context (no `ctx.use()`, no `ctx.res`):

```typescript
interface ResponseHandlerContext<TParams, TEnv> {
  request: Request;
  params: TParams; // Typed from URL pattern
  env: TEnv; // Plain bindings (DB, KV, etc.)
  searchParams: URLSearchParams;
  url: URL;
  pathname: string;
  reverse: (name: string, params?: Record<string, string>) => string;
  get: GetVariableFn; // Read middleware variables
  header: (name: string, value: string) => void;
  // Use cookies().set(name, value, opts) for cookie mutations (standalone API)
}
```

### Setting Headers and Cookies

String-returning handlers (json, text, html, xml, md) can set custom headers and cookies
without constructing a full Response:

```typescript
path.md(
  "/docs/:slug.md",
  (ctx) => {
    ctx.header("Cache-Control", "public, max-age=3600");
    cookies().set("last-doc", ctx.params.slug, { path: "/" });
    return `# ${ctx.params.slug}\n\nContent here.`;
  },
  { name: "docs" },
);
```

Headers set via `ctx.header()` and cookies set via `cookies().set()` are merged into the
auto-wrapped Response. If the handler returns a `Response` directly, these are ignored
(use the Response headers instead).

### Environment Access

`ctx.env` is always the plain bindings passed as TEnv to `createRouter<TEnv>()`:

```typescript
// createRouter<{ DB: D1Database; KV: KVNamespace }>({ ... })

// In a response handler:
path.json(
  "/api/data",
  (ctx) => {
    ctx.env.DB; // D1Database (plain bindings)
    ctx.env.KV; // KVNamespace
    // Variables are accessed via ctx.get("key") or ctx.get(ContextVar)
    return { data: "ok" };
  },
  { name: "data" },
);
```

## JSON Envelope

`path.json()` handlers return plain data. The framework auto-wraps it
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
import { RouterError } from "@rangojs/router";

path.json(
  "/api/users/:id",
  (ctx) => {
    const user = users.get(ctx.params.id);
    if (!user) {
      throw new RouterError("NOT_FOUND", `User ${ctx.params.id} not found`, {
        status: 404,
      });
    }
    if (!hasPermission(ctx)) {
      throw new RouterError("FORBIDDEN", "Access denied", { status: 403 });
    }
    return user;
  },
  { name: "user" },
);
```

### Returning Response Directly

JSON handlers can return `Response` to bypass auto-wrap (custom status, headers, streaming):

```typescript
path.json(
  "/api/export",
  (ctx) => {
    const csv = generateCsv();
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=export.csv",
      },
    });
  },
  { name: "export" },
);
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

Look up response type from a `path.json()` or `path.text()` module by route name:

```typescript
import type { RouteResponse } from "@rangojs/router";

// From the apiPatterns module (before include)
type HealthData = RouteResponse<typeof apiPatterns, "health">;
// = ResponseEnvelope<{ status: string; timestamp: number }>

type ProductsData = RouteResponse<typeof apiPatterns, "products">;
// = ResponseEnvelope<{ id: string; name: string; price: number }[]>
```

### PathResponse (global lookup by URL pattern)

`PathResponse` reads from `RegisteredRoutes`, which carries response payload
metadata. That surface is **not** auto-wired — without the augmentation below,
`PathResponse` falls back to the generated path/search map, or to a permissive
map when nothing is generated. Either way, it has no response payload metadata,
so response routes resolve to `ResponseEnvelope<never>`:

```typescript
// router.tsx
export const router = createRouter({ document: Document }).routes(urlpatterns);

declare global {
  namespace Rango {
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

With that in place, look up the response type by URL pattern:

```typescript
import type { PathResponse } from "@rangojs/router/client";

// After include("/api", apiPatterns) in main urls
type Health = PathResponse<"/api/health">;
// = ResponseEnvelope<{ status: string; timestamp: number }>

// RSC routes return ResponseEnvelope<never>
type Home = PathResponse<"/">;
// = ResponseEnvelope<never>
```

For local/scoped response typing without global augmentation, prefer
`RouteResponse<typeof patterns, "routeName">` (see the section above) — it reads
the response payload straight from the `urls()` patterns and needs no
`RegisteredRoutes` wiring.

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
import { urls, RouterError } from "@rangojs/router";

export const blogApiPatterns = urls(({ path }) => [
  path.json(
    "/stats",
    (ctx) => ({
      views: 1200,
      visitors: 450,
    }),
    { name: "stats" },
  ),

  path.json(
    "/:slug/likes",
    (ctx) => ({
      slug: ctx.params.slug,
      count: 42,
    }),
    { name: "likes" },
  ),

  path.json(
    "/:slug/comments",
    (ctx) => [{ id: "c1", body: "Great post", author: "alice" }],
    { name: "comments" },
  ),
]);

// blog/urls.tsx
import { urls } from "@rangojs/router";
import { blogApiPatterns } from "./api/urls";

export const blogPatterns = urls(({ path, include }) => [
  path("/", BlogIndex, { name: "index" }),
  path("/:slug", BlogPost, { name: "post" }),
  path("/category/:catId", BlogCategory, { name: "category" }),

  include("/api", blogApiPatterns, { name: "api" }),
]);

// app/urls.tsx
import { urls } from "@rangojs/router";
import { blogPatterns } from "./blog/urls";

export const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/blog", blogPatterns, { name: "blog" }),
]);
```

### Type safety after mounting

```typescript
import type { RouteResponse } from "@rangojs/router";
import type { PathResponse, ParamsFor } from "@rangojs/router/client";

// Scoped (before mount) -- use the module directly, no global wiring needed
type Stats = RouteResponse<typeof blogApiPatterns, "stats">;
// = ResponseEnvelope<{ views: number; visitors: number }>

// After mounting -- names get prefixed.
// PathResponse needs `RegisteredRoutes extends typeof router.routeMap` (see above),
// otherwise it resolves to ResponseEnvelope<never>.
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
path(
  "/:slug/likes",
  (ctx) => {
    // ctx.reverse resolves names relative to the mount point
    const commentsUrl = ctx.reverse("comments", { slug: ctx.params.slug });
    // -> "/blog/api/my-post/comments"

    return { slug: ctx.params.slug, count: 42, commentsUrl };
  },
  { name: "likes" },
);
```

## Content Negotiation

Multiple response types can share the same URL pattern. See `/mime-routes` for the
full content negotiation API (Accept header matching, Vary: Accept, multi-variant routes).

## Long-Lived Responses (SSE / WebSocket)

For Server-Sent Events (`path.stream`) and WebSocket upgrades (`path.any`
returning a 101 / `webSocket` Response), see `/streams-and-websockets`.
Upgrade responses flow through without reconstruction; `Vary` and
`Server-Timing` are skipped, and stub headers are applied in place on a
best-effort basis.

## How It Works

1. `path.json()` tags the route at the trie level with a MIME type
2. `coreRequestHandler()` checks the tag before the RSC pipeline
3. Tagged routes short-circuit: handler runs, Response is returned directly
4. JSON routes auto-wrap return values in `{ data }` / `{ error }` envelope
5. Client-side navigation to response routes gets `X-RSC-Reload` header, triggering hard navigation
6. Response types flow through `_responses` phantom type on `UrlPatterns`, propagated by `include()`
7. When multiple routes share a URL pattern, the trie merges them for content negotiation (see `/mime-routes`)
