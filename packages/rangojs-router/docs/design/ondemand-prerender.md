# On-demand prerender

**Status:** Implemented (v1). This doc is the design of record for ISR-style
prerender refresh from a running app; the API and safety rules below ship in
`@rangojs/router`.

**One verb, two paths.** `router.prerender()` is also how a route that is not
on-demand is made ready before traffic: it warms that route's runtime caches
through the request handler (`prerender-every-route.md`, shipped together with
this). This doc covers the on-demand path; a result's `path` field says which
one ran. A refresh never answers `skipped-not-on-demand`, as an earlier draft
of this design did: that branch is the warm path. Only `prerender.remove()`
returns that status, for a route that has no page in the prerender store.

**Shipped in v1:** the `prerender` router option, `router.prerender()` /
`.many()` / `.remove()` / `.markStale()`, the "removed" marker that takes a
page out of service (see "Removing A Page"), the
`Prerender(..., { onDemand })` opt-in and
`od` trie flag, per-request store resolution, the writable durable overlay read
path (GETs and plain-route action re-renders) with deduplicated
stale-while-revalidate scheduling, the requestless producer + personalization
guard, the versioned envelope keyed by the router's data version and verified
by the router on every read, producer-code retention in the bundle, and the
in-memory (`@rangojs/router/prerender`) and Cloudflare KV
(`@rangojs/router/prerender/cloudflare`) stores.

**Deferred (as the phasing below anticipates):** intercept-variant refresh (the
producer renders the main variant first) — INTERIM CONSISTENCY CALL-OUT: after a
`router.prerender()` refresh of a route's main variant, an intercepted
(soft-nav/modal) navigation to that route keeps serving the older _bundled_
intercept artifact until the next deploy, because the trigger writes only the
main-variant key and the serve path's `:i` lookup finds no overlay entry. The
modal and the full page can therefore show different data in the window between a
refresh and a redeploy; `prerender.markStale()` does not reach the intercept
variant. An on-demand route used as an intercept target 404s in production on a
param that only a refresh produced: the intercept navigation skips the overlay,
misses the bundled `:i` artifact, and the gated producer refuses to render. Track under the intercept-refresh follow-up. Also deferred: build-time
durable seeding (Phase 8),
a Vercel Blob adapter (the interface is platform-agnostic; the concrete v1
adapters are in-memory + CF KV). One status was added beyond the original
result union: `skipped-passthrough`, returned when a `Passthrough + onDemand`
route's build handler returns `ctx.passthrough()` for the refreshed param (no
shared payload to persist; the live handler keeps serving it).

On-demand routes stay off the separate PPR shell lane in v1. A refresh can
replace the durable segment payload, but it cannot atomically replace a cached
document shell; serving both would pair a fresh tail with a stale prelude.
The exclusion is enforced by `isPprEntry` (`server/context.ts`) — the single
predicate every shell entry point (capture, serve, replay, build collection)
funnels through. Because an inert `ppr` silently cost the route its shell fast
path (cold-document LCP regresses from shell-serve to full SSR), and a dev-only
warning let that ship unnoticed, a route that sets both options throws at
definition (`path-helper.ts`); pick one of the two per route.

**Client-side staleness window.** A refresh cannot reach already-connected
clients: it is requestless, so there is no response to rotate the state cookie
on (`invalidateClientCache` is asserted unreachable inside the producer). A
client that viewport-prefetched an on-demand route (default-on in production
since #698) keeps serving the pre-refresh payload from its prefetch cache
(default TTL 300s) and the browser HTTP cache (`prefetchCacheControl`, default
max-age 300) until those expire or its own server action invalidates them.
This matches ISR semantics elsewhere (Next.js's client router cache behaves
the same); size `prefetchCacheTTL`/`prefetchCacheControl` down if a tighter
window matters.

**Serve-path read cost (KV store).** Every production request for an
on-demand route pays one uncached KV `get` plus one KV read per tag stamped on
the entry (tag markers are checked on every read, no L1 memo in v1) — reads a
bundled-manifest route does in memory. Default viewport prefetch multiplies
that by every od link entering the viewport. Keep tag counts per route small;
an L1 marker memo (as the runtime cache's CFCacheStore has) is the follow-up
if this shows up in KV analytics.

**Tag namespaces are disjoint.** `prerender.markStale()` marks only
prerender-store entries (`__rango_pr_tag__/` markers). It does not reach
runtime-cache tags (`updateTag`/`revalidateTag`), PPR shell entries, or
`createCloudflareZonePurge` zone tags — a consumer stamping the same logical
tag across layers must invalidate each layer explicitly. The reverse holds
too, and is a v1 decision: `updateTag()` / `revalidateTag()` never reach the
prerender store. They need a request context, and refreshes run from queues
and crons; `router.prerender()` is the way to refresh, `markStale()` the way
to mark.

Start from the existing prerender mental model: prerendering is cached RSC
segment payloads, not static HTML. Build-time prerender writes immutable payloads
into the bundled manifest; runtime requests read those payloads before normal
segment resolution. On-demand prerender adds a writable durable overlay in front
of that manifest and a public method for refreshing entries from fetch, cron,
queues, workflows, webhooks, and server actions.

The DX goal is deliberately small:

```ts
await router.prerender({ env, ctx })("/products/42");
```

That should be the whole trigger-side story. The hard parts are route
eligibility, storage, versioning, and safety, and those should live in router
configuration and route definitions.

## Design Principle

`router.prerender()` should be callable everywhere, but only explicit routes
should be persistable.

Calling the method must be boring from any platform trigger:

```ts
export default {
  fetch: router.fetch,

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(router.prerender({ env, ctx })("/products/42"));
  },

  async queue(batch, env, ctx) {
    ctx.waitUntil(
      router.prerender({ env, ctx }).many(
        batch.messages.map((message) => message.body.target),
        { concurrency: 4 },
      ),
    );
  },
};
```

But a route that did not opt into on-demand prerendering must not suddenly become
shared frozen output because some webhook guessed its URL. `router.prerender()`
should match the route, inspect route metadata, and return a clear skipped
result when the route is not eligible.

## Public API

### Router configuration

The router gets an env-resolved prerender store. This mirrors the existing
`cache` option exactly (`src/router/router-options.ts`): a plain config object
or a factory, resolved per request in the RSC handler, never at
`createRouter()` time.

```ts
import { createKVPrerenderStore } from "@rangojs/router/prerender/cloudflare";

export const router = createRouter({
  routes,
  prerender: (env, ctx) => ({
    store: createKVPrerenderStore(env.PRERENDER_KV),
    ttl: 3600,
    onRevalidate: (target, env) => env.PRERENDER_QUEUE.send({ target }),
  }),
});
```

`PrerenderConfig` is `{ store, ttl?, onRevalidate? }`. An earlier draft had a
separate `swr: boolean`; it was removed because `onRevalidate` without `swr`
was dead configuration. The presence of `onRevalidate` is the
stale-while-revalidate opt-in.

The option is the same union shape as `cache`:

```ts
prerender?:
  | PrerenderConfig<TEnv>
  | ((env: TEnv, ctx?: ExecutionContext) => PrerenderConfig<TEnv>);
```

`ctx` must be optional in the factory signature: only Cloudflare passes an
`ExecutionContext`; the node/Vercel virtual entry passes none. And because the
plain-object form is part of the union — as it already is for `cache` — later
build-time durable seeding options can live in the same config without renaming
anything.

`onRevalidate` receives the target (`{ route, params }`, kept
JSON-serializable so it can go straight into a queue message), the live env and
the stale request's execution context (`ctx`, absent where none exists).
It runs at most once per stale key per isolate while one is in flight
(`scheduleOverlayRevalidation`, `cache-lookup.ts`), so the obvious single
process wiring, a direct `router.prerender({ env, ctx })(target)` call, renders once per stale key
rather than once per stale request. The key is free again once its task
settles or after `IN_FLIGHT_LEADER_MAX_WAIT_MS` (the runtime cache's leader cap),
so a hung `onRevalidate` cannot pin it, and no scheduling happens under a build
context where `waitUntil` is a no-op.

The target is typed `PrerenderTargetObject`: `{ route: string; params }` plus a
type-only brand. the runner and its `.many()` accept it in addition to the
typed named-route object, so `(target, env, ctx) => router.prerender({ env, ctx })(target)`
typechecks on a router with named routes, also after a queue round trip
(`JSON.parse(raw) as PrerenderTargetObject`), while a hand-written
`{ route: "typo" }` is still a type error. Pinned in
`tests/cloudflare-basic/src/prerender-target-types.ts`.

TTL resolves route `onDemand.ttl` > router `ttl` > never stale, and it
is soft staleness metadata on the stored entry, never a hard store expiry — see
Store Model for why that distinction is load-bearing.

The important part is that store resolution is per call or per request, not a
module singleton. Cloudflare, Vercel, and multi-tenant apps must not memoize one
request's binding and reuse it for another tenant. Today's production prerender
store is a lazy per-isolate singleton
(`src/router/match-middleware/cache-lookup.ts`); the writable overlay cannot
inherit that.

### Route opt-in

`Prerender()` gets an `onDemand` option. `true` uses router defaults; an object
overrides them per route. `tags` is a `string[]` or a `(target) => string[]`,
like `cache()`'s `tags`.

```tsx
export const ProductPage = Prerender(
  async () => [{ id: "featured" }],
  async (ctx) => {
    const product = await ctx.env.PRODUCTS.get(ctx.params.id);
    return <Product data={product} />;
  },
  {
    onDemand: {
      ttl: 3600,
      tags: ({ params }) => [`product:${params.id}`],
    },
  },
);
```

This opt-in has two effects:

1. The route is marked ISR-eligible in the route metadata/trie.
2. The prerender producer code is retained in the deployed RSC bundle, or emitted
   into a separate producer bundle in a later implementation.

`onDemand` lands in the existing `PrerenderOptions` object (which already
carries `concurrency`). Retention piggybacks on the existing eviction
mechanism: handler eviction is a post-bundle pass that already skips a names
set for Passthrough handlers (`src/vite/utils/bundle-analysis.ts`), and the
chunk scan marks onDemand exports the same way.

**One derivation, no spelling restriction.** Producer retention and the
runtime `od` trie flag share a single source of truth: discovery evaluates the
routes module and records each onDemand route's `prerenderDef.$$id` in
`state.onDemandHandlerIds` (`discover-routers.ts`); the generateBundle chunk
scan then marks an export onDemand iff its extracted `$$id` is in that set
(`extractHandlerExportsFromChunk`). Because both sides read the evaluated
value — not the call-site text — any truthy spelling works (`onDemand: true`,
an options spread, an imported const), and retention can never disagree with
the trie flag. An earlier design detected the option with a regex over the
bundled call body, which silently evicted non-literal opt-ins; the map-driven
scan replaced it (there is deliberately no textual fallback). A def whose
`$$id` never appears in a chunk simply stays retained — eviction is
opt-in-by-match, so an id mismatch degrades to bundle bytes, never to a
broken refresh.

Plain `Prerender()` remains build-only and can still be evicted from production
bundles. `Passthrough()` alone is not an on-demand opt-in. If a `Passthrough()`
route should become refreshable, the wrapped `Prerender()` definition still needs
`onDemand`.

That rule prevents a semantic surprise: `Passthrough()` currently means "live
fallback on prerender miss." Once a durable prerender entry exists for a param
set, the live handler stops running for that param set until the page is
removed (`prerender.remove()`). That is fine when explicit; it is not fine as an accidental
consequence of making a route a fallback.

### Trigger API

`router.prerender({ env, ctx })` binds the runtime once and returns a runner,
synchronously and with no work at bind time. `ctx` is optional (Cloudflare
only). The config factory, the key version and the manifest still resolve per
call, and the dev warnings below fire once per router, not once per bind. The
runner accepts a URL-like target and per-call options:

```ts
const prerender = router.prerender({ env, ctx });
await prerender("/products/42");
await prerender(new URL("https://shop.test/products/42"));
```

The typed form avoids string construction and should be the preferred API in app
code that already has route names. This object target is a new convention —
nothing accepts `{ route, params }` today; the existing named-route API is
`reverse(name, params)`, which returns a string. Its typing should derive from
`routeMap` the same way `reverse` does, and `router.reverse()` output composes
for free, since string targets are accepted:

```ts
await prerender({ route: "products.detail", params: { id: "42" } });
```

Batching is first-class because queue and workflow consumers should not have to
write their own concurrency limiter:

```ts
await prerender.many(
  productIds.map((id) => ({ route: "products.detail", params: { id } })),
  { concurrency: 4 },
);
```

`concurrency` defaults to 1 (any invalid value is 1). One invocation runs under
the platform's time and CPU limits, so a large list belongs in a queue, one
message per batch.

There is deliberately no `map` option — callers pre-map to targets, and the
batching primitive owns only concurrency and result collection.

A refresh call always renders and replaces. A CMS webhook fires because content
changed, so a freshness short-circuit would no-op exactly when the trigger
matters most. `onlyIfStale: true` is the opt-in for cron-style sweeps that only
want to top up stale entries, and it is the only path that returns
`already-fresh`. In-flight dedup belongs to the store or the queue, not to the
result status.

V1 targets are path-only. If a string or `URL` target includes search params or a
hash, the call should return `skipped-unsupported-target` unless a later design
adds explicit search-param keying. The current prerender key is route plus params
plus variant, so silently persisting `/products/42?preview=1` under the same key
as `/products/42` would be unsafe.

Marking is deliberately namespaced under prerender so it does not look like
the existing runtime cache tag API, and named for what it does: it marks
entries stale and keeps serving them, where `updateTag()` / `revalidateTag()`
purge (an earlier draft called it `invalidateTags`):

```ts
await prerender.markStale(["product:42"]);
```

Dev warns once when `markStale()` runs against a store with no `onRevalidate`
configured: nothing would ever re-render a marked entry unless a sweep calls
`prerender(target, { onlyIfStale: true })`.

The existing `updateTag()` / `revalidateTag()` APIs remain runtime-cache APIs.
They should not silently mutate durable prerender entries. There is a second
reason for the separate API beyond namespacing: `updateTag()` /
`revalidateTag()` require an ALS request context and silently no-op from queue
and cron callers (`src/cache/tag-invalidation.ts`). Prerender invalidation must
work from exactly those triggers, which is why the runner binds an explicit `{ env, ctx }`.

Invalidation is mark-stale, not delete. The entry keeps serving and a
refresh is scheduled. Deleting would re-expose the bundled manifest entry below
it — older content presented as the result of an "invalidation."

"Stop serving this page" is a second intent, and it has its own call:

```ts
await prerender.remove("/products/42");
await prerender.remove.many(paths, { concurrency: 4 });
```

It stores a "removed" marker in place of the page, which masks the manifest
entry instead of re-exposing it. A refresh whose handler calls `notFound()`
stores the same marker. See "Removing A Page".

### Result object

The method should not force every trigger into try/catch. By default it returns
an inspectable result:

```ts
// The on-demand path's results. The full union, with the warm path's
// variant and statuses, is in prerender-every-route.md ("Result shape").
type PrerenderResult =
  | {
      ok: true;
      path: "on-demand";
      // "already-fresh" only occurs with onlyIfStale: true.
      // "removed": the "removed" marker is stored in place of the page.
      status: "rendered" | "already-fresh" | "removed";
      target: string;
      routeName: string;
      // opaque, for debugging and logs only -- not a stable format
      key: string;
      tags: string[]; // empty for "removed"
      ttl?: number; // absent = never stale
      // the warm request that followed the store write, when one ran
      caches?: PrerenderWarmCaches;
    }
  | {
      ok: false;
      path?: "on-demand"; // absent when no route matched
      status:
        | "no-match"
        | "no-store"
        | "skipped-personalized"
        | "skipped-unsupported-target"
        | "skipped-passthrough"
        | "skipped-not-on-demand" // prerender.remove() only
        | "render-failed"
        | "store-failed";
      target: string;
      routeName?: string;
      error?: unknown;
    };
```

A target with search params or a hash is `skipped-unsupported-target` on this
path (the key is route + params). The check runs after the route match: the
same search params on a route that is not on-demand are part of the URL a warm
requests.

`throwOnError: true` is useful for admin endpoints and CI-like workflows:

```ts
await prerender("/products/42", { throwOnError: true });
```

`many()` returns one result per target and should not stop the whole batch unless
`throwOnError` is set.

## Producer Semantics

The producer is requestless. This is the most important safety rule.

Even if `router.prerender()` is called from a live request, it must not inherit
that request's cookies, auth headers, geo, session, location state, or response
side effects. The runtime argument gives the producer platform capabilities
(`env`, `ctx.waitUntil`, cancellation), not user personalization.

Conceptually, on-demand prerender runs a build-like context:

```ts
interface OnDemandPrerenderContext<TEnv, TParams> {
  build: true;
  onDemand: true;
  dev: boolean; // reflects Vite dev mode, same meaning as BuildContext.dev
  env: TEnv;
  params: TParams;
  pathname: string;
  url: URL;
  searchParams: URLSearchParams; // always empty in v1 (targets are path-only)
  search: Record<string, never>;
  reverse: BuildReverseFunction;
  use: <T>(handle: Handle<T>) => HandlePush<T>;
}
```

The producer renders a complete main-route shell, not a partial navigation. It
must resolve the same route/layout/parallel shape that a build-time prerender
entry would store, then leave loader data to the normal prerender hit path. The
producer core is `matchForPrerender` running in the deployed RSC runtime — the
same segment resolution the build and the dev `/__rsc_prerender` endpoint
already use. Flight-encoding at runtime has precedent: the runtime cache
serializes segments per request today.

One env caveat: `BuildContext.env` is `buildEnv` — shared, build-scoped, and
throwing when unconfigured. The on-demand producer's `env` is the live trigger
binding. Same handler, two env provenances: a handler that relies on build-only
bindings will behave differently under refresh. That is acceptable, but it is a
route-author-visible difference and belongs in the public docs.

Request APIs must be unavailable or must mark the render non-persistable:

| Access during producer render               | v1 behavior                        |
| ------------------------------------------- | ---------------------------------- |
| `ctx.env`, `ctx.params`, `ctx.pathname`     | allowed                            |
| `ctx.use(handle)`                           | allowed and baked into the payload |
| `ctx.request`, `ctx.headers`, `ctx.cookies` | throw or skip as personalized      |
| standalone `cookies()` / `headers()`        | throw or skip as personalized      |
| `ctx.header()`, `ctx.setCookie()`, status   | throw or skip as side-effecting    |
| middleware                                  | skipped                            |
| loaders                                     | excluded from stored payload       |

The middleware row is producer-side only, matching build-time prerender
semantics. Request-time middleware on the serve path is unchanged by this
design.

The existing cache taint and cache-scope guards are the right implementation
direction (`src/cache/taint.ts`, `assertNotInsideCacheContext` in
`src/server/cookie-store.ts`). Those guards throw — they do not mark and
continue — so the producer catches the throw and maps it to the skipped result.
On-demand prerender needs a requestless-prerender guard that catches the same
class of APIs before a shared payload is written.

If the render touches request-specific state, the safe result is:

```ts
{ ok: false, status: "skipped-personalized", target }
```

The old entry remains in place. A failed refresh must not delete a working
payload.

Render errors need the same discipline — and this is existing scar tissue
(#587): a build-time render throw used to be swallowed by the route's error
boundary, serialized as a normal error segment, and baked as a healthy 200.
`matchForPrerender` now threads a build-only `throwOnError` flag so throws
surface instead of baking. The on-demand producer must set the same flag and
map the throw to `render-failed`, keeping the old entry. Without it, a refresh
against a flaky upstream silently replaces a good entry with a durable error
page.

One throw is not a failure: `notFound()`. The handler is telling you the page
no longer exists, and keeping the old entry would serve a deleted product until
the next deploy. The trigger maps a `DataNotFoundError` from the producer to
the "removed" marker and the `removed` status (`isDataNotFoundError`, which
also recognizes the error across realms by name). See "Removing A Page".

## Stored Payload

The payload the serve path reads is the same shape it already knows:

```ts
interface PrerenderEntry {
  segments: SerializedSegmentData[];
  handles: string;
}
```

The durable overlay wraps this payload in a metadata envelope (defined in Store
Model). The bundled build manifest keeps its current raw shape — only the new
writable layer needs the envelope, and that is the part being designed fresh.

The producer resolves route/layout/parallel segments, waits for handle data to
settle, filters out loader segments, serializes the non-loader segments, and
Flight-encodes handle data.

Loaders are never persisted. `yieldFromStore()` already resolves loaders fresh on
every prerender hit, and on-demand entries must preserve that invariant.

Intercept variants need their own entries, matching the existing key convention:

```txt
blog.post/a1b2c3      main variant
blog.post/a1b2c3/i    intercept variant
```

For v1, the producer can render the main variant first. Intercept refresh can be
added once the main producer and store overlay are stable.

## Store Model

The existing production store is a read-only manifest. On-demand prerender needs
a writable durable overlay, and you might expect the store to own the safety
rules that come with it. It does not: a store is plain get/set, and the router
owns the envelope.

```ts
interface WritablePrerenderStore {
  get(key: PrerenderKey): Promise<PrerenderStoredEntry | null>;
  set(key: PrerenderKey, stored: PrerenderStoredEntry): Promise<void>;
  delete?(key: PrerenderKey): Promise<void>;
  markStale?(tags: string[]): Promise<void>;
}
```

The trigger composes the versioned envelope (`composeStoredEntry`,
`writable-store.ts`) and hands it to `set()`; the store persists it as given.
Every read is verified by the router, not the store: the serve path
(`cache-lookup.ts`) and the trigger's `onlyIfStale` read both run
`isStoredEntryValidFor` on whatever `get()` returned. The first version of this
contract had the store compose and verify (`get(key, meta)`,
`set(key, entry, options)`), with the helpers unexported, so a third-party store
had to reimplement the collision guard by hand, or skip it without anyone
noticing. A store may still lower `meta.staleAt` on read from its own tag
markers, which is how the KV store implements `markStale()`.

```ts
interface StoredEnvelope {
  v: 1;
  meta: {
    storedAt: number;
    staleAt?: number; // absent = never stale
    tags: string[];
    version: string; // the key's version at write time
    params: Record<string, string>; // verified against the request on read
  };
}

type PrerenderStoredEntry =
  | (StoredEnvelope & { entry: PrerenderEntry }) // a refreshed page
  | (StoredEnvelope & { removed: true }); // the page was removed: no entry
```

The second variant is the "removed" marker; "Removing A Page" has its rules.

Two rules follow from the envelope:

- TTL is `staleAt`, soft metadata — never a hard store expiry like KV
  `expirationTtl`. Hard expiry deletes the very entry a stale serve needs, and
  worse, an expired overlay falls back to the bundled manifest, which is older
  content than what just expired. Entries never expire.
- `meta.params` exists because the key hash is 8-hex DJB2 with a documented
  32-bit collision caveat (`src/prerender/param-hash.ts`). At build time a
  collision is detectable inside one process; with runtime writes keyed off
  webhook-supplied params, a collision silently serves one page's content under
  another's URL. Verify-on-read is the cheap fix; a stronger hash for durable
  keys is the alternative.

The read path is:

```txt
durable overlay -> bundled build manifest -> miss/live fallback
```

A stale overlay hit is still a hit. The overlay is always newer than the build
artifact below it, so staleness never changes what is served — it only controls
whether a refresh gets scheduled (see SWR And Queues).

The durable overlay must not memoize misses for the lifetime of an isolate.
Queues, workflows, and webhooks can refresh a key after a previous request
missed it. Note the trap: the production manifest store memoizes every result —
including nulls — in a per-isolate `Map` forever (`src/prerender/store.ts`),
which is correct for the immutable manifest and wrong for the overlay. Bounded
negative caching (a few seconds) is fine, and worth having so on-demand routes
that were never refreshed do not pay a store read per request forever; it is a
follow-up, not in v1.

Keys carry the owning router's cache version:

```txt
prerender:{routerId}:{version}:{routeName}:{paramHash}
```

There is no intercept-variant key yet: nothing writes one. The intercept
refresh follow-up (#1060) adds an optional `PrerenderKey` field and a `:i`
suffix additively; main-variant keys keep serializing exactly as above.

`version` is the router's **data** version
(`docs/design/per-app-cache-version.md`), or `createRouter({ version })` when
the app sets one. The overlay stores `SerializedSegmentData[]`, exactly what the
segment cache stores under the data version, so it follows the same rule: a
deploy that changes the router's server code starts over, a client-only deploy
keeps every refreshed page. The first cut keyed on the document version, which
made a CSS tweak wipe every refreshed page — the outcome per-app versions exist
to prevent. Both sides resolve it through one call, `resolvePrerenderVersion`
(`server/build-version-table.ts`): the trigger per call, `rsc/handler.ts` when
the handler is created. A `createRSCHandler({ version })` does not move it,
because the trigger never sees that option.

A store keys off `key.version` and must never call `getCacheVersions()`: the
trigger's `set()` runs outside the producer's request context, where that
returns the whole-build fallback instead of the owning router's version.

Two consequences worth stating out loud:

- A server-code deploy starts with an empty overlay. On-demand freshness resets
  to the bundled manifest until entries are refreshed again; build-time durable
  seeding (below) is the mitigation.
- Cloudflare gradual deployments stay correct: old and new worker versions
  serving concurrently each read their own version's namespace.

The v1 KV adapter (`createKVPrerenderStore`) is self-contained rather than an
extraction of `CFCacheStore`'s tag machinery: the same timestamp-marker
algorithm, in a separate marker namespace (`__rango_pr_tag__/`), with lower
regression risk for the runtime cache. Reusing `CFCacheStore`'s L1 marker memo
is a follow-up if per-request marker reads show up in KV analytics.

## Removing A Page

A product gets deleted. Its refreshed page has to stop serving, and until
#1060 nothing could make it: a refresh whose handler called `notFound()` came
back `render-failed` and kept the old entry (the last good page is served,
which is right for an outage and wrong for a deletion), and nothing called
`store.delete()`.

You might reach for that `delete()` first. It is the wrong tool, for the reason
mark-stale exists: under the overlay sits the bundled manifest, and for a param
the build baked, deleting the overlay entry brings the build-time page back. A
deleted product would be replaced by an older copy of itself.

So a removal writes something instead of deleting: a "removed" marker (a
tombstone) stored in place of the page.

```ts
// what the store holds for a removed page
{ v: 1, removed: true, meta: { storedAt, tags: [], version, params } }
```

A request that finds it is not served from any prerender store. The overlay
answered, so the bundled manifest below is never read, and the route's own
handler takes it from there: a plain on-demand route's gated producer throws
the same `DataNotFoundError` a miss throws (a 404 through the app's
`notFound` boundary), and a `Passthrough` route runs its live handler.

### Two writers, one mechanism

1. **A refresh whose handler calls `notFound()`.** `await prerender(url)` on a
   deleted product now does the right thing: the result is
   `{ ok: true, path: "on-demand", status: "removed", ... }`. Any other throw
   is still `render-failed` and keeps the old entry.
2. **`await prerender.remove(target)`**, which renders nothing. A "product
   deleted" webhook fires when the item is gone from the CMS, which is not
   always when it is gone from the read replica the handler queries; a removal
   that needed a render would bring the page back from a lagging data source.

Both end in the one `store.set(key, tombstone)` (`composeStoredTombstone`,
`writable-store.ts`; `renderOnDemand` in `create-prerender-trigger.ts`). A
later `prerender(url)` that renders overwrites the marker with the page:
`set()` replaces, whatever was there.

The batch form is `prerender.remove.many(targets, { concurrency, throwOnError })`,
not an option on `.many()`. Next to `prerender.many(targets)` it reads as the
same shape one level down (`prerender` and `prerender.remove` are each callable
per target and each have `.many`), and it keeps a destructive operation out of
an options bag: `.many(targets, { remove: true })` turns a refresh into a
removal by one boolean, carries `onlyIfStale`, which means nothing for a
removal, and a mixed "refresh these, remove those" batch is not something a
webhook produces.

### The rules, and why

- **The shape.** The marker has no `entry`. That is deliberate, and it is the
  rollback story: `isStoredEntryValidFor` has always required a whole entry,
  so a router from before the marker reads one as malformed, which is a miss,
  and serves what a miss serves. It never renders an empty page. (Keys carry
  the data version, so a rollback usually lands in another namespace anyway;
  the case that matters is an app that pins `createRouter({ version })`.)
  `validatorBeforeTheRemovedMarker` in `memory-prerender-store.test.ts` is a
  frozen copy of that old check, so the property cannot drift. `meta` keeps
  the fields a page has, with `tags` always empty and no `staleAt`: a store
  that reads or indexes `meta.tags` keeps working on a marker without knowing
  it exists, which is why neither shipped store changed.
- **Verified like a page.** Same key version, same params check. The params
  check matters more here than for a page: on a hash collision, another
  page's marker must not remove this one.
- **`onlyIfStale` leaves it alone.** A marker is never stale. A cron sweep
  over every catalog URL would otherwise render each removed page every
  night, and bring one back whenever the data source still had it. The sweep
  gets `removed` for that target and renders nothing; only a refresh without
  `onlyIfStale` replaces a marker.
- **`markStale()` never matches it** (no tags), and **`onRevalidate` is never
  scheduled for it**: the serve path returns on the marker ahead of the
  staleness check, so even a store that lowered its `staleAt` schedules
  nothing (`cache-lookup-prerender-removed.test.ts`).
- **Server actions.** A plain on-demand route's action re-render reads the
  overlay (it has no live handler). On a marker it takes the same path as a
  document request, so the re-render is the 404 and not the build entry.
- **`remove()` on a route that is not on-demand** returns
  `skipped-not-on-demand`. A refresh of such a route is a warm; a removal has
  nothing to remove there and must not turn into a request.
- **`ctx.passthrough()` is not `notFound()`.** A `Passthrough` route whose
  build handler declines a param still gets `skipped-passthrough`, and a page
  stored earlier for that param keeps serving. Only `notFound()` and
  `remove()` write the marker. Whether a decline should write it too (the
  status's own wording, "the live handler keeps serving it", is only true
  when no page was stored) is left open; it was not part of this decision.
- **Dev answers 404 too.** `gateOnDemandProducer` (`urls/path-helper.ts`) lets
  the retained producer render live in dev on a miss. For a removed page that
  would show, in dev only, a page production answers with a 404, and only
  when the data still exists, which is the `remove()` case. The serve path
  marks the handler context (`_prerenderRemoved`) and the gate closes on it.
  It rides the handler context and not the request context because the gate
  runs after awaits in the match pipeline, where `withCacheLookup` documents
  that the request ALS can be lost on workerd. One dev difference remains: an
  HMR refetch (`X-RSC-HMR`) skips the prerender stores altogether, so it skips
  the marker and renders the edited module live.
- **Intercepted navigations do not see the marker.** They do not read the
  overlay (only the main variant is written), so the build's `:i` artifact of
  a removed page still serves. Reading the overlay there only to look for a
  marker would cost one store read (on KV, plus a read per tag) on every
  intercepted navigation to an on-demand route. It belongs to the intercept
  refresh follow-up (#1060).

### What a removal does not reach

No warm request follows a removal. There is no page to rebuild a cache on, and
on a `Passthrough` route the warm would run the live handler, which may still
render the removed page from a data source that has not caught up, and write
that to its caches.

The marker lives in the prerender store, and two runtime caches sit around the
route. What each serves right after a removal is pinned in
`testing/__tests__/on-demand-prerender-remove.rsc-test.tsx`:

| Cache around the route                            | Right after a removal                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a plain route's `cache()`, its loaders' `cache()` | 404. The route's `cache()` never holds a record of a store-served page (a prerender hit is not written), and loader data is not shown on a 404                                    |
| the document cache                                | the document it stored, until that entry's `s-maxage` and `stale-while-revalidate` run out. `createDocumentCacheMiddleware` answers ahead of the router and never sees the marker |
| a `Passthrough` route's `cache()`                 | whatever the live handler's caches hold, exactly as for a page that was never refreshed                                                                                           |

You might expect the removal to drop the cached document too. It cannot from
where it runs: `SegmentCacheStore` has no call that deletes a response entry,
and the entry's tags are the ones its request recorded, in the runtime
namespace, which the trigger has no request context to invalidate. So the
contract is the one content changes already have (`await updateTag(tag)`, then
`prerender(url)`, in `prerender-every-route.md`): invalidate the tag the
document carries, then remove. A removal that should reach the document cache on its
own needs a response-delete on the store interface, or an implicit per-page
tag on documents served from the overlay; neither is small.

### Precedent

The Next.js Pages Router has the same rule for the `notFound()` half: "With
`notFound: true`, the page will return a `404` even if there was a
successfully generated page before. This is meant to support use cases like
user-generated content getting removed by its author."
(nextjs.org/docs/pages/api-reference/functions/get-static-props)

## Build-time Durable Seeding

The first implementation can keep the existing bundled manifest as the build
output and use the durable overlay only for runtime refreshes.

The same store interface also enables build-time seeding later:

1. Vite build resolves `buildEnv`.
2. The build prerender loop produces the same `PrerenderEntry`.
3. If a writable store is configured for build, the build writes the entry to
   durable storage under the same versioned key.
4. The bundled manifest remains the fallback artifact unless the app opts out.

Build-time seeding is useful for Cloudflare KV, R2, Vercel Blob, or a custom
deployment cache. It is not required for the trigger-side DX.

## Runtime Flow

### Serving

```txt
request arrives
  |
  v
match route
  |
  v
route has prerender or on-demand flag?
  |
  +-- no --> normal pipeline
  |
  v
resolve env-scoped prerender store
  |
  v
lookup durable overlay by versioned key; verify the answer
  |
  +-- fresh hit --> yieldFromStore(entry), then resolve loaders fresh
  |
  +-- stale hit --> serve it the same way; with onRevalidate configured,
  |                 schedule it via waitUntil (once per key per isolate)
  |
  +-- "removed" marker --> nothing is served and the bundled manifest is
  |                        skipped: the route's handler answers (a plain
  |                        route's gate: 404; Passthrough: the live handler)
  |
  v
lookup bundled manifest
  |
  +-- hit --> yieldFromStore(entry), then resolve loaders fresh
  |
  v
normal miss behavior
```

The lookup gate cannot be only today's `pr` flag. A route may have no build-baked
entry but still be on-demand eligible. The trie needs a separate flag, for
example `od: true`, or a broader "has prerender store lookup" flag.

One rule keeps this from ambiently becoming request-time ISR: the retained
producer is never invoked by the request pipeline. It is reachable only from
`router.prerender()` and `onRevalidate`. A miss on an on-demand route behaves
exactly like today's `pr + miss` — `pt` alone decides whether a live handler
runs. Without this rule, a miss turns into render-during-request, with the
thundering-herd problems this design deliberately pushes out to queues and
Durable Objects.

Server actions take the same path on a plain on-demand route, and you might ask
why they read a store at all, since an action re-render normally runs fresh. A
plain `Prerender` route has no live handler to run (it was evicted, or for an
on-demand route it is gated), so an action re-render that skipped the overlay
404'd an overlay-only param in production and served the older build payload
for a baked one. The overlay is read on actions too; Passthrough routes still
re-render live. An overlay hit on an action re-sends the route's own segments
(`yieldFromStore`'s `replaceable` flag, mirroring the live
`action:route-segment` default) instead of keeping the client's copy, so an
action that awaits `router.prerender()` for the page shows the new entry in
its own re-render. The immutable bundled manifest keeps the client's copy as
before.

| Request finds                     | `Prerender(..., { onDemand })`                             | `Passthrough(def, live)`                   |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| fresh overlay entry               | the overlay entry, loaders fresh (dev and production)      | same                                       |
| stale overlay entry               | the overlay entry; `onRevalidate` scheduled if configured  | same                                       |
| "removed" marker                  | 404 (dev and production); the build entry is not served    | the live handler (dev and production)      |
| no overlay entry, param baked     | production: the build entry; dev: the dev prerender render | same                                       |
| no overlay entry, param not baked | production: 404; dev: rendered through the dev endpoint    | the live handler (dev and production)      |
| server action re-render           | overlay, then build entry, then 404, as above              | the live handler (the overlay is not read) |

### Refreshing

```txt
router.prerender(runtime)(target, options)
  |
  v
resolve target to route + params
  |
  +-- no match --> no-match
  |
  v
check on-demand route metadata
  |
  +-- not opted in --> the warm path (prerender-every-route.md)
  |
  v
search or hash on the target --> skipped-unsupported-target
  |
  v
resolve env-scoped writable store
  |
  +-- no store --> no-store
  |
  v
run requestless prerender producer
  |
  +-- personalized --> skipped-personalized
  +-- notFound() --> write the "removed" marker --> removed (no warm)
  +-- render failed --> render-failed
  |
  v
write durable entry
  |
  +-- write failed --> store-failed
  |
  v
rendered
  |
  v
app cache store shared, and an origin resolves?
  |
  +-- yes --> one warm request on top of the new entry (result.caches)
```

If a write fails, keep the previous durable entry and the bundled manifest
fallback. The refresh operation should be replace-on-success.

`prerender.remove(target)` takes the same steps up to the store and then
writes the marker instead of running the producer. A route that is not opted
in is `skipped-not-on-demand` there, never a warm. With `onlyIfStale`, a
refresh that finds a marker stops before the producer and reports `removed`.

## Dev Mode

`router.prerender()` has to work in dev, because every e2e suite in this repo
runs dev and production. Dev uses the same code path with a default in-memory
writable store, zero config. The producer context's `dev` flag reflects Vite
dev mode, the same meaning `BuildContext.dev` has. The existing dev serve path
(`__PRERENDER_DEV_URL` fetching `/__rsc_prerender`) stays as the layer below
the in-memory overlay, mirroring production's overlay -> manifest order. A
"removed" marker in the overlay answers 404 in dev as it does in production
(see "Removing A Page").

## SWR And Queues

SWR is a scheduling policy, not a serving policy. A stale overlay entry serves
either way (it is newer than anything below it); configuring `onRevalidate` is
what makes the serve path schedule it on a stale hit:

```ts
createRouter({
  prerender: (env, ctx) => ({
    store: createKVPrerenderStore(env.PRERENDER_KV),
    onRevalidate: (target, env) => env.PRERENDER_QUEUE.send({ target }),
  }),
});
```

Within one isolate the router dedups for you: a key with an `onRevalidate` in
flight is not scheduled again until that task settles (or 15 s pass), so a hot stale page on
a single Node process renders once, not once per request. Across isolates it
cannot help. For Cloudflare, queue-native dedup or a Durable Object should own herd control.
KV is eventually consistent, so a KV lock alone is not enough to prevent a burst
of refresh jobs.

For Vercel, the same public API should work from a cron route, queue consumer,
workflow step, or webhook route. The only platform-specific piece is the store
adapter.

## Examples

### Cloudflare scheduled refresh

```ts
export default {
  fetch: router.fetch,

  async scheduled(_event, env, ctx) {
    const products = await env.CMS.listRecentlyChangedProducts();
    ctx.waitUntil(
      router.prerender({ env, ctx }).many(
        products.map((product) => ({
          route: "products.detail",
          params: { id: product.id },
        })),
        { concurrency: 4 },
      ),
    );
  },
};
```

### Cloudflare queue consumer

```ts
export default {
  fetch: router.fetch,

  async queue(batch, env, ctx) {
    const targets = batch.messages.map((message) => message.body.target);
    ctx.waitUntil(
      router.prerender({ env, ctx }).many(targets, { concurrency: 8 }),
    );
  },
};
```

### Webhook endpoint

```ts
export async function POST(request: Request, env: Env, ctx: ExecutionContext) {
  await verifyWebhook(request, env.WEBHOOK_SECRET);

  const { productId } = await request.json();
  const result = await router.prerender({ env, ctx })(
    { route: "products.detail", params: { id: productId } },
    { throwOnError: true },
  );

  return Response.json(result);
}
```

### Server action

```ts
"use server";

export async function updateProduct(id: string, formData: FormData) {
  const ctx = getRequestContext();
  await ctx.env.CMS.updateProduct(id, formData);

  ctx.waitUntil(
    router.prerender({ env: ctx.env, ctx: ctx.executionContext })({
      route: "products.detail",
      params: { id },
    }),
  );
}
```

The action's current request is not the prerender input. The prerender producer
gets env and execution capability, not user cookies or headers. Scheduling the
refresh with `waitUntil` returns the action sooner; awaiting
`router.prerender()` runner instead makes the action's own re-render of that page show
the new entry (an overlay hit on an action re-sends the route's segments).

## Why Not Reuse The Live Request?

Because the store key is route plus params. If a producer reads cookies,
authorization headers, geo, AB-test headers, or user-specific middleware vars,
the rendered payload would be shared with every later visitor for that route.

The nice API should not come with a cross-user leak footgun. A running request may
schedule prerender work, but it must not become the data source for that work.

## Why Not Make Passthrough The API?

`Passthrough()` is a fallback contract. It says "when the build artifact misses,
run this live handler."

On-demand prerender is a persistence contract. It says "this route may write a
shared durable payload that will short-circuit the live handler on future
requests."

Those can compose, but they should not be the same opt-in. `Passthrough()` alone
should keep meaning live fallback. `Prerender(..., { onDemand })` is the explicit
signal that the route's prerender output may be refreshed and shared at runtime.

## Why Not Reuse The Runtime Cache?

Runtime `cache()` and prerender have different contracts:

- Runtime cache keys can include host, search params, custom key generators, and
  route cache policy.
- Prerender keys are route-name plus params plus variant.
- Runtime cache participates in `updateTag()` / `revalidateTag()`, which
  require an ALS request context and silently no-op from queue and cron
  callers — exactly the triggers prerender invalidation exists for.
- Prerender is served before runtime cache lookup and has its own immutable
  build-manifest fallback.

The durable prerender overlay can reuse serialization helpers and store ideas,
but it should have its own API and invalidation namespace.

## Phased Implementation

1. Add `WritablePrerenderStore`, the stored-entry envelope, durable store
   adapters, and versioned keys.
2. Add route metadata for `onDemand` and retain producer code only for opted-in
   routes.
3. Replace the prerender store singleton with per-request/per-call store
   resolution.
4. Add the durable overlay read path before bundled manifest lookup.
5. Add `router.prerender(runtime)` returning a runner called per target, with
   result objects and requestless producer semantics.
6. Add the runner's `.many()` and `.markStale()`.
7. Add SWR scheduling and platform adapters for Cloudflare and Vercel.
8. Add optional build-time durable seeding via `buildEnv`.

## Test Requirements

This touches public routing semantics, cache lookup, and deployed runtime
behavior. Coverage should include:

- Unit tests for target resolution, route opt-in, result statuses, versioned key
  generation, and store failures.
- A multi-version key-scoping test: entries written under a previous version
  are not served after a server-code deploy, and are after a client-only one.
- A param-collision test pinning the router-side verify-on-read behavior.
- Userland tests through public testing primitives so consumers can test code
  that calls `router.prerender()`: `createMemoryPrerenderStore` from
  `@rangojs/router/testing`, and `serveShellRequest` from
  `@rangojs/router/testing/flight` to serve the refreshed entry through the
  production request handler (`testing/__tests__/on-demand-prerender.rsc-test.tsx`).
  `dispatch` cannot serve it: it renders response routes only and throws on a
  component route, and the overlay is read in the RSC match pipeline.
- E2E for server actions on plain on-demand routes: an action on an
  overlay-only page, and `router.prerender()` inside the action.
- Removing a page: the marker's shape and validation, including the frozen
  pre-marker validator (`memory-prerender-store.test.ts`); the two writers
  and every refusal (`create-prerender-trigger.test.ts`); the serve path with
  a build-time entry under the marker (`cache-lookup-prerender-removed.test.ts`);
  the gate in dev (`urls/__tests__/on-demand-producer-gate.test.ts`); the
  userland flow and what the runtime caches serve
  (`testing/__tests__/on-demand-prerender-remove.rsc-test.tsx`); and in a
  browser, dev and production in both apps, a baked and an unbaked param
  removed both ways, an action on a removed page, and a `Passthrough` route
  (`expectRemoved*` in `tests/shared-e2e`).
- E2E tests in both dev and production for the e2e test app and the Cloudflare
  basic app.
- Production tests proving a durable entry serves through the prerender store
  and loaders still run fresh.
- Safety tests proving cookies, headers, response mutations, and personalized
  request state are not persisted.
- Bundle tests proving only `onDemand` routes retain producer code.

The semantic matrix should stay green. If on-demand prerender changes middleware
scope, handler ordering, context visibility, or PE/JS parity, update the matrix
and `docs/internal/execution-model.md` in the same PR.

## Open Questions

- Should `onDemand: true` retain producer code in the main worker bundle, or
  should the first implementation emit a separate producer entry for queues and
  workflows? Leaning: main bundle for v1 — the eviction-skip mechanism makes it
  cheap and the bundle test guards the cost; a separate producer entry is a
  Vite-plugin project of its own.
- Should direct URL targets be allowed to render params not returned by
  `getParams()`, or should routes opt into that with `onDemand.dynamicParams`?
- Enumeration-scoped vars: v1 is decided — direct renders get only route params
  and env, and a handler that depends on `getParams().set(...)` vars throws
  under direct render, which is the route author's signal to remove the
  dependency. The open part is whether any real route ever needs an explicit
  vars-passing API instead.
