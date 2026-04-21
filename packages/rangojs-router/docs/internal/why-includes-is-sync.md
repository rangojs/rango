# Why include() is Synchronous

`include(prefix, patterns, options?)` accepts a synchronous `UrlPatterns`
object only. It does **not** accept a `() => Promise<{default: UrlPatterns}>`
factory. This is intentional. Future attempts to widen the signature should
read this first.

## The constraint

```ts
// Supported
import admin from "./urls/admin";
urls(({ include }) => [include("/admin", admin)]);

// Not supported — type error
urls(({ include }) => [include("/admin", () => import("./urls/admin"))]);
```

Enforcement sites:

- Type: `IncludeFn` at `src/urls/path-helper-types.ts`
- Runtime call: `createIncludeHelper` at `src/urls/include-helper.ts:103`
- The inner handler is invoked synchronously at **two** distinct sites:
  - **Match-time**, inside sync `findMatch`:
    `evaluateLazyEntry` at `src/router/lazy-includes.ts:155`. Must stay
    sync because `findMatch` is sync and has ~8 callers (including
    client-side navigation snapshot lookups).
  - **Manifest-load time**, inside async `loadManifest`:
    `src/router/manifest.ts:183`. This one runs in an async context and
    _could_ await, but it is reached only AFTER `findMatch` has already
    resolved the match — so making it async does not help the match-time
    blocker.

## Why not async

Route-tree **metadata** is built eagerly at two separate phases, both of
which walk `patterns.handler()` synchronously:

1. **Runtime router registration** — `RSCRouter.routes(patternsOrBuilder)`
   at `src/router.ts:682` walks the handler during router construction to
   extract route patterns, register the reverse map, and seed
   `routesEntries` used by `findMatch`.
2. **Build-time discovery** — `generateManifestFull` at
   `src/build/generate-manifest.ts:282` (and nested `buildPrefixTreeNode`
   at `src/build/generate-manifest.ts:174-198`) walks the handler to
   produce the generated route manifest, route ancestry, trie input,
   trailing-slash config, prerender list, response-type map, and
   generated type file inputs.

Between them, those walks populate:

1. **The route trie** (`setRouterTrie` in `src/route-map-builder.ts`) — the
   fast match path, used by `tryTrieMatch` in
   `src/router/trie-matching.ts`.
2. **The reverse map** — `reverse()` / `href()` / `useHref()` resolve
   route names to patterns from any module, at any time, without async.
3. **Generated route types** — `router.named-routes.gen.ts`'s
   `DefaultReverseRouteMap` drives autocomplete plus param-type
   validation.
4. **The prerender route list** — build-time prerender needs every
   prerenderable route name upfront.

A Promise-returning factory at `include()` would defer module execution
past both of those walks, leaving every one of those structures
incomplete until the first matching request resolved the import.
Consequences:

- Trie misses for routes inside the unresolved include; match falls back
  to the regex path at `src/router/find-match.ts:135`. `findMatch` is
  synchronous and its retry loop at `src/router/find-match.ts:141` only
  re-invokes sync lazy evaluation — there is no await point to wait on
  an import. To support a Promise factory here, `findMatch` itself would
  have to change its contract to return a pending-promise sentinel (or
  become async), which cascades through every caller.
- `href("admin.dashboard", ...)` returns `undefined` on any page whose
  render happens before the admin include has been requested.
  Link-prefetch and client-side navigation into not-yet-loaded includes
  break silently.
- Generated types regress or require a separate build-time resolution
  step that re-executes factories just for type-gen, negating the
  code-splitting benefit.
- Prerender cannot enumerate prerenderable routes without executing the
  factory at build time — again negating the intended laziness.

## "Lazy" already means something specific here

The lazy-include system (`src/router/lazy-includes.ts`, comment at
`src/urls/include-helper.ts:187` "All includes are lazy — patterns are
evaluated on first matching request") defers **per-request Store
population**, not route-name discovery. Specifically:

- At init (both router construction and build discovery): patterns are
  walked to build trie + reverse map + types. Cheap, metadata-only.
- At first matching request: `evaluateLazyEntry` runs the handler inside a
  per-request `RSCRouterContext` to register handlers, loaders, cache
  profiles, middleware chains, etc. This is the work lazy-by-default
  avoids on cold start.
- On subsequent requests: the module-level manifest cache
  (`manifestModuleCache` in `src/router/manifest.ts`) short-circuits the
  rebuild for the same cache key.

This split — eager metadata, lazy per-request plumbing — is what gives
serverless cold starts a cheap init without sacrificing the structural
guarantees above.

## What to use instead for code-splitting

The only public API that accepts a dynamic-import factory is the host
router's `.map()`:

```ts
import { createHostRouter } from "@rangojs/router/host";

const router = createHostRouter();
router.host(["admin.*"]).map(() => import("./apps/admin/handler.js"));
router.host(["."]).map(() => import("./apps/main/handler.js"));
```

`.map()` takes a `Handler | LazyHandler` (see
`src/host/types.ts:58`) — i.e. a full request `Handler` function or a
lazy import that resolves to one. Each mapped app is its own
self-contained router with its own trie, reverse map, and generated
type file, so deferring its module load does not leave shared metadata
incomplete. A whole handler/app is a natural splitting unit; a single
`include()` prefix inside a shared router is not.

`RSCRouter.routes()` itself only accepts `UrlPatterns | UrlBuilder` (see
`src/router.ts:682`) — it does **not** take a factory. Code-splitting
below the host-router boundary requires host-level composition, not a
widened `include()` signature.

## When this rule should be revisited

Only if someone designs and validates a mechanism that keeps trie +
reverse map + type-gen + prerender **complete while imports remain
deferred**. Options that have been considered and rejected:

- Eager resolve at router boot: defeats per-request laziness, forbidden
  for serverless-first use.
- Pending-promise sentinel in `findMatch` with regex-fallback-forever
  for unresolved includes: requires an async contract for a path that
  is currently sync by design, loses the trie's fast path, silently
  breaks `href()` for unresolved prefixes, forces every `findMatch`
  caller to learn an async retry path.
- Incremental trie mutation on first resolve: possible in principle but
  adds trie-rebuild cost on first hit, does not fix the `href()` gap
  for render paths that run before the first matching request.

If a proposal does not address all four of trie, reverse map, type-gen,
and prerender, the answer is still no.
