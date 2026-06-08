# Why include() is Synchronous

If you've ever wanted to write `include("/admin", () => import("./urls/admin"))`
and wondered why the types won't let you — this is the answer, and it's
deliberate. `include(prefix, patterns, options?)` takes a synchronous
`UrlPatterns` object only, never a `() => Promise<{ default: UrlPatterns }>`
factory. If you're here because you're about to widen that signature, read this
first: the constraint is load-bearing, and there's already a different API for
the thing you actually want.

## The constraint

```ts
// Supported
import admin from "./urls/admin";
urls(({ include }) => [include("/admin", admin)]);

// Not supported — type error
urls(({ include }) => [include("/admin", () => import("./urls/admin"))]);
```

Three places enforce it:

- Type: `IncludeFn` at `src/urls/path-helper-types.ts`
- Runtime call: `createIncludeHelper` at `src/urls/include-helper.ts:103`
- The inner handler is invoked synchronously at **two** distinct sites:
  - **Match-time**, inside sync `findMatch`: `evaluateLazyEntry` at
    `src/router/lazy-includes.ts:155`. This one _has_ to stay sync —
    `findMatch` is sync and has ~8 callers, including client-side navigation
    snapshot lookups.
  - **Manifest-load time**, inside async `loadManifest`:
    `src/router/manifest.ts:183`. This site runs in an async context and
    _could_ await — but it is reached only AFTER `findMatch` has already
    resolved the match, so making it async does not help the match-time
    blocker at all.

## Why not async — the metadata has to be complete up front

Here's the crux. Route-tree **metadata** is built eagerly, at two separate
phases, and both walk `patterns.handler()` synchronously:

1. **Runtime router registration** — `Rango.routes(patternsOrBuilder)` at
   `src/router.ts:682` walks the handler during router construction to extract
   route patterns, register the reverse map, and seed the `routesEntries` that
   `findMatch` uses.
2. **Build-time discovery** — `generateManifestFull` at
   `src/build/generate-manifest.ts:282` (and the nested `buildPrefixTreeNode` at
   `src/build/generate-manifest.ts:174-198`) walks the handler to produce the
   generated route manifest, route ancestry, trie input, trailing-slash config,
   prerender list, response-type map, and generated-type-file inputs.

Between them, those two walks populate four things the router then treats as
always-available:

1. **The route trie** (`setRouterTrie` in `src/route-map-builder.ts`) — the fast
   match path, used by `tryTrieMatch` in `src/router/trie-matching.ts`.
2. **The reverse map** — so `reverse()` / `href()` / `useHref()` resolve route
   names to patterns from any module, at any time, without async.
3. **Generated route types** — `router.named-routes.gen.ts`'s
   `DefaultReverseRouteMap` drives autocomplete plus param-type validation.
4. **The prerender route list** — build-time prerender needs every prerenderable
   route name up front.

A Promise-returning factory at `include()` would defer the included module's
execution past _both_ walks, leaving every one of those four structures
incomplete until the first matching request resolved the import. What that
breaks:

- **The trie.** Routes inside the unresolved include miss; matching falls back
  to the regex path at `src/router/find-match.ts:135`. But `findMatch` is
  synchronous, and its retry loop at `src/router/find-match.ts:141` only
  re-invokes sync lazy evaluation — there is no await point to wait on an
  import. To support a Promise factory here, `findMatch` itself would have to
  change its contract (return a pending-promise sentinel, or become async),
  which cascades through every caller.
- **`href()`.** `href("admin.dashboard", ...)` returns `undefined` on any page
  whose render happens before the admin include has been requested. Link-prefetch
  and client-side navigation into not-yet-loaded includes break silently.
- **Generated types.** They regress, or require a separate build-time resolution
  step that re-executes factories just for type-gen — negating the
  code-splitting benefit.
- **Prerender.** It cannot enumerate prerenderable routes without executing the
  factory at build time — again negating the intended laziness.

## "Lazy" here already means something specific

It's worth being precise, because the system _is_ lazy — just not in the way a
dynamic import would be. The lazy-include machinery
(`src/router/lazy-includes.ts`; the comment at `src/urls/include-helper.ts:187`,
"All includes are lazy — patterns are evaluated on first matching request")
defers **per-request Store population**, not route-name discovery:

- **At init** (both router construction and build discovery): patterns are
  walked to build the trie + reverse map + types. Cheap, metadata-only.
- **At first matching request:** `evaluateLazyEntry` runs the handler inside a
  per-request `RangoContext` to register handlers, loaders, cache profiles,
  middleware chains, etc. This is the work lazy-by-default avoids on cold start.
- **On subsequent requests:** the module-level manifest cache
  (`manifestModuleCache` in `src/router/manifest.ts`) short-circuits the rebuild
  for the same cache key.

That split — eager metadata, lazy per-request plumbing — is what gives serverless
cold starts a cheap init without sacrificing any of the four structural
guarantees above.

## What to use for code-splitting instead

There _is_ a public API that accepts a dynamic-import factory — the host
router's `.lazy()` — and it is the only one:

```ts
import { createHostRouter } from "@rangojs/router/host";

const router = createHostRouter();
router.host(["admin.*"]).lazy(() => import("./apps/admin/handler.js"));
router.host(["."]).lazy(() => import("./apps/main/handler.js"));
```

The host route builder splits intent across two methods (see
`src/host/types.ts`): `.map(handler)` takes a full request `Handler`
(`(request, input) => Response`), and `.lazy(loader)` takes a `LazyHandler`
(`() => import(...)`) that resolves to a module whose `default` export is a
handler or nested host router. Only `.lazy()` entries are invoked during
build-time discovery; `.map(() => import(...))` is rejected (its return type is
not a `Response`). The reason this works where `include()` can't: each mounted
app is its own self-contained router with its own trie, reverse map, and
generated type file, so deferring its module load leaves no _shared_ metadata
incomplete. A whole handler/app is a natural splitting unit; a single
`include()` prefix inside a shared router is not.

And `Rango.routes()` itself only accepts `UrlPatterns | UrlBuilder` (see
`src/router.ts:682`) — it does **not** take a factory. Code-splitting below the
host-router boundary requires host-level composition, not a widened `include()`
signature.

## When this rule should be revisited

Only if someone designs and validates a mechanism that keeps the trie, reverse
map, type-gen, and prerender all **complete while imports remain deferred**. The
options considered and rejected so far:

- **Eager resolve at router boot** — defeats per-request laziness; forbidden for
  serverless-first use.
- **Pending-promise sentinel in `findMatch` with regex-fallback-forever for
  unresolved includes** — requires an async contract for a path that is sync by
  design, loses the trie's fast path, silently breaks `href()` for unresolved
  prefixes, and forces every `findMatch` caller to learn an async retry path.
- **Incremental trie mutation on first resolve** — possible in principle, but
  adds trie-rebuild cost on first hit and still does not fix the `href()` gap
  for render paths that run before the first matching request.

If a proposal does not address all four — trie, reverse map, type-gen, and
prerender — the answer is still no.
