# include() and async route loading

If you're about to touch `include()`, matching, or route-type generation, start
here. `include()` now accepts two shapes, and the difference is the whole story:

```ts
// Eager: the route module is already in the graph. Its patterns are a value.
import shop from "./shop";
urls(({ include }) => [include("/shop", shop)]);

// Async: the route module is code-split behind a thunk. It is not evaluated at
// startup — only imported on the first request that reaches "/shop".
urls(({ include }) => [include("/shop", () => import("./shop"))]);
```

The async form is a `() => import(...)` provider (or, forward-compatibly, any
`() => UrlPatterns | { default: UrlPatterns } | Promise<...>`). The convention
for the split module is `export default urls(...)`; `resolveIncludeModule`
(`src/urls/include-provider.ts`) accepts either the `urls()` value returned
directly or as the module's `default`.

## Why this exists

The win is cold start and bundle shape. A `() => import()` include becomes its
own chunk. The worker's entry module does not statically import it, so V8 never
compiles or evaluates that subgraph until a request actually needs it. For an
app with a handful of large route groups, that moves real work off the
first-request critical path and shrinks the eagerly-parsed entry bundle. (In the
`tests/cloudflare-stress-demo` measurement the worker entry dropped ~67% once the
`/site`, `/api`, `/json-api` groups moved behind providers.)

## This started as "no" — read why, because the reasons still bind

For a long time `include()` accepted a synchronous `UrlPatterns` **only**, and
that was deliberate. Route-tree _metadata_ is built eagerly at two phases that
both walk `patterns.handler()`:

1. **Runtime router registration** — `Rango.routes()` walks the handler during
   router construction to seed `routesEntries` used by `findMatch`.
2. **Build-time discovery** — `generateManifestFull` /
   `buildPrefixTreeNode` (`src/build/generate-manifest.ts`) walk it to produce
   the route manifest, ancestry, trie input, trailing-slash config, prerender
   list, response-type map, and generated-type inputs.

Between them those walks populate four structures that are expected to be
**complete and synchronously readable at any time**:

1. The **route trie** — the fast match path (`tryTrieMatch`).
2. The **reverse map** — `reverse()` / `href()` / `useHref()` resolve names to
   patterns from any module, without async.
3. **Generated route types** — `router.named-routes.gen.ts` drives autocomplete
   and param validation.
4. The **prerender route list** — build-time prerender needs every prerenderable
   name upfront.

A naive Promise-returning factory would defer module execution past both walks,
leaving all four incomplete until the first matching request — trie misses,
`href()` returning `undefined` on pages rendered before the include was hit,
type-gen regressions, prerender unable to enumerate routes. That objection was
correct, and it is exactly what async include had to solve rather than ignore.

## How async include keeps all four invariants

The trick is to split "discover the routes" from "import the module's runtime
code". Discovery still happens eagerly; only the module import and per-request
expansion defer.

- **Build/dev discovery awaits the provider.** `buildPrefixTreeNode` resolves
  `() => import()` at the top of the node walk
  (`resolveIncludeModule(await patternsOrProvider(), ...)`), so the split
  group's routes land in the trie, reverse map, generated types, and prerender
  list just like an eager include. `generateManifest*` are `async` for this
  reason. This is the seam that makes the objection above moot: discovery reads
  the module at build time, runtime does not.

- **The static route-type parser resolves the thunk too.**
  `src/build/route-types/include-resolution.ts` extracts the module specifier
  from `() => import("./mod")` and walks that module's `export default`
  (`export default urls(...)`, or `export default someVar`), recursing into any
  nested `include()`. Without this, `rango generate` (the AST path, no Vite)
  would hard-fail on the async form. Nested includes inside the split module
  resolve through the same recursion.

- **Runtime defers only the import + per-request plumbing.** On the first
  request into the prefix, `evaluateLazyEntry` (`src/router/lazy-includes.ts`)
  imports the module, caches the resolved patterns on the entry, runs the
  handler to register handlers/loaders/middleware, and splices any nested
  includes as new entries. Subsequent requests hit the module-level manifest
  cache.

So the eager-metadata / lazy-plumbing split that already powered lazy includes
now also spans a deferred module import, without giving up trie, reverse map,
type-gen, or prerender completeness.

## The runtime contract, and the scars that shaped it

Three rules here each exist because breaking them produced a concrete failure.
If you change matching, keep them.

**`evaluateLazyEntry` is _sometimes_ async — and `findMatch` must await it when
it is.** `evaluateLazyEntry` returns `void` for eager and precomputed entries
(the common case — no Promise, so the per-entry match loop pays no microtask)
and a `Promise<void>` only when it has to resolve a provider. `findMatch` awaits
with `const ev = deps.evaluateLazyEntry(e); if (ev) await ev;`. `findMatch` is
therefore `async`; every caller already runs inside an async match pipeline.

**The router's `evaluateLazyEntry` wrapper must return the Promise.** In
`src/router.ts` the closure that binds `evaluateLazyEntry` to router state is
typed `void | Promise<void>` and `return`s the inner call. This looks trivial;
it is load-bearing. When that wrapper was typed `void` and dropped the Promise,
the import became fire-and-forget: `findMatch`'s `await ev` saw `undefined`, the
lazy-eval retry loop spun to its 100-iteration cap, and the first request to any
async include _not_ already covered by a unique precomputed entry returned
`null` — a 404. It passed superficial testing because leaf includes with unique
precomputed prefixes hit the synchronous precomputed shortcut and never
exercised the async path; nested includes (a provider whose module has its own
`include()`s), shared prefixes, and the regex fallback did not have that cover
and broke. Regression pinned by
`src/testing/__tests__/async-include-dispatch.test.ts` (public path, through
`dispatch`).

**Three sites run an include's handler; all three must resolve the provider.**
(1) `evaluateLazyEntry` at match time, (2) `loadManifest`
(`src/router/manifest.ts`) at render time, (3) `buildPrefixTreeNode` at build
discovery. The render-time one is the easy miss: the match-time precomputed
shortcut can set an entry's routes without ever resolving the provider, so
`loadManifest` cannot assume `entry.lazyPatterns` is a resolved `UrlPatterns` —
it checks `isIncludeProvider` and resolves+caches before calling `.handler()`.
Skipping it surfaced as `lazyPatterns.handler is not a function` and a 404 on
render for exactly the leaf includes the match path had shortcut.

**Concurrent first-hits dedupe.** The entry carries a `_lazyInflight` promise so
two simultaneous first requests share one import + expansion; on failure the
flag clears so a later request can retry rather than wedging the route.

## When to use which

**Prefer the async `() => import()` form** — it is the default recommendation for
any route group that is a natural, independently-loadable unit (a large localized
section, an admin area, an API surface with heavy handlers). The bundler moves
its whole subgraph — including nested `include()`s — off the eagerly-parsed entry
and off the cold-start path, and discovery still resolves it at build time so the
trie, generated types, and prerender output stay complete.

**The eager form remains fully valid** — it is not deprecated. Keep it when the
group is small, or shares most of its module graph with the entry anyway (the
bundler keeps shared modules in the common chunk regardless, so splitting a thin
group buys little). Both forms match identically at runtime; the only difference
is _when_ the module's runtime code is evaluated. The built-in lazy evaluation is
the point — migrating eager → async must not eager-evaluate the patterns.

For splitting a whole **app** (its own trie, reverse map, and generated types),
the host router's `.lazy()` is still the right tool — see
`src/host/types.ts`. A whole handler/app is a self-contained splitting unit; an
async `include()` splits a route group _inside_ one router while keeping that
router's shared metadata complete.

**Give each async include a distinct static prefix.** When several includes
collapse to the same static prefix (e.g. two `include("/", () => import(...))`),
the match-time candidate scan in `find-match.ts` evaluates every same-prefix
entry until it finds the route's owner — so the first request eagerly imports
_all_ of them, not just the one that owns the route, defeating the split. The
scan is fault-isolated (a failing candidate import is logged and skipped so it
can't break a sibling that shares the prefix), but the eager cross-import
remains. A distinct prefix per async include (`/site`, `/api`, `/shop`) avoids
both: the trie routes straight to the owning entry and imports only it.

## Failure semantics — async must stay as loud as eager

Migrating an include from eager to async must not quietly downgrade failure
loudness. On `main`, an eager include whose module threw failed the build; a
broken route at runtime surfaced as a 5xx. The async form holds the same line:

| Layer                                                                                  | A broken async include module ...                                                                                                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Build / dev discovery (`mergeIncludeNodes`)                                            | **hard-fails** — the provider throw rethrows, so no green build ships with the group silently missing from manifest/trie/types.                 |
| Runtime match, route's **sole owner** (`find-match.ts` candidate scan, `loadManifest`) | **propagates a 5xx** — a real, trie-matched route whose module can't import is a server error, not a missing route (never masked as 404).       |
| Runtime match, a **non-owner sibling** sharing a static prefix                         | **isolated** — logged and skipped so it can't break the sibling that owns the route.                                                            |
| Runtime match, a **genuinely unmatched** pathname (regex fallback)                     | **stays 404** — a failing lazy include (e.g. a root `include("/")`) probed while resolving an unmatched path must not upgrade its 404 to a 500. |

The rule of thumb: **discovery hard-fails; at request time an owner's failure is
loud (5xx) and only a genuine sibling skip is isolated.**
