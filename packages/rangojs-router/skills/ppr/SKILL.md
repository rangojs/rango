---
name: ppr
description: PPR shell caching — serve a cached HTML shell instantly and resume live loader holes (createShellCacheMiddleware)
argument-hint: "[setup]"
---

# PPR Shell Caching

Caches the rendered HTML **shell** of a route (React `prerender` prelude bytes
plus `postponed` state) and, on a later request, flushes those bytes before any
render work happens, then resumes fizz for just the live loader holes. The
browser sees one ordinary streamed document; loaders stay fresh on every
request. This is the second render axis — the default axis-1 path is untouched,
and every ineligible request falls open to it.

Compare `/document-cache`, which freezes the WHOLE response including loader
output. Shell caching is for pages that mix a stable shell with live data: the
shell is shared per host+URL, the holes are per request.

## Setup

The middleware needs a store that implements the shell family
(`getShell`/`putShell`): `MemorySegmentCacheStore` (dev/tests), `CFCacheStore`
(Cloudflare KV), or `VercelCacheStore` (runtime cache). It defaults to the
app-level store from `createRouter({ cache })`; a store without the family
disables the middleware (fail-open to axis 1).

```typescript
import { createRouter } from "@rangojs/router";
import {
  createShellCacheMiddleware,
  CFCacheStore,
} from "@rangojs/router/cache";
import { urlpatterns } from "./urls";

const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  cache: (env, ctx) => ({
    store: new CFCacheStore({ kv: env.CACHE_KV, ctx: ctx! }),
  }),
});

// Path-scoped: only the routes that fit the shell/hole shape below.
router.use(
  "/products",
  createShellCacheMiddleware({ ttlSeconds: 600, swrSeconds: 120 }),
);

export default router;
```

## Where PPR sits: the cache onion

Rango's caches layer like an onion — each ring stores a progressively more
"cooked" representation of the same page, and PPR is a new ring, not a
replacement for any existing one. From innermost (raw values) to outermost
(final bytes):

| Ring                    | Primitive                                | What is stored                                     | What stays live on a hit               |
| ----------------------- | ---------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| 1. Function values      | `"use cache"`                            | a function's return value                          | everything around the call             |
| 2. Loader values        | `loader(Fn, () => [cache({...})])`       | one loader's result (opt-in; loaders default live) | all other loaders, handlers, rendering |
| 3. Segments (Flight)    | `cache()` route / build-time `prerender` | serialized rendered segments + replayed handles    | loaders, HTML render                   |
| 4. **HTML shell (PPR)** | `createShellCacheMiddleware`             | rendered prelude bytes + React postponed state     | loaders (the holes), hydration payload |
| 5. Whole response       | `/document-cache`                        | final response bytes, headers included             | nothing — all-or-nothing               |

Each ring is derived from the ones inside it, and PPR makes that literal:
the captured shell is the fizz render of ring 3's replayed segments, which is
why shell/payload consistency holds by construction on `cache()` routes. The
rings compose in one request: a HIT serves ring 4's bytes instantly, the
resume pass replays ring 3's segments for the hydration payload, a hole's
loader may consult ring 2, and a component inside it may consult ring 1.

The onion also explains the boundary with ring 5: the document cache freezes
loaders too (no holes, coarser but simpler), which is why stacking both on
one route is pointless — pick the outermost ring whose "stays live" column
matches the route (see Pitfalls).

Invalidation crosses rings: `invalidateTags` reaches segment, shell, loader,
and item entries in the same store, and shell entries additionally
self-invalidate on `React.version` change. TTL/SWR are per-ring — an inner
ring's shorter TTL shows through a hole immediately (loaders are live), but
shell-embedded content refreshes only on the shell's own recapture.

## Creating holes: I want X → do Y

A shell-cached route is a stable shell with live **holes** punched through it.
Everything hinges on where the hole is, and the hole is always a route-level
`loading()` boundary. Start here:

| I want…                                                                                    | Do this                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live per-request data in the page                                                          | a route `loader()` **+ route-level `loading()`** — the loader is the hole, `loading()` is the boundary the capture postpones at and the resume stitches into                                                                            |
| A slow nested value streamed **inside** the hole                                           | return `{ outer, pendingData: Promise }` from the loader; `use(pendingData)` under the consumer's OWN inner `<Suspense>` (see "Loader-carried promises")                                                                                |
| A hole for data that is **already resolved** (in-memory, `Promise.resolve`, a cached read) | wrap it in **`live(() => …)`** under your own `<Suspense>` — masked at capture exactly like a loader, so it postpones instead of settling into the shared shell (see "live()")                                                          |
| Shell-safe, deterministic data                                                             | `await` it in a **handler** — it is shell material, frozen into the prelude                                                                                                                                                             |
| **Per-user** data                                                                          | a `loader` (masked at capture, always fresh), or **`live()`** for a boundary that is not a route loader. NEVER a handler or middleware-derived `ctx` state — those run during capture and bake into the **shared** shell (see Security) |
| A slow nested value on a route with **no** `loading()`                                     | still fine on axis 1: the tree-build await is SHALLOW, so `{ outer, pendingData }` streams the inner under the consumer's `<Suspense>` — but the route is not shell-cacheable                                                           |

The last row is the common trap: "no `loading()` blocks" does NOT mean "nested
promises can't stream". They stream today, unchanged by PPR — the route just
has no hole, so shell caching stays off for it (eternal MISS, below).

## The hole contract (read this before wiring a route)

A hole exists ONLY where the route-level `loading()` boundary separates loader
consumption from the shell. `loading()` becomes `LoaderBoundary`
(`src/route-content-wrapper.tsx`) — a `<Suspense>` whose resolver `use()`es the
loader promise INSIDE it — so the masked loader postpones exactly there and the
prelude freezes the layouts plus the fallback. Two consequences:

1. Shell material (static content, handle reads, interactive client islands)
   lives in a **layout** above the loader route.
2. The loader-consuming route below carries **`loading()`**.

```typescript
export const urlpatterns = urls(({ path, layout, loader, loading }) => [
  // Shell: header, nav, islands, handle pushes. Frozen into the prelude.
  layout(ProductShellLayout, () => [
    // Hole: the live price. Masked at capture, fresh on every serve.
    path("/products/:id", PricePage, { name: "product" }, () => [
      loader(LivePriceLoader),
      loading(<PriceSkeleton />), // the boundary capture postpones at
    ]),
  ]),
]);
```

**Why a route without `loading()` can never be a hole — even with a fast
loader.** The loading-less branch in `renderSegments` (`src/segment-system.tsx`)
awaits loader data at TREE-BUILD (`await buildLoaderPromise(...)`), above every
Suspense boundary. That await is SHALLOW — it settles only the loader's OUTER
value — but during capture the loader is masked WHOLE: `createMaskedLoaderPromise`
(`src/router/segment-resolution/loader-mask.ts`) hands back a never-resolving
promise for the entire value, so even the outer never settles. The tree-build
await pins the whole tree above `<body>`, the prelude comes back trivial, and
the sanity gate refuses to store. Observable symptom: `x-rango-shell: MISS` on
every request forever, plus a **once-per-key** worker warning you can grep for —
`produced no usable shell … without a route-level loading() boundary`
(`src/rsc/shell-capture.ts`).

Whole-loader masking is deliberate scar tissue, not a limitation to route
around. Loaders are the ONE lane exempt from the `cookies()`/`headers()` capture
guard — they always run fresh on serve — so running a loader even _partially_
during capture could bake a per-user outer field into the shared shell, breaking
freshness and the security model at once. Finer-grained masking is intentionally
not offered. A hand-rolled `<Suspense>` around a `useLoader()` reader does not
help either: the pin is at the tree-build await, which is _above_ it.

## Loader-carried promises: streaming inside a hole

A hole is not limited to one value. A loader can return its outer value fast and
carry a **nested promise** that settles later; `FlightSerialize` preserves the
`Promise` across the RSC boundary (`src/serialize.ts`), so the client `use()`es
it under its OWN inner `<Suspense>` — a second streaming layer _inside_ the hole.

```typescript
// loader — outer resolves fast; the nested promise settles later
export const StreamLoader = createLoader(async () => {
  const pendingData = new Promise<string>((r) =>
    setTimeout(() => r("slow inner value"), 300),
  );
  return { label: "fast outer value", pendingData };
});
```

```tsx
// consumer (client): use() the nested promise under an INNER Suspense
"use client";
import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";

function Inner({ promise }: { promise: Promise<string> }) {
  return <span>{use(promise)}</span>;
}

export function StreamView({ loader }: { loader: LoaderDefinition<Data> }) {
  const { data } = useLoader(loader); // resolves the OUTER value
  return (
    <>
      <div>{data.label}</div>
      <Suspense fallback={<div>loading inner…</div>}>
        <Inner promise={data.pendingData} /> {/* streams the nested value */}
      </Suspense>
    </>
  );
}
```

Route shape is unchanged: `loader(StreamLoader)` + `loading(<Skeleton />)`. On a
**HIT** the resume streams three progressive layers in one response body:

1. the cached shell prelude (layout + the `loading()` fallback) — flushed
   instantly, before any render work;
2. the outer loader value fills the hole, carrying the inner `<Suspense>`
   fallback;
3. the nested-promise inner value + React's `$RC` boundary stitch.

Capture never sees any of this: the loader is masked, so the whole subtree
postpones at `loading()` and the nested promise costs nothing at capture time.
That is what makes loader-carried promises DETERMINISTIC — contrast the
handler-passed promise below, which races the capture's quiet window. The
three-layer timeline is pinned in dev + production e2e
(`tests/cloudflare-basic/e2e/ppr-shell.test.ts`, `e2e/shell-cache.test.ts`).

One nuance: a loader with a `cache(...)` config deep-settles on write, so a
loader-cache HIT delivers the inner promise already resolved.

## live(): a deterministic hole for any boundary

`loading()` makes a route LOADER a hole. `live()` makes ANY boundary a hole —
including one whose data is already resolved. During the background capture
`live()` behaves exactly like the loader mask: it returns a never-settling
promise, so the consuming `<Suspense>` postpones and the prelude freezes only the
fallback. On the serve pass (and on the client) it is a passthrough — the thunk
runs, or the promise passes through unchanged.

```tsx
import { Suspense } from "react";
import { live } from "@rangojs/router";

async function Greeting() {
  // Promise.resolve(...) would normally SETTLE during capture and bake into the
  // shared shell. live() holds it out, so this boundary postpones instead.
  const name = await live(() => Promise.resolve(currentUserName()));
  return <span>Hi {name}</span>;
}

// under the frozen shell:
// <Suspense fallback={<span>…</span>}>
//   <Greeting />
// </Suspense>
```

Two forms:

- **Thunk (preferred): `live(() => value)`** — during capture the thunk NEVER
  runs (no fetch, no cost); the boundary is a pure hole.
- **Value: `live(promise)`** — the work already fired before `live()` saw it, so
  during capture the real promise is DISCARDED and a hole returned in its place.
  Use it only when you already hold the promise; prefer the thunk otherwise.

`live()` is what makes a resolved value a hole at all: a bare `Promise.resolve(x)`
under `<Suspense>` settles inside the capture's quiet window and freezes into the
shell. It is also the escape hatch for the passed-promise trap below. The
capture/serve split is pinned in dev + production e2e (the "live() makes a
resolved promise a HOLE" case in `tests/cloudflare-basic/e2e/ppr-shell.test.ts`
and `e2e/shell-cache.test.ts`).

## Passed promises are not holes

The pattern that looks like a hole but is not: a **handler** creates a promise
and passes it as a prop to a client component that `use()`s it inside its own
`<Suspense>`. Only route **loaders** (and `live()`) are masked at capture — a
handler and any promise it creates EXECUTE during the background capture render.
What happens next is decided by the promise's LATENCY CLASS against the
capture's quiet window (task-quantized: it closes a couple of macrotask hops
after the last Flight byte, not on a wall clock). Both sides are reliable —
just in opposite directions:

- Resolved or microtask-resolvable (`Promise.resolve`, a warm in-memory read):
  reliably SHELL, every capture — it settles in the same window as plain JSX.
  If the value is per-request, that is a deterministic bug: frozen into the
  shared shell until TTL (hydration repairs it from the fresh payload —
  degraded, not corrupt, but a drift you shipped).
- Genuinely pending real I/O: reliably a HOLE — it cannot win a task-quantized
  window. Resume fills it at serve. The capture still paid the promise's
  execution cost and side effects, though. The only nondeterministic sliver
  left is I/O completing within ~2 event-loop turns of the shell going quiet
  — freakishly fast, self-healing via TTL/recapture, and only reachable by
  code that declared no intent.

An async HANDLER (a streamed `loading()` handler returning a promise) is the
deliberate opposite: it is tracked in the handle store, and capture WAITS for
handlers to settle before aborting — handler output is shell material by
design, never a hole.

Verdict: a promise's latency class picks its side — you can safely assume a
genuinely pending, unresolved promise becomes a hole. But that decision was
made by latency, not by you. Wherever intent and latency could disagree —
per-request data that might get cache-fast, a value that must never appear in
the shared shell — say it in code: **`live()`** for a guaranteed hole (masked
at capture like a loader; prefer the thunk form so nothing runs during
capture), a loader behind `loading()` for route-level live data (zero capture
cost, and its nested promises stream too, per above), a plain `await` for
shell-safe deterministic data. Unwrapped promises are for the cases where
either outcome is acceptable.

Note on `useLoader()`: it never observes pending data. Inside a `loading()`
route, `LoaderBoundary` resolves the loader promise INSIDE its own Suspense
before children render, so `useLoader().data` (the OUTER value) is always
resolved; `isLoading` is client-side refetch state, not a server pending signal.
A nested promise on that data is separate — it streams under the consumer's own
inner `<Suspense>` (above). Multiple holes per page (several `loading()`
routes/parallels) are fine: resume fills every postponed boundary.

## Execution matrix

Three passes, three different cost profiles. The foreground request is never
blocked on the background capture.

| Phase            | MISS (foreground)      | Background capture                                              | HIT (foreground)                                            |
| ---------------- | ---------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Middleware chain | runs (full)            | **NOT re-run** — inherits the request's post-middleware context | runs (full)                                                 |
| `router.match`   | runs                   | re-runs under a derived context                                 | runs                                                        |
| Handlers         | run                    | run                                                             | run                                                         |
| Loaders          | run **fresh**          | **MASKED** (never execute)                                      | run **fresh**                                               |
| Flight render    | full                   | full                                                            | full (hydration needs the whole payload — no Flight resume) |
| HTML production  | full fizz              | `prerender` + abort → prelude + postponed                       | `resume` only the holes — O(paths to holes)                 |
| Shell store      | schedules a bg capture | `putShell(key, …)`                                              | `getShell(key)`; a stale/SWR hit also schedules a recapture |
| Prelude bytes    | —                      | —                                                               | prepended by the middleware before the resumed body         |

Loader freshness under PPR is **identical to axis 1**: loaders — the outer value
AND any nested promise — run fresh on every request, including HITs. Only the
HTML _around_ the hole came from cache. Background capture is scheduled via
`runBackground` (`waitUntil` on workerd, fire-and-forget in Node dev), so it
never delays the served response. Re-deriving through `router.match()` rather
than a second `next()` is what keeps middleware from running twice
(`src/rsc/shell-capture.ts`).

## Security

Shell caching shares one shell per host+URL across all users, so its safety
rests on three things — the first two are enforced, the third is on you.

**(a) Access control is sound.** The middleware runs on every request, including
HITs, and composition is **marker-gated**: the middleware prepends the cached
prelude ONLY when the live response carries the internal `x-rango-shell-resumed`
marker (`src/cache/shell-cache.ts`). Any middleware short-circuit — a 401, a
redirect, a 404 — never resumes, so it never carries the marker and passes
through **untouched**, never composed with a cached shell. Put auth middleware
upstream of the shell middleware and unauthorized users get their 401/redirect,
not someone else's cached page.

**(b) Identity can't leak into a shared shell.** `cookies()` and `headers()`
THROW during the background capture render (`assertNotInsideShellCapture`,
`src/server/cookie-store.ts`), the same guard family as `"use cache"` and
`cache()`. A shell that reads cookies is PPR-ineligible by construction.

**(c) Residual hazard — state it plainly.** Middleware-derived per-user state is
NOT guarded: a `ctx` variable set by an upstream auth middleware and read by a
handler WITHOUT `cookies()`/`headers()` is invisible to guard (b). The background
capture inherits the triggering request's post-middleware context and bakes that
state into the shared shell. Mitigations, in order of preference:

- shell-cache only **public/shared** pages;
- put all per-user content in **loaders** (the enforced, masked lane);
- `isEnabled` to disable the middleware for authenticated sessions;
- `keyGenerator` to add a per-variant dimension (it owns the FULL key identity,
  including host — see Options).

Shell content that still varies per request degrades to a hydration repair
(bounded by TTL/SWR), not corruption — but it is a smell. `cache()` the route so
the same replayed segments feed the captured shell and every resumed render.

## What always stays on axis 1

Non-GET, RSC/partial/action/loader fetches, per-request CSP nonce,
`streamMode: "allReady"`, redirects, 404s, error renders, and any store without
the shell family. A stored shell is also invalidated when `React.version`
changes (postponed state is build-coupled), so deploys self-heal via recapture.

First byte on a HIT does not wait on the shell render or the loader. Hydration
uses the fresh per-request Flight payload, so interactivity is unaffected.

## Partial navigations

Soft navigations (`_rsc_partial`) bypass this middleware, and that is by
design, not a gap: a partial response has no HTML tier — no fizz render to
skip, which is the entire cost document-PPR eliminates. On a `cache()` route a
partial navigation already delivers the PPR contract at the data tier:
replayed cached segments flush immediately (in-memory after the store read),
loaders run fresh and stream their rows into the same response, and the
client shows `loading()` fallbacks until they arrive. Shell instantly, live
holes revived — same semantics, different wire format.

For warm-navigation latency, combine `cache()` with prefetching: a prefetched
partial payload is the client-side analogue of the shell cache, and loaders
still stream fresh on arrival. Document-PPR covers the cold full-document
load; prefetch + `cache()` covers navigation.

What partial navigations do NOT get is the byte-level shortcut: the worker
still deserializes stored segments and re-encodes the Flight payload per
request. Serving a stored Flight byte-prefix and appending fresh loader rows
would require hand-managed row-ID alignment — React has no Flight-side
resume (no postponed-state equivalent exists for Flight) — and is a deferred
optimization, tracked in the design doc's out-of-scope list.

## Options

| Option         | Default                             | Notes                                                                                                                                  |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `store`        | app-level `_cacheStore`             | must implement `getShell`/`putShell`; the capture writes to the SAME store the middleware reads                                        |
| `ttlSeconds`   | `300`                               | shell freshness window                                                                                                                 |
| `swrSeconds`   | —                                   | stale window: serve stale + background recapture                                                                                       |
| `keyGenerator` | `${host}${pathname}${sortedSearch}` | custom keys own the FULL identity — include the host unless the store is provably single-host (multi-tenant shells must never collide) |
| `isEnabled`    | —                                   | per-request opt-out predicate (e.g. disable for authed sessions)                                                                       |
| `skipPaths`    | `[]`                                | path-prefix opt-out                                                                                                                    |
| `debug`        | `false`                             | HIT/MISS/CAPTURED logging                                                                                                              |

## Pitfalls

- **Loader route without `loading()`**: eternal MISS plus a once-per-key
  console warning. Move shell material to a layout and add `loading()` (see "The
  hole contract").
- **Handler-passed promise for live data**: nondeterministic race, drift into
  the shared shell. Use a loader behind `loading()`, or wrap it in `live()`.
- **`live()` value form (`live(promise)`)**: the work already fired before
  `live()` saw it, so during capture the promise still runs and its side effects
  still happen — only its result is held out of the shell. Prefer the thunk form
  `live(() => …)` so nothing executes during capture.
- **Per-user state via `ctx` variables**: not guarded — see Security (c).
- **Stacking with `/document-cache`**: pick one per route. The document cache
  would cache the composite — correct output, but it makes shell caching
  redundant there.
- **Dev + HMR**: works, but edits produce stale shells until TTL/recapture.
- A cold-worker capture can occasionally abort mid-render; it is logged as
  retryable and the next request recaptures — self-healing, not an error.

## Related

- `/document-cache` — whole-response edge caching (no live holes)
- `/caching` and `/cache-guide` — segment/function caching (axis 1 data)
- `/shell-manifest` — replayed handles as cache metadata read by live loaders
- Design doc: `docs/design/ppr-shell-resume.md` in the package
