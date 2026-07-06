# On-demand prerender

**Status:** Proposed. This doc sketches the target API and the safety rules for
ISR-style prerender refresh from a running app.

Start from the existing prerender mental model: prerendering is a build-time
cache the worker reads on every request — never static files served from
assets. Since producer B (#699), a prerendered route can carry two build
artifacts: the B-segment Flight payload in the bundled prerender manifest and,
when the route also declares the `ppr` path option, a whole-document shell
entry (HTML prelude + postponed state) in the shell manifest. On-demand
prerender adds a writable durable overlay in front of the prerender manifest
and a public method for refreshing entries from fetch, cron, queues, workflows,
webhooks, and server actions.

The overlay stores B-segment payloads only. Shells are derived caches that
must converge to the overlay after a refresh — without the coupling rules in
PPR Shells And Document Convergence, a refresh on a `ppr` route updates
client-side navigations while document loads serve old baked HTML over new
Flight data, which is divergence, not staleness.

The DX goal is deliberately small:

```ts
await router.prerender("/products/42", { env, ctx });
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
    ctx.waitUntil(router.prerender("/products/42", { env, ctx }));
  },

  async queue(batch, env, ctx) {
    ctx.waitUntil(
      router.prerender.many(
        batch.messages.map((message) => message.body.target),
        { env, ctx, concurrency: 4 },
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
    defaultTtl: 3600,
    swr: true,
    onRevalidate: (target, env) => env.PRERENDER_QUEUE.send({ target }),
  }),
});
```

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

`onRevalidate` receives the typed target (`{ route, params }`, kept
JSON-serializable so it can go straight into a queue message) and the live env.

TTL resolves route `onDemand.ttl` > router `defaultTtl` > never stale, and it
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
overrides them per route.

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
carries `concurrency`). Two implementation constraints follow. Retention
piggybacks on the existing eviction mechanism: handler eviction is a
post-bundle pass that already skips a names set for Passthrough handlers
(`src/vite/utils/bundle-analysis.ts`), so discovery emits an
`onDemandRouteNames` set and eviction skips those exports the same way. That in
turn means `onDemand` must be statically detectable in the `Prerender()` call
at discovery time — a literal in the options object, not a computed value.

`onDemand` composes with the `ppr` path option the same way `Prerender()`
already does (#697): the route keeps its build-time document shell, and
refresh couples to that shell through tags. For the coupling to work,
`onDemand.tags` must produce the same values the shell carries — recorded by
`cacheTag()` during capture or declared in the `ppr` option — see PPR Shells
And Document Convergence. A `Prerender` + `ppr` route that opts into
`onDemand` without tags should warn at build time: its documents can only
converge on `ppr.ttl`.

Plain `Prerender()` remains build-only and can still be evicted from production
bundles. `Passthrough()` alone is not an on-demand opt-in. If a `Passthrough()`
route should become refreshable, the wrapped `Prerender()` definition still needs
`onDemand`.

That rule prevents a semantic surprise: `Passthrough()` currently means "live
fallback on prerender miss." Once a durable prerender entry exists for a param
set, the live handler stops running for that param set until the entry is
deleted or refreshed. That is fine when explicit; it is not fine as an accidental
consequence of making a route a fallback.

### Trigger API

The main primitive accepts a URL-like target and runtime bindings:

```ts
await router.prerender("/products/42", { env, ctx });
await router.prerender(new URL("https://shop.test/products/42"), { env, ctx });
```

The typed form avoids string construction and should be the preferred API in app
code that already has route names. This object target is a new convention —
nothing accepts `{ route, params }` today; the existing named-route API is
`reverse(name, params)`, which returns a string. Its typing should derive from
`routeMap` the same way `reverse` does, and `router.reverse()` output composes
for free, since string targets are accepted:

```ts
await router.prerender(
  { route: "products.detail", params: { id: "42" } },
  { env, ctx },
);
```

Batching is first-class because queue and workflow consumers should not have to
write their own concurrency limiter:

```ts
await router.prerender.many(
  productIds.map((id) => ({ route: "products.detail", params: { id } })),
  { env, ctx, concurrency: 4 },
);
```

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

Invalidation is deliberately namespaced under prerender so it does not look like
the existing runtime cache tag API:

```ts
await router.prerender.invalidateTags(["product:42"], { env, ctx });
```

The existing `updateTag()` / `revalidateTag()` APIs remain runtime-cache APIs.
They already reach further than the item cache — both funnel into store-level
`invalidateTags()`, whose markers also evict PPR shells
(`src/cache/tag-invalidation.ts`; marker checks in
`src/rsc/shell-build-manifest.ts`) — but they must not silently mutate durable
prerender entries: neither the overlay nor the bundled manifest. There is a
second reason for the separate API beyond namespacing: `updateTag()` /
`revalidateTag()` require an ALS request context and silently no-op from queue
and cron callers (`src/cache/tag-invalidation.ts`). Prerender invalidation must
work from exactly those triggers, which is why it takes explicit `{ env, ctx }`.

V1 invalidation is mark-stale, not delete. The entry keeps serving and a
refresh is scheduled. Deleting would re-expose the bundled manifest entry below
it — older content presented as the result of an "invalidation." A tombstone
mode ("stop serving this now": mask the manifest, fall through to live or miss)
is a real second intent, but it is deferred; see Store Model.

On a `ppr` route, `router.prerender.invalidateTags()` — and a successful
`router.prerender()` refresh, via the route's resolved `onDemand.tags` — also
writes the app cache store's tag-invalidation markers, because shells carrying
those tags must stop serving baked content (see PPR Shells And Document
Convergence). Markers are per-tag and family-agnostic in every store
implementation, so this carries the same blast radius `updateTag()` has today:
runtime `cache()` entries with the same tags are evicted too. The full family
matrix:

| API                                 | runtime cache entries        | PPR shells (captured + baked) | prerender overlay | bundled prerender manifest |
| ----------------------------------- | ---------------------------- | ----------------------------- | ----------------- | -------------------------- |
| `updateTag()` / `revalidateTag()`   | evicted                      | evicted / refused             | untouched         | untouched (immutable)      |
| `router.prerender.invalidateTags()` | evicted (shared markers)     | evicted / refused             | marked stale      | untouched (immutable)      |
| `router.prerender(target)`          | evicted via the route's tags | evicted / refused             | replaced          | untouched (immutable)      |

### Result object

The method should not force every trigger into try/catch. By default it returns
an inspectable result:

```ts
type PrerenderResult =
  | {
      ok: true;
      // "already-fresh" only occurs with onlyIfStale: true
      status: "rendered" | "already-fresh";
      target: string;
      routeName: string;
      // opaque, for debugging and logs only -- not a stable format
      key: string;
      tags: string[];
      ttl?: number; // absent = never stale
    }
  | {
      ok: false;
      status:
        | "no-match"
        | "no-store"
        | "skipped-not-on-demand"
        | "skipped-personalized"
        | "skipped-unsupported-target"
        | "render-failed"
        | "store-failed";
      target: string;
      routeName?: string;
      error?: unknown;
    };
```

`throwOnError: true` is useful for admin endpoints and CI-like workflows:

```ts
await router.prerender("/products/42", {
  env,
  ctx,
  throwOnError: true,
});
```

`many()` returns one result per target and should not stop the whole batch unless
`throwOnError` is set.

## Producer Semantics

The producer is requestless. This is the most important safety rule.

The producer is also segments-only: it renders the B-segment payload and never
produces a document shell. Shell production spans the SSR realm (Fizz
prerender/resume) and already has a guarded, request-driven owner at runtime;
documents converge through recapture instead — see PPR Shells And Document
Convergence.

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

The producer renders the complete main-route tree, not a partial navigation
(and not a document shell — that word is reserved for the PPR artifact here).
It must resolve the same route/layout/parallel shape that a build-time
prerender entry would store, then leave loader data to the normal prerender
hit path. The
producer core is `matchForPrerender` running in the deployed RSC runtime — the
same segment resolution the build and the dev `/__rsc_prerender` endpoint
already use. Flight-encoding at runtime has precedent: the runtime cache
serializes segments per request today.

One env caveat: `BuildContext.env` is `buildEnv` — shared, build-scoped, and
throwing when unconfigured. The on-demand producer's `env` is the live trigger
binding. Same handler, two env provenances: a handler that relies on build-only
bindings will behave differently under refresh. That is acceptable, but it is a
route-author-visible difference and belongs in the public docs.

The requestless construction has an in-tree precedent now: producer B captures
build-time shells under a synthetic request context created via
`createRequestContext` over the build env, with no ambient identity
(`src/prerender/build-shell-capture.ts`). The on-demand producer is the same
construction over the live trigger env.

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

Shell entries are deliberately not part of the overlay. A `ShellCacheEntry`
(base64 prelude, postponed state, capture snapshot, `buildVersion`, tags —
`src/cache/types.ts`) lives in the app cache store's shell family and in the
build shell manifest, and stays there; the overlay never stores or serves one.

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

## PPR Shells And Document Convergence

Producer B (#699) changed what "prerendered" means for a route that also
declares the `ppr` path option: besides the B-segment payload, the build emits
a complete document shell — a `ShellCacheEntry` (base64 HTML prelude, React
postponed state, capture snapshot, `buildVersion`, tags; `src/cache/types.ts`)
staged behind a pathname-keyed shell manifest
(`src/vite/discovery/shell-prerender-phase.ts`). At serve time the shell gate
runs before the match pipeline: runtime shell store first, then the build
manifest read-through (`lookupBuildShell` in
`src/rsc/shell-build-manifest.ts`), both gated on `reactVersion`,
`buildVersion`, payload integrity, and tag markers. Runtime recapture writes
the runtime store, which supersedes the baked entry — SWR is the upgrade path.

The overlay cannot reach a served shell's HTML. On a shell HIT the prelude
bytes commit immediately, and the outlined-bake guarantee (#702/#703) puts
every ready piece of route content in those bytes — only masked holes resolve
in the tail. The tail's fresh Flight payload does read the prerender store
(shell capture and shell serve both replay baked segments through
`withCacheLookup`; producer B asserts the store was consulted — `fetchedKeys`
in `src/vite/discovery/shell-prerender-phase.ts`), so after an overlay refresh
a shell HIT serves old committed HTML with new Flight data behind it.
Depending on where the changed content sits, that is a hydration mismatch or a
visible old-to-new swap — divergence, not freshness. Client-side navigations,
which skip the shell gate entirely, serve the new content cleanly.

Two consequences pin the design:

1. **The overlay is the source of truth; shells are derived caches.** Every
   capture — build-time producer B and runtime recapture alike — replays the
   prerender store, so any capture that runs after a refresh bakes the
   overlay's content. Convergence is only a question of when the next capture
   happens.
2. **Shell convergence is part of the refresh write, not an optimization.** A
   successful `router.prerender()` on a `ppr` route must invalidate the
   route's shell before returning `rendered`; skipping it does not merely
   delay freshness, it ships divergent prelude/Flight pairs.

The convergence mechanism is tags, and it needs no new store surface:

1. **Tags (the refresh-coupled path).** After a successful overlay write,
   `router.prerender()` resolves the target's `onDemand.tags` and writes the
   app cache store's tag-invalidation markers — the store-level
   `invalidateTags()`, callable without an ALS request context, on the store
   resolved from the trigger's `{ env, ctx }` the same way the RSC handler
   resolves it. Runtime-captured shells with those tags are evicted; baked
   shells are refused by the read-through's
   `isTagsInvalidatedSince(tags, entry.createdAt)` check. The next document
   request misses the shell gate, renders axis-1 through the pipeline —
   reading the fresh overlay — and schedules a background recapture that bakes
   the overlay content into a new runtime shell. One shell-miss render buys
   immediate, coherent document freshness.
2. **`ppr.ttl` staleness (the uncoupled fallback).** A stale shell HIT still
   serves but schedules a recapture, and the recapture reads the overlay. A
   route with no tags converges within its `ppr.ttl` (default 300 seconds,
   `DEFAULT_PPR_TTL_SECONDS` in `src/rsc/shell-serve.ts`) — never immediately,
   and with the divergence window above until it does. That is why a tagless
   `onDemand` + `ppr` route warrants a build-time warning.

For the coupling to work the tags must actually match: a shell's tags are
recorded during capture (`cacheTag()` during render, or the `ppr` option's
`tags`), while `onDemand.tags` resolves from a target without rendering. V1
keeps them as two declarations; unifying them is an open question.

The refresh producer never writes a shell. Shell production spans the SSR
realm (Fizz prerender/resume), and the runtime already owns a guarded,
request-driven capture path — nested-thenable masking, identity guard,
write-barrier ordering (`src/rsc/shell-capture.ts`). Producer B's synthetic
requestless context is the precedent for a direct requestless shell producer
at runtime; that is deferred — see Open Questions.

Deploy semantics already line up: the shell serve gate requires an exact
`buildVersion` match (`isValidShellHit`, `src/rsc/shell-serve.ts`), so a new
deploy retires every shell at the same moment overlay reads move to the new
build's key namespace.

## Store Model

The existing production store is a read-only manifest. On-demand prerender needs
a writable durable overlay:

```ts
interface WritablePrerenderStore {
  get(
    key: PrerenderKey,
    meta: PrerenderLookupMeta,
  ): Promise<PrerenderStoredEntry | null>;

  set(
    key: PrerenderKey,
    entry: PrerenderEntry,
    options: PrerenderSetOptions,
  ): Promise<void>;

  delete?(key: PrerenderKey): Promise<void>;
  invalidateTags?(tags: string[]): Promise<void>;
}
```

The `get()` / `set()` asymmetry is deliberate: `set()` takes the raw
`PrerenderEntry` plus options, and the store composes them into a versioned
envelope that `get()` returns:

```ts
interface PrerenderStoredEntry {
  v: 1;
  entry: PrerenderEntry;
  meta: {
    storedAt: number;
    staleAt?: number; // absent = never stale
    tags: string[];
    buildVersion: string;
    params: Record<string, string>; // verified against the request on read
  };
}
```

Two rules follow from the envelope:

- TTL is `staleAt`, soft metadata — never a hard store expiry like KV
  `expirationTtl`. Hard expiry deletes the very entry SWR needs to serve stale,
  and worse, an expired overlay falls back to the bundled manifest, which is
  older content than what just expired.
- `meta.params` exists because the key hash is 8-hex DJB2 with a documented
  32-bit collision caveat (`src/prerender/param-hash.ts`). At build time a
  collision is detectable inside one process; with runtime writes keyed off
  webhook-supplied params, a collision silently serves one page's content under
  another's URL. Verify-on-read is the cheap fix; a stronger hash for durable
  keys is the alternative.

The new interface is also the chance to fix a known leaky seam: today's
`PrerenderStore.get()` advertises a `meta` contract that only the dev store
honors. `PrerenderLookupMeta` should be an explicit contract every
implementation honors, or it should not exist.

The read path should be:

```txt
durable overlay -> bundled build manifest -> miss/live fallback
```

A stale overlay hit is still a hit. The overlay is always newer than the build
artifact below it, so staleness never changes what is served — it only controls
whether a refresh gets scheduled (see SWR And Queues).

The durable overlay must not memoize misses for the lifetime of an isolate.
Queues, workflows, and webhooks can refresh a key after a previous request
missed it. Note the trap: today's production store memoizes every result —
including nulls — in a per-isolate `Map` forever (`src/prerender/store.ts`),
which is correct for the immutable manifest and wrong for the overlay. Bounded
negative caching (a few seconds) is fine, and worth having so on-demand routes
that were never refreshed do not pay a store read per request forever.

Keys must include the deployment identity:

```txt
prerender:{routerId}:{buildVersion}:{routeName}:{paramHash}
prerender:{routerId}:{buildVersion}:{routeName}:{paramHash}:i
```

The build version prevents a new deployment from reading old Flight payloads
that refer to previous client references or chunks. The store may keep old
build versions for rollback, but reads for the current app must be scoped to
the current build. The identity already exists: the `@rangojs/router:version`
build stamp (`src/vite/plugins/version-plugin.ts`, surfaced as `ctx.version`)
— the same value the shell serve gate compares in `isValidShellHit`
(`src/rsc/shell-serve.ts`). Reusing it means the overlay and every shell
retire in lockstep on deploy.

One constraint on `{routerId}`: it must be realm-stable. The router `$$id`
hashes `filePath:lineNumber` of transformed source, which differs between a
build realm and the shipped worker — the shell manifest keys by pathname for
exactly that reason (`src/prerender/shell-manifest-key.ts`). A runtime-only
overlay writes and reads in one realm, so `$$id` would happen to work — until
build-time durable seeding (below) writes from the build realm and every
seeded key misses forever. The discriminator must be a stable user-visible
router name, never `$$id`.

Two consequences worth stating out loud:

- Every deploy starts with an empty overlay. All on-demand freshness resets to
  the bundled manifest until entries are refreshed again; build-time durable
  seeding (below) is the mitigation.
- Cloudflare gradual deployments become correct for free: old and new worker
  versions serving concurrently each read their own build-scoped namespace.

The first adapter should reuse the `CFCacheStore` machinery rather than start a
fresh KV store: it already has durable get/set/delete, a working
`invalidateTags` via KV tag markers, version- and host-namespaced keys, and an
L1 Cache API + L2 KV layout (`src/cache/cf/cf-cache-store.ts`). Tag indexing on
eventually consistent KV is genuinely fiddly; the tag-marker approach is the
already-solved version of it.

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

Two lanes serve a prerendered route. A document GET on a `ppr` route hits the
shell gate before the match pipeline; everything else — RSC navigation
requests, documents on non-`ppr` routes — goes straight to the pipeline, where
`withCacheLookup` consults the overlay.

```txt
document GET on a ppr route
  |
  v
shell gate (before the pipeline, src/rsc/rsc-rendering.ts)
  |
  +-- runtime shell store hit --> serve prelude + tail
  |                               (prelude bytes frozen at capture; the tail
  |                                reads the overlay, so a refreshed overlay
  |                                diverges from the baked HTML -- see PPR
  |                                Shells And Document Convergence)
  |
  +-- build shell manifest hit --> same serve path, same caveat
  |
  v
shell miss (or tag-refused / version-refused entry)
  --> axis-1 render through the pipeline below (reads the overlay)
      + background shell recapture (also reads the overlay)
```

The pipeline lane is where the overlay lives:

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
lookup durable overlay by build-scoped key
  |
  +-- fresh hit --> yieldFromStore(entry), then resolve loaders fresh
  |
  +-- stale hit --> serve it the same way;
  |                 swr: schedule onRevalidate via waitUntil
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

### Refreshing

```txt
router.prerender(target, runtime)
  |
  v
resolve target to route + params
  |
  +-- no match --> no-match
  |
  v
check on-demand route metadata
  |
  +-- not opted in --> skipped-not-on-demand
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
  +-- render failed --> render-failed
  |
  v
write durable entry
  |
  +-- write failed --> store-failed
  |
  v
ppr route? write the route's tag markers so shells converge
(see PPR Shells And Document Convergence)
  |
  v
rendered
```

If a write fails, keep the previous durable entry and the bundled manifest
fallback. The refresh operation should be replace-on-success.

## Dev Mode

`router.prerender()` has to work in dev, because every e2e suite in this repo
runs dev and production. Dev uses the same code path with a default in-memory
writable store, zero config. The producer context's `dev` flag reflects Vite
dev mode, the same meaning `BuildContext.dev` has. The existing dev serve path
(`__PRERENDER_DEV_URL` fetching `/__rsc_prerender`) stays as the layer below
the in-memory overlay, mirroring production's overlay -> manifest order.

The document lane has dev parity too: producer B runs on demand via the
`/__rsc_shell` endpoint below the runtime shell store
(`src/rsc/shell-build-manifest.ts`), so shell convergence after a dev refresh
behaves like production.

## SWR And Queues

SWR is a scheduling policy, not a serving policy. A stale overlay entry serves
either way (it is newer than anything below it); `swr: true` controls whether
the serve path schedules `onRevalidate` on a stale hit:

```ts
createRouter({
  prerender: (env, ctx) => ({
    store: createKVPrerenderStore(env.PRERENDER_KV),
    swr: true,
    onRevalidate: (target, env) => env.PRERENDER_QUEUE.send({ target }),
  }),
});
```

Shells have their own scheduler: `ppr.ttl` marks a shell stale, and a stale
shell HIT schedules a recapture that reads the overlay. The overlay's `swr`
controls only `onRevalidate` for B-segment entries. The two compose in one
direction: a refresh triggered by `onRevalidate` converges documents through
the same tag-marker path as any other refresh.

For Cloudflare, queue-native dedup or a Durable Object should own herd control.
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
      router.prerender.many(
        products.map((product) => ({
          route: "products.detail",
          params: { id: product.id },
        })),
        { env, ctx, concurrency: 4 },
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
    ctx.waitUntil(router.prerender.many(targets, { env, ctx, concurrency: 8 }));
  },
};
```

### Webhook endpoint

```ts
export async function POST(request: Request, env: Env, ctx: ExecutionContext) {
  await verifyWebhook(request, env.WEBHOOK_SECRET);

  const { productId } = await request.json();
  const result = await router.prerender(
    { route: "products.detail", params: { id: productId } },
    { env, ctx, throwOnError: true },
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
    router.prerender(
      { route: "products.detail", params: { id } },
      { env: ctx.env, ctx: ctx.executionContext },
    ),
  );
}
```

The action's current request is not the prerender input. The prerender producer
gets env and execution capability, not user cookies or headers.

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

One deliberate exception: PPR shells live in the runtime cache store's shell
family, and shell convergence rides that store's tag markers. The overlay
stays a separate store; the coupling is markers-only.

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
5. Add `router.prerender(target, runtime)` with result objects and requestless
   producer semantics.
6. Couple refresh to document convergence: post-write tag-marker invalidation
   for `ppr` routes and the build-time warning for tagless `onDemand` + `ppr`
   routes.
7. Add `router.prerender.many()` and `router.prerender.invalidateTags()`.
8. Add SWR scheduling and platform adapters for Cloudflare and Vercel.
9. Add optional build-time durable seeding via `buildEnv`.

## Test Requirements

This touches public routing semantics, cache lookup, and deployed runtime
behavior. Coverage should include:

- Unit tests for target resolution, route opt-in, result statuses, versioned key
  generation, and store failures.
- A multi-build key-scoping test: entries written under a previous
  buildVersion are not served after a deploy.
- A param-collision test pinning the verify-on-read behavior.
- Userland tests through public testing primitives so consumers can test code
  that calls `router.prerender()` — likely an in-memory
  `WritablePrerenderStore` fake exported from `@rangojs/router/testing`, plus
  whatever `dispatch` needs to serve from it.
- E2E tests in both dev and production for the e2e test app and the Cloudflare
  basic app.
- Production tests proving a durable entry serves through the prerender store
  and loaders still run fresh.
- Document-convergence tests for `ppr` routes covering both shell artifact
  types (runtime-captured and build-baked): after a refresh, the next document
  load misses the shell gate and serves the new content, and the recaptured
  shell bakes the overlay payload.
- A navigation-vs-document parity test: an RSC navigation request serves the
  refreshed overlay immediately, and the document lane converges instead of
  shipping old prelude HTML over new Flight data.
- A tagless `ppr` route test pinning ttl-bounded convergence: the stale shell
  keeps serving until `ppr.ttl` elapses, then the recapture bakes the refreshed
  overlay content.
- A family-matrix test pinning the invalidation table: `updateTag()` evicts
  shells but never mutates overlay entries; `router.prerender.invalidateTags()`
  marks overlay entries stale and writes the shared shell markers.
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
- Should a later version produce shells directly from triggers? Producer B's
  synthetic requestless context (`src/prerender/build-shell-capture.ts`) is the
  precedent, but shell production spans the SSR realm and the request-driven
  recapture path already owns the guards. V1 pins recapture-only.
- Should `onDemand.tags` and the shell's tags (`cacheTag()` / the `ppr`
  option's `tags`) become one declaration? V1 keeps two: shell tags are
  recorded during render, `onDemand.tags` resolves from a target without
  rendering.
- Does `router.prerender.invalidateTags()`'s marker blast radius (runtime
  `cache()` entries carrying the same tags are evicted too) need scoping
  machinery, or is tag-namespace discipline enough?
