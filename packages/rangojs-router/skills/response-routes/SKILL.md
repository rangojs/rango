---
name: response-routes
description: Response routes (path.json, path.text, etc.) for non-RSC endpoints with typed responses. Use when building a JSON/text API endpoint alongside your pages, or asking how to return raw JSON instead of RSC from a route.
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

| Tag      | Usage           | Handler returns    | Auto-wrap                     |
| -------- | --------------- | ------------------ | ----------------------------- |
| `json`   | `path.json()`   | plain object/array | bare JSON value (no envelope) |
| `text`   | `path.text()`   | string             | text/plain Response           |
| `html`   | `path.html()`   | string             | text/html Response            |
| `xml`    | `path.xml()`    | string             | application/xml Response      |
| `md`     | `path.md()`     | string             | text/markdown Response        |
| `image`  | `path.image()`  | Response           | pass-through                  |
| `stream` | `path.stream()` | Response           | pass-through                  |
| `any`    | `path.any()`    | Response           | pass-through                  |

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

## JSON Wire Shape

`path.json()` handlers return plain data. The framework serializes the handler's
return value **verbatim** (no envelope) on success, and an RFC 9457 `problem+json`
body on error. Discriminate with `res.ok` / the HTTP status — there is no in-body
`data`/`error` union:

```typescript
// Success: HTTP 200, content-type application/json
{ "status": "ok", "timestamp": 1700000000 }

// Error: HTTP 404 (or whatever status RouterError specifies),
//        content-type application/problem+json
{
  "title": "Not Found",
  "status": 404,
  "detail": "Product 999 not found",
  "code": "NOT_FOUND"
  // "stack": included in development only
}
```

### Error Handling with RouterError

Throw `RouterError` to return a structured `problem+json` body:

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

### Discriminating success vs. error with res.ok

Success bodies are the bare value; error bodies are RFC 9457 `ProblemDetails`.
Branch on `res.ok` (or the HTTP status) — not an in-body union:

```typescript
"use client";
import type { ProblemDetails } from "@rangojs/router";

// Fetch a typed response
const res = await fetch("/api/products/1");

if (!res.ok) {
  // Error body: application/problem+json
  const problem: ProblemDetails = await res.json();
  // problem.detail: string, problem.code: string, problem.status: number
  console.error(problem.code, problem.detail);
} else {
  // Success body: the bare value (no envelope)
  const product: Product = await res.json();
  console.log(product.name);
}
```

### RouteResponse (scoped lookup by route name)

Look up response type from a `path.json()` or `path.text()` module by route name:

```typescript
import type { RouteResponse } from "@rangojs/router";

// From the apiPatterns module (before include)
type HealthData = RouteResponse<typeof apiPatterns, "health">;
// = { status: string; timestamp: number }

type ProductsData = RouteResponse<typeof apiPatterns, "products">;
// = { id: string; name: string; price: number }[]
```

`RouteResponse` is the bare success payload (the JSON wire shape) — the same value
a `fetch().then(r => r.json())` yields on a 2xx. Error bodies are `ProblemDetails`,
keyed off `res.ok` at runtime, not part of this type.

### Rango.PathResponse (global lookup by URL pattern or concrete path)

`Rango.PathResponse` is ambient (no import) and reads from `RegisteredRoutes`,
which carries response payload metadata. That surface is **not** auto-wired —
without the augmentation below, `Rango.PathResponse` falls back to the generated
path/search map, or to a permissive map when nothing is generated. Either way, it
has no response payload metadata, so response routes resolve to `never`:

```typescript
// router.tsx
export const router = createRouter({ document: Document }).routes(urlpatterns);

declare global {
  namespace Rango {
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

With that in place, look up the response type by URL pattern (ambient, no import):

```typescript
// After include("/api", apiPatterns) in main urls
type Health = Rango.PathResponse<"/api/health">;
// = { status: string; timestamp: number }

// RSC routes (no JSON payload) return never
type Home = Rango.PathResponse<"/">;
// = never
```

`Rango.PathResponse` also accepts a **concrete path**, so it types a `fetch`
wrapper whose response is inferred from the path you pass:

```typescript
import { href } from "@rangojs/router/client";

async function get<T extends Rango.Path>(
  path: T,
): Promise<Rango.PathResponse<T>> {
  return fetch(href(path)).then((r) => r.json());
}

const product = await get("/api/products/42"); // Product (bare value)
```

Pattern keys (`/:id`) match exactly; a concrete path under a _nested_ dynamic
route can match several patterns and union their responses.

`Rango.PathResponse` reports the JSON **wire** shape, not the handler's raw
return: `path.json()` serializes with `JSON.stringify`, so a handler returning
`{ createdAt: Date }` resolves to the bare `{ createdAt: string }`. This
runs through the ambient `Rango.JsonSerialize<T>` transform (`Date -> string`,
honors `toJSON()`, drops functions/`undefined`, `bigint -> never`). The
`RouteResponse` surface below applies the same `Rango.JsonSerialize` transform, so
both response lookups report the identical wire shape.

For local/scoped response typing without global augmentation, prefer
`RouteResponse<typeof patterns, "routeName">` (see the section above) — it reads
the response payload straight from the `urls()` patterns and needs no
`RegisteredRoutes` wiring.

### ParamsFor with Response Routes

```typescript
import type { ParamsFor } from "@rangojs/router";

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

A heavy module like this is a good code-split candidate. Pass an async provider
and the module — its handlers, response serializers, and any nested
`include()`s — loads on the first request under the prefix instead of at startup:

```typescript
// blog/urls.tsx: `export default blogPatterns`
include("/blog", () => import("./blog/urls"), { name: "blog" }),
```

Named routes and response types still resolve through the split: `TRoutes` and
the `_responses` phantom are inferred from the resolved `urls()` value, so
`Rango.PathResponse<"/blog/api/stats">` and `ctx.reverse` are unchanged. See
`/composability`.

### Type safety after mounting

```typescript
import type { RouteResponse } from "@rangojs/router";
import type { ParamsFor } from "@rangojs/router";

// Scoped (before mount) -- use the module directly, no global wiring needed
type Stats = RouteResponse<typeof blogApiPatterns, "stats">;
// = { views: number; visitors: number }

// After mounting -- names get prefixed.
// Rango.PathResponse needs `RegisteredRoutes extends typeof router.routeMap` (see above),
// otherwise it resolves to never.
type BlogStats = Rango.PathResponse<"/blog/api/stats">;
// = { views: number; visitors: number }

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
4. JSON routes serialize the return value verbatim (bare) on success; a thrown error becomes an RFC 9457 `problem+json` body (`application/problem+json`)
5. Client-side navigation to response routes gets `X-RSC-Reload` header, triggering hard navigation
6. Response types flow through `_responses` phantom type on `UrlPatterns`, propagated by `include()`
7. When multiple routes share a URL pattern, the trie merges them for content negotiation (see `/mime-routes`)

## Consuming response routes

To call your own response-route JSON APIs from first-party TypeScript with a typed client (typed params, typed payloads inferred from the handler, no `.data`, typed `ProblemDetails` errors), see `/api-client` — a copy-paste recipe over `RouteResponse` + `ExtractParams` + a client-safe path builder. External/third-party consumers use the plain wire directly: bare JSON on success, `application/problem+json` on error.
