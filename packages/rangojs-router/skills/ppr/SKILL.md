---
name: ppr
description: PPR shell caching — opt a page route in with the `ppr` path option; the router serves the cached HTML shell instantly and resumes the live holes
argument-hint: "[setup]"
---

# PPR Shell Caching

Caches the rendered HTML **shell** of a page route (React `prerender` prelude
bytes plus `postponed` state) and, on a later request, flushes those bytes
before any render work happens, then resumes fizz for just the live holes. The
browser sees one ordinary streamed document; loaders stay fresh on every
request. This is the second render axis — the default axis-1 path is untouched,
and every ineligible request falls open to it.

Compare `/document-cache`, which freezes the WHOLE response including loader
output. Shell caching is for pages that mix a stable shell with live data: the
shell is shared per host+URL, the holes are per request.

## Setup: one path option, no middleware

PPR is a DOCUMENT-level property declared on the page route via the `ppr` path
option. Serving is **integral to the router** — there is nothing to mount. The
only prerequisite is an app-level `createRouter({ cache })` store that
implements the shell family (`getShell`/`putShell`): `MemorySegmentCacheStore`
(dev/tests), `CFCacheStore` (Cloudflare KV), or `VercelCacheStore` (runtime
cache). A ppr route on a store without the family stays on axis 1 with a
once-per-key warning.

```typescript
import { createRouter, urls } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";

export const urlpatterns = urls(({ path, layout, loader, loading }) => [
  layout(ProductShell, () => [
    path(
      "/products/:id",
      PricePage,
      // `ppr` is the whole opt-in AND the policy. `ppr: true` uses the default
      // ttl (300s); an object sets ttl/swr/tags (PartialPrerenderProps).
      { name: "product", ppr: { ttl: 600, swr: 120 } },
      () => [
        loader(LivePriceLoader),
        loading(<PriceSkeleton />), // the structural hole boundary
      ],
    ),
  ]),
]);

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({ kv: env.CACHE_KV, ctx: ctx! }),
  }),
});
export default router;
```

A route WITHOUT the `ppr` option is pure axis 1: no store read, no capture, no
logs, zero cost. `ppr` is per page route — declaring it on a layout is not
supported (subtree inheritance is a possible follow-up).

## Where PPR sits: the cache onion

Rango's caches layer like an onion — each ring stores a progressively more
"cooked" representation of the same page. From innermost (raw values) to
outermost (final bytes):

| Ring                    | Primitive                                | What is stored                                     | What stays live on a hit               |
| ----------------------- | ---------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| 1. Function values      | `"use cache"`                            | a function's return value                          | everything around the call             |
| 2. Loader values        | `loader(Fn, () => [cache({...})])`       | one loader's result (opt-in; loaders default live) | all other loaders, handlers, rendering |
| 3. Segments (Flight)    | `cache()` route / build-time `prerender` | serialized rendered segments + replayed handles    | loaders, HTML render                   |
| 4. **HTML shell (PPR)** | `ppr` path option                        | rendered prelude bytes + React postponed state     | the holes, hydration payload           |
| 5. Whole response       | `/document-cache`                        | final response bytes, headers included             | nothing — all-or-nothing               |

PPR is ORTHOGONAL to `cache()` (ring 3): a ppr route may be uncached (its
handlers run fresh on every serve and during capture), fully `cache()`d (its
segments replay), or mixed. One useful cache() property to know: the segment
codec **deep-settles promises at the ring-3 write**, so nothing inside a
`cache()` boundary can stay live — that is a cache() fact, not a ppr one.

Invalidation crosses rings: `updateTag()`/`revalidateTag()` reach segment,
shell, loader, and item entries in the same store, and shell entries
additionally self-invalidate on `React.version` change.

## The serve pipeline: commit after ALL middleware

On a document GET to a ppr route the router runs:

1. **match** — route identified, `ppr` config read from the matched route;
2. **the WHOLE middleware chain** — the global `router.use()` chain AND route
   DSL `middleware()`; both are guards, and the COMMIT POINT is after all of
   them: any rejection/redirect/401 wins before a single shell byte, on MISS
   and on a warmed HIT alike;
3. **shell lookup** — `getShell(key)` on the app store (key =
   host+pathname+sorted search);
4. **HIT** — the composed response is committed immediately: the stored prelude
   bytes flush first, while segment resolution, the fresh Flight render (the
   full hydration payload — there is no Flight-side resume), and the fizz
   `resume` of just the holes run BEHIND them inside the response stream;
5. **MISS** — plain axis-1 serve, tagged `x-rango-shell: MISS`, plus a
   background capture (stampede-guarded, retry-in-place, exponential backoff).

`x-rango-shell: HIT | MISS` is the observability header. Because the commit
point is after the chain, an unauthorized request NEVER sees shell bytes — put
auth middleware anywhere (global or route DSL) and it guards PPR for free.

## The hole doctrine (encode this in your head)

Holes are **render-defined**, decided by the shape of the tree, on three rules:

| Class          | What makes the hole                                                                                                                                                                | At capture                                                                             | At serve                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| **STRUCTURAL** | the ENTIRE segment subtree under a `loading()` registration                                                                                                                        | loaders masked; the LoaderBoundary postpones; the fallback bakes in as route structure | loaders run fresh; resume fills it |
| **PHYSICS**    | any promise NESTED in handed-over data still pending at capture, under the consumer's own `<Suspense>` — handler props, handle containers (`push({ x: promise })`), loader-carried | real I/O cannot win the task-quantized quiet window; the boundary postpones            | the promise settles and streams in |
| **SHELL**      | awaited handler data, TOP-LEVEL `push(promise)` (awaited before SSR), resolved promises, replayed `cache()` segments                                                               | baked into the prelude                                                                 | served from the frozen prelude     |

The unified rule for promises: **a promise nested inside your data is never
baked; the container settles.** The one asymmetry to remember versus loaders: a
LOADER container is a hole via `loading()` (the whole loader value is live),
while a HANDLE container is shell via root consumption (the handles generator
is drained before SSR) — only the promises nested inside it stay live.

**`loading()` is NOT the gate for holes.** A pending promise under any plain
`<Suspense>` postpones and is a hole at whatever level it suspends — the
PHYSICS row needs no `loading()` anywhere (the e2e fixture's physics and
nested-handle holes sit in a layout with none). A route without a loader PPRs
on pure promise/Suspense holes. `loading()` does two other jobs: it is the
GUARANTEED hole for loader data (live even when the value resolves instantly,
where a raw promise would bake), and on a route that registers a loader it is
the capture prerequisite (see the structural negative below).

### Handles: "nesting = liveness"

- `ctx.use(H)(promise)` — a TOP-LEVEL pushed promise is awaited server-side
  before SSR (`resolvedHandleStream`) and BAKED into the shell. The capture
  gate is held open for the same await, so real latency here is safe (bounded
  by the capture's 5s guard).
- `ctx.use(H)({ x: promise })` — the container passes through verbatim
  (resolution is shallow); the nested promise streams to the consumer, who must
  `<Suspense>` it. Under capture that boundary postpones — a hole.

### Want a hole for already-resolved data?

Put it in a loader: `loader(() => Promise.resolve(x))` + `loading()`. Loaders
are always the live lane — masked at capture, fresh on every serve — no matter
how fast the value settles.

### The structural negative: a loader route without loading()

The loading-less branch awaits loader data at TREE-BUILD, above every Suspense
boundary, so under capture's masked loaders the whole tree pins above `<body>`,
the prelude comes back trivial, and the sanity gate refuses to store. Observable
symptom: `x-rango-shell: MISS` forever plus a once-per-key worker warning. Add
`loading()` to the loader route and keep shell material in a layout.

## Execution matrix

| Phase            | MISS (foreground)      | Background capture                                                 | HIT (foreground)                                            |
| ---------------- | ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Middleware chain | runs (full)            | **NOT re-run** — inherits the request's post-middleware context    | runs (full) — commit point is after it                      |
| `router.match`   | runs                   | re-runs under a derived context                                    | runs (behind the flushed prelude)                           |
| Handlers         | run                    | run on UNCACHED segments; `cache()`d segments replay (mixed-chain) | run (same mixed-chain rules as any render)                  |
| Loaders          | run **fresh**          | **MASKED** (never execute) — the structural holes                  | run **fresh**                                               |
| Flight render    | full                   | full                                                               | full (hydration needs the whole payload — no Flight resume) |
| HTML production  | full fizz              | `prerender` + abort → prelude + postponed                          | `resume` only the holes — O(paths to holes)                 |
| Shell store      | schedules a bg capture | `putShell(key, …)`                                                 | `getShell(key)`; a stale/SWR hit also schedules a recapture |
| Prelude bytes    | —                      | —                                                                  | flushed FIRST, before segment resolution starts             |

Middleware is not re-run during capture because it already ran for the
triggering request — the capture's derived context inherits the
post-middleware state (`ctx` variables included, which is what makes
middleware-derived shell content photograph correctly). Guarding is
serve-time: the commit point runs the full chain on EVERY serve.

Because handlers on uncached segments EXECUTE during capture, the
`cookies()`/`headers()` capture guard is load-bearing: those reads THROW during
a capture render (`assertNotInsideShellCapture`), so identity can never leak
into a shared shell through them. Loaders are exempt (always fresh).

## allReady: the SEO/bot story

`ssr: { resolveStreaming: ... }` returning `"allReady"` (e.g. for bot user
agents) bypasses PPR entirely — the request gets one complete, fully-buffered
axis-1 document. Crawlers that dislike streamed shells get a finished page;
regular users get the streamed shell. No configuration interaction: allReady
wins.

## Security

Shell caching shares one shell per host+URL across all users:

**(a) Access control is sound by construction.** The commit point is after ALL
middleware on every serve. A 401/redirect short-circuit returns before any
shell byte.

**(b) Identity can't leak via cookies/headers.** `cookies()` and `headers()`
THROW during the background capture render. A shell that reads them is
PPR-ineligible by construction.

**(c) Residual hazard — middleware-derived per-user state.** A `ctx` variable
set by an upstream auth middleware and rendered by shell material is
photographed into the SHARED shell (the capture inherits post-middleware
state). That is scope fidelity working as designed — for shared values. If the
value is per-user: shell-cache only public/shared pages, put per-user content
in loaders, or key per variant at the CDN tier.

## What always stays on axis 1

Non-GET, RSC/partial/action/loader fetches, per-request CSP nonce,
`streamMode: "allReady"`, redirects, 404s, error renders, routes without `ppr`,
and any store without the shell family. A stored shell is invalidated when
`React.version` changes (postponed state is build-coupled), so deploys
self-heal via recapture.

## Options: PartialPrerenderProps

```typescript
path("/products/:id", Page, { name: "product", ppr: true }, use);
path(
  "/products/:id",
  Page,
  { name: "product", ppr: { ttl: 600, swr: 120, tags: ["catalog"] } },
  use,
);
```

| Field  | Default | Notes                                                                                              |
| ------ | ------- | -------------------------------------------------------------------------------------------------- |
| `ttl`  | `300`   | shell freshness window in seconds (`ppr: true` uses the default)                                   |
| `swr`  | —       | stale window: serve the stale shell + background recapture                                         |
| `tags` | —       | operational tags UNIONED with the tags the capture render auto-collects — see "Invalidation" below |

The shell store is always the app-level `createRouter({ cache })` store; the
default key is `${host}${pathname}${sortedSearch}:shell` (host-scoped so
multi-tenant shells never collide).

## Invalidation: tags vs revalidate()

`updateTag()`/`revalidateTag()` is the ONLY lever that changes the frozen shell
HTML; `revalidate()` is a DATA lever that never touches it.

A captured shell auto-carries the UNION of the non-loader tags recorded during
the capture render — every `cacheTag(...)` from a `"use cache"` function or
`cache()` segment that ran as shell material. Loader tags never attach (the
holes are already live). `ppr.tags` adds operational tags the render cannot
know (a tenant id, a deploy marker).

| Lever                                         | Reaches the frozen shell?                                     | Reaches the holes?                                  |
| --------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `updateTag` / `revalidateTag` on a SHELL tag  | YES — drops the shell → MISS → recapture                      | n/a (holes are already live)                        |
| `updateTag` / `revalidateTag` on a LOADER tag | no — loader tags never attach to a shell                      | drops that loader's cached value (if it `cache()`s) |
| `revalidate()` (named revalidation contract)  | **no** — re-runs segments/loaders for the PAYLOAD, never HTML | yes — the hole re-renders with fresh data           |

## Pitfalls

- **Loader route without `loading()`**: eternal MISS plus a once-per-key
  console warning (see "The structural negative").
- **Per-user value in shell material**: baked into the shared shell —
  deterministically, not by race (handler promises deep-settle at the ring-3
  write on cached chains; awaited/resolved values bake everywhere). Put
  per-user data in a loader.
- **Theme on a HIT is capture-then-corrected**: the resume tree replays the
  CAPTURE's `initialTheme` (resume requires it to match the frozen prelude);
  the visitor's cookie theme is applied pre-paint by the FOUC script and
  re-synced post-mount by ThemeProvider. Nothing to configure — but a themed
  component in the shell may briefly render the captured theme's markup before
  the post-mount re-sync.
- **Shell shows CAPTURE-time data for the shell's lifetime**: a `cache()`/`"use
cache"` value baked into the shell is PINNED at capture (the capture data
  snapshot) and replayed on every HIT, so the shell stays byte-identical to the
  frozen prelude even after that cache entry expires, gets recomputed, or is
  tag-invalidated. This is deliberate — parity beats freshness inside the shell.
  If a shell region needs to be fresh, put it under a `loading()` hole (holes are
  never pinned) or make the SHELL itself invalidatable by adding the tag to
  `ppr.tags`. Ring-1/ring-3 tag invalidation does NOT drop the shell.
- **Uncached nondeterminism in the shell is a hydration hazard**: a raw
  `Date.now()` / `Math.random()` / uncached `fetch` rendered directly in shell
  material (outside any cache ring) drifts between capture and hit and the
  snapshot CANNOT pin it — it was never a cache read. It will mismatch the frozen
  prelude and detonate hydration. Wrap it in `cache()`/`"use cache"` (then it is
  pinned) or move it under a `loading()` hole.
- **Stacking with `/document-cache`**: pick one per route — the document cache
  would cache the composite.
- **Dev + HMR**: works, but edits produce stale shells until TTL/recapture.
- **Dev cold-start cadence**: expect `MISS -> (in-place retry) -> HIT`. A
  refused capture is negatively cached with an exponential window (1s doubling
  to a 60s cap), so declaring `ppr` on an ineligible route never re-renders it
  on every request.
- **HIT status is committed at the flush**: a failing hole cannot become a
  500/redirect after the first shell byte — error UI renders inline via
  Suspense/error boundaries (the same property any streamed SSR page has after
  its shell flushes).

## Related

- `/document-cache` — whole-response edge caching (no live holes)
- `/caching` and `/cache-guide` — segment/function caching (axis 1 data)
- `/shell-manifest` — replayed handles as cache metadata read by live loaders
- Design doc: `docs/design/ppr-shell-resume.md` in the package
