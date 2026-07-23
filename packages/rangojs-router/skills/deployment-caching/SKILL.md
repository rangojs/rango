---
name: deployment-caching
description: "Choose the deployment cache boundary for a Rango app: in-function segment/prerender/PPR caches, store-backed whole-response caching, or an external CDN cache. Use when comparing Cloudflare, Vercel, and Node deployments; deciding whether Cache-Control can reduce origin work; or reasoning about middleware, live loaders, PPR, and CDN behavior."
argument-hint: [cloudflare|vercel|node]
---

# Deployment caching boundaries

Start with one question: **does the request reach Rango before shared bytes are
served?** That boundary decides whether middleware runs, whether loaders stay
live, and which invalidation system owns the result.

## The execution matrix

| Mechanism                         | Stored artifact                                 | Function/worker runs on a hit? |                                   Rango middleware on a hit? | What stays live?                     |
| --------------------------------- | ----------------------------------------------- | -----------------------------: | -----------------------------------------------------------: | ------------------------------------ |
| `"use cache"`                     | one function result                             |                            yes |                                                          yes | caller, handlers, loaders, rendering |
| `cache()`                         | serialized Flight segments                      |                            yes |                                                          yes | middleware, loaders, HTML rendering  |
| `Prerender()`                     | build-time Flight segments in the server bundle |                            yes |                                                          yes | middleware, loaders, HTML rendering  |
| `ppr`                             | HTML prelude + React postponed state            |                            yes |                                 **yes, before shell commit** | middleware, holes, hydration payload |
| `createDocumentCacheMiddleware()` | complete response in the app cache store        |                            yes | outer middleware runs; the hit skips its downstream pipeline | nothing downstream                   |
| HTTP CDN cache (`s-maxage`)       | complete HTTP response outside the app          |                         **no** |                                                       **no** | nothing                              |

The first five rows enter the app. The first four preserve the complete request
model; a document-cache middleware hit intentionally short-circuits its
downstream pipeline. The last row is a platform cache: on a hit it serves bytes
without invoking Rango at all.

## Rango PPR is in-function PPR

Rango's `ppr` path option does not make the HTML shell a public static asset.
The worker or function handles every document request:

```text
request
  -> global middleware
  -> route middleware
  -> shell lookup
  -> flush stored prelude
  -> run live loaders + Flight + React resume
```

That ordering is the security contract. A redirect, 401, tenant decision,
`ctx.dynamic()`, cookie, or response header from middleware wins before a shell
byte is committed.

There are two shell producers:

- An ordinary `ppr` route captures after a runtime MISS.
- A route that combines `Prerender()` with the `ppr` path option captures during
  `vite build`, so its first production request can already be a shell HIT.

Both producers feed the same in-function serve path. Build-time shells are
content-hashed modules in the server bundle, not CDN-served HTML files.

`ppr.ttl`, `ppr.swr`, and `ppr.tags` govern that shell entry. They do **not**
emit HTTP `Cache-Control` and do not configure a platform CDN.

## Platform deployment shapes

### Cloudflare

The Cloudflare preset runs the RSC app in a Worker. The request reaches the
Worker at the edge, middleware runs there, and PPR shell lookup/resume stays in
that Worker. `CFCacheStore` supplies the app cache families; client assets are
served separately as assets.

### Vercel

The Vercel preset emits static client assets plus one streaming Node Function.
HTML, Flight, prerender payloads, and PPR shells are served from that function.
`VercelCacheStore` uses Runtime Cache inside the function; Runtime Cache is not
Vercel's CDN/ISR cache.

The preset deliberately emits no Vercel `.prerender-config.json`, response
`chain`, or CDN-stitched resume function. Vercel's open-source Build Output
parser accepts a generic `chain`, but the production CDN stitching protocol is
not a documented third-party Build Output contract. More importantly, a CDN
that emits the shell before invoking Rango cannot preserve the middleware
ordering above. Parser support does not solve that semantic mismatch.

### Generic Node

The Node preset runs the same in-function model behind your server or reverse
proxy. A CDN in front may cache complete responses when you emit shared-cache
headers, but that CDN is outside Rango and follows the HTTP CDN row in the
matrix.

## Cache-Control is the full-response mitigation

If a response is completely public and shared, HTTP caching can eliminate more
origin work than CDN-stitched PPR:

```http
Cache-Control: public, s-maxage=300, stale-while-revalidate=3600
```

On a CDN hit the function does not run and no shell or dynamic tail crosses the
origin boundary. The tradeoff is exact: the CDN stores the **completed** HTML
response, including loader output, resumed holes, and hydration payload. It
does not cache only the PPR prelude.

Use shared HTTP caching only when all of these are true:

- the complete response is identical for every request sharing the cache key;
- no authorization, redirect, rate-limit, tenant, or preview middleware must
  run on every request;
- no loader or rendered value contains session, cart, account, experiment, or
  other per-user data;
- replaying the response headers is safe, with no per-client `Set-Cookie`;
- TTL/SWR freshness for the whole response is acceptable.

Do not use `Vary: Cookie` as a general escape hatch. It creates a variant for
every cookie combination, destroys cache reuse, and makes the safety contract
hard to audit.

### One header, two possible consumers

`createDocumentCacheMiddleware()` parses `Cache-Control: s-maxage` as policy for
the configured app store's response family. The deployment platform may also
interpret the same header and cache the response at its CDN.

These are independent caches:

```text
CDN HIT
  -> function never runs

CDN MISS
  -> function
     -> Rango document-cache middleware HIT or MISS
```

Consequences:

- `skipPaths`, `isEnabled`, and `keyGenerator` only control the Rango
  middleware. They cannot guard a response already served by the CDN.
- `x-document-cache-status` reports the Rango store only when the function
  executes. A CDN may replay an old status header; use the platform's own cache
  header or logs to identify CDN hits.
- Platform CDN invalidation and the app store's tags/TTL are separate systems.
  Do not assume `updateTag()` purges an external CDN response.

Use a platform-targeted header such as `Vercel-CDN-Cache-Control` when you need
to keep CDN policy out of browser/downstream `Cache-Control`, but the complete
response and middleware-bypass rules are unchanged. Rango's document middleware
does not parse that platform-specific header; use it when the CDN, rather than
the app store, should own the complete response.

## Decision guide

| Requirement                                         | Choose                                     |
| --------------------------------------------------- | ------------------------------------------ |
| Per-request auth or request shaping                 | in-function caching; never shared CDN HTML |
| Stable shell with cart/session/live prices          | `ppr` with live holes                      |
| Build-known segments with live loaders              | `Prerender()`                              |
| Fully public response, whole-page TTL is acceptable | HTTP `s-maxage` + SWR                      |
| Whole response reused inside the app store          | `createDocumentCacheMiddleware()`          |
| One query or component is expensive                 | `"use cache"`                              |
| One route subtree is expensive                      | `cache()`                                  |

For a large dynamic app, CDN-stitched PPR would mainly improve shell first-byte
latency and avoid sending the prelude from the function. It would not remove the
per-request function invocation, live loaders, Flight payload, or React resume.
If the current in-function path is already fast, preserve middleware semantics
and apply full-response CDN caching only to the smaller set of routes that are
provably public and shared.

## Related skills

- `/ppr` — shell capture, holes, middleware commit point, invalidation
- `/prerender` — build-time Flight segments and `Prerender + ppr`
- `/document-cache` — store-backed complete-response middleware
- `/vercel` — Vercel Build Output preset and Runtime Cache wiring
- `/cloudflare` — Worker deployment and bindings
- `/cache-guide` — function, loader, and segment cache selection
