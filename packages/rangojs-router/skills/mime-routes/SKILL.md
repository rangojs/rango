---
name: mime-routes
description: Content negotiation — serve different response types (RSC, JSON, text, XML) from the same URL based on Accept header
argument-hint: [negotiate|vary|accept]
---

# Content Negotiation (MIME Routes)

Content negotiation lets you register multiple response types on the same URL pattern.
The router inspects the `Accept` header and dispatches to the matching handler.
All negotiated responses include `Vary: Accept` for correct CDN/cache behavior.

See also: `/response-routes` for the base response route API (path.json, path.text, etc.).

## Defining Negotiated Routes

Declare the same URL pattern with both an RSC route and one or more response-type routes.
Order within the `urls()` array does not matter — the trie merges them at build time.

```typescript
import { urls } from "@rangojs/router/server";

export const urlpatterns = urls(({ path, layout, include }) => [
  // RSC page + JSON API on the same URL
  path("/products/:id", ProductPage, { name: "product" }),
  path.json("/products/:id", (ctx) => {
    return db.getProduct(ctx.params.id);
  }, { name: "productJson" }),
]);
```

When a browser requests `/products/42` (`Accept: text/html`), the RSC page renders.
When an API client requests the same URL (`Accept: application/json`), the JSON handler runs.

## Negotiation Rules

1. **`text/html` in Accept** — RSC route wins (the page renders normally)
2. **Specific MIME match** — the variant whose MIME type appears in Accept wins
3. **No match / `*/*` / empty Accept** — first variant in registration order wins (fallback)
4. **All responses** on a negotiated URL get `Vary: Accept` header, including the RSC side

The MIME mapping used for matching:

| Tag | MIME type |
|-----|-----------|
| `json` | `application/json` |
| `text` | `text/plain` |
| `xml` | `application/xml` |
| `html` | `text/html` |
| `md` | `text/markdown` |

Tags `image`, `stream`, and `any` are pass-through and do not participate in Accept matching.

## Multiple Response Types

A single URL can have an RSC route plus multiple response-type variants:

```typescript
export const urlpatterns = urls(({ path }) => [
  path("/data", DataPage, { name: "data" }),
  path.json("/data", () => ({ format: "json" }), { name: "dataJson" }),
  path.text("/data", () => "plain text", { name: "dataText" }),
  path.xml("/data", () => "<root>xml</root>", { name: "dataXml" }),
]);
```

- `Accept: text/html` — RSC page
- `Accept: application/json` — JSON handler
- `Accept: text/plain` — text handler
- `Accept: application/xml` — XML handler
- `Accept: */*` — first variant (JSON, since it was registered first)

## Wildcard Routes

Content negotiation works with wildcard `/*` patterns:

```typescript
path("/files/*", FileBrowserPage, { name: "files" }),
path.json("/files/*", (ctx) => {
  const filePath = ctx.params["*"];
  return { entries: listDir(filePath) };
}, { name: "filesJson" }),
```

## Response-Only Negotiation (No RSC Primary)

Two or more response-type routes can share a URL without an RSC route.
The last registered route becomes the primary; earlier ones become variants:

```typescript
path.json("/api/data", () => ({ format: "json" }), { name: "dataJson" }),
path.text("/api/data", () => "plain text version", { name: "dataText" }),
```

Without an RSC primary, there is no `text/html` short-circuit — the Accept header
picks among the response-type candidates directly.

## How It Works

1. **Build time**: `buildRouteTrie()` calls `mergeLeaves()` when multiple routes share a pattern.
   RSC routes become the primary trie leaf; response-type routes are stored in the `nv`
   (negotiate variants) array on the leaf.
2. **Runtime**: `previewRoute()` reads `negotiateVariants` from the trie match result.
   It parses the `Accept` header, builds a candidate list, and calls `pickNegotiateVariant()`.
3. **RSC short-circuit**: if the primary is RSC and `Accept` contains `text/html`,
   negotiation is skipped — the RSC pipeline handles the request.
4. **Vary header**: both the response-route handler wrapper and the RSC handler wrapper
   append `Vary: Accept` when the `negotiated` flag is set on the preview result.

## Caching Considerations

`Vary: Accept` is set automatically on all negotiated responses. This tells CDNs and
HTTP caches to store separate entries per Accept header value. No additional cache
configuration is needed for negotiated routes — the framework handles it.
