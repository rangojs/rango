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

1. **Q-value priority** — higher `q` wins (`Accept: application/json;q=0.9, text/html;q=1.0` serves RSC)
2. **Client order tiebreaker** — when q-values are equal, the type listed first in Accept wins (matches Express/Hono behavior)
3. **Specific MIME match** — the variant whose MIME type appears in Accept wins
4. **Wildcard / empty Accept** — `*/*` and missing Accept fall back to route definition order (the first-defined variant wins)
5. **All responses** on a negotiated URL get `Vary: Accept` header, including the RSC side

RSC participates as a `text/html` candidate alongside response-type variants.
There is no special short-circuit — RSC follows the same negotiation rules as other types.

The MIME mapping used for matching:

| Tag | MIME type |
|-----|-----------|
| RSC (plain `path()`) | `text/html` (negotiation) / `text/x-component` (wire format) |
| `json` | `application/json` |
| `text` | `text/plain` |
| `xml` | `application/xml` |
| `html` | `text/html` |
| `md` | `text/markdown` |

RSC routes negotiate as `text/html` but respond with `text/x-component` (the RSC wire format).
The browser's RSC runtime decodes this transparently — clients requesting `text/html` get
the RSC page rendered normally.

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

Without an RSC primary, there is no `text/html` candidate — the Accept header
picks among the response-type candidates directly.

## How It Works

1. **Build time**: `buildRouteTrie()` calls `mergeLeaves()` when multiple routes share a pattern.
   RSC routes become the primary trie leaf; response-type routes are stored in the `nv`
   (negotiate variants) array on the leaf. The `rf` (rsc-first) flag tracks definition order.
2. **Runtime**: `previewRoute()` reads `negotiateVariants` from the trie match result.
   It parses the `Accept` header (extracting q-values and order), builds a candidate list
   (RSC as `text/html` + response-type variants), and calls `pickNegotiateVariant()`.
3. **Candidate matching**: walks the client's sorted Accept list (by q desc, then order asc),
   matching each entry against candidates. Wildcards (`*/*`, `text/*`) fall back to definition order.
4. **Vary header**: both the response-route handler wrapper and the RSC handler wrapper
   append `Vary: Accept` when the `negotiated` flag is set on the preview result.

## Caching Considerations

`Vary: Accept` is set automatically on all negotiated responses. This tells CDNs and
HTTP caches to store separate entries per Accept header value. No additional cache
configuration is needed for negotiated routes — the framework handles it.
