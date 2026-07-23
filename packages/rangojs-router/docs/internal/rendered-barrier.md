# Rendered Barrier (Experimental)

**Status**: Experimental. Works in DSL loaders, including streaming trees that use `loading()` (the barrier waits for the streaming handlers to settle).

## Problem

Loaders run before handlers. A loader that needs to know which data the
handler tree produced (e.g., which product IDs were rendered) must either
duplicate the fetch or create a loader-to-loader waterfall.

Handles accumulate data from handlers/layouts for downstream consumption,
but loaders cannot read handles because handles are populated after loaders
start.

## Solution

Add `await ctx.rendered()` to loader context. After the promise resolves,
the non-loader render tree has settled and all handle data is available.
The loader can then read handles via `ctx.use(handle)`.

```ts
const PricesLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  const products = ctx.use(Products); // reads handle data
  return pricing.getLive(products.map((p) => p.id));
});
```

## Semantics

- `rendered()` returns a `Promise<void>` that resolves when all non-loader
  segments in the matched tree have settled and handle data is available.
- After `await ctx.rendered()`, `ctx.use(handle)` returns the accumulated
  handle data (the collected value, same shape as `useHandle()` on client).
- Before `await ctx.rendered()`, `ctx.use(handle)` throws.
- `ctx.use(loader)` continues to work normally at any point.
- `rendered()` is idempotent — multiple calls return the same promise.

## Phase 1 Scope

### Supported

- DSL loaders only (registered via `loader()` in `urls()` trees).
- Streaming trees (`loading()`): the streaming handlers' async execution is
  tracked in the handle store, so the barrier waits for them to finish pushing
  before it resolves — the loader then reads complete handle data.
- Fresh SSR (full and partial match).
- Cache hit replay (runtime cache): handles are replayed from cache, barrier
  resolves immediately.
- Prerender replay: handles are replayed from build artifacts, barrier
  resolves immediately.

### Not Supported (Phase 1)

- Handler-invoked loaders (`ctx.use(Loader)` inside a route/layout handler).
  Calling `rendered()` from a handler-invoked loader throws immediately.
- Partial/revalidation special cases: no special handling beyond what falls
  out naturally from the cache-hit path.
- Nested `rendered()` dependencies (loader A awaits rendered, loader B
  depends on loader A via `ctx.use(A)` — this works but is not optimized).

### Known Limitations

- **Promise handle values**: `rendered()` guarantees the handler has
  executed and called `push()`, but does NOT guarantee that promise values
  inside pushes have resolved. If a handler does `push(fetchSomething())`,
  the loader will see the unresolved Promise object. Push synchronous
  values for Phase 1 correctness.
- **Deadlock with handler ctx.use()**: If a loader calls `rendered()`, a
  handler must not `await ctx.use(thatSameLoader)`. The handler would block
  segment resolution, which blocks the barrier, which blocks the loader.
  A runtime check detects this when the loader has already called
  `rendered()` before the handler runs; timing-dependent cases may still
  deadlock without detection.

## Guard Rules

| Condition                                        | Behavior                                              |
| ------------------------------------------------ | ----------------------------------------------------- |
| `rendered()` in DSL loader, no streaming         | Resolves after handlers settle                        |
| `rendered()` in DSL loader, tree has `loading()` | Waits for streaming handlers to settle, then resolves |
| `rendered()` in handler-invoked loader           | Throws `Error` ("only available in DSL loaders")      |
| `rendered()` while a handler awaits this loader  | Throws (deadlock guard)                               |
| `ctx.use(handle)` before `await ctx.rendered()`  | Throws                                                |
| `ctx.use(handle)` after `await ctx.rendered()`   | Returns collected handle data                         |

## Implementation Notes

### Render Barrier Lifecycle

The render barrier is a deferred promise on the request context:

- **Fresh path (non-streaming)**: Resolved after `resolveAllSegments()`
  returns. At that point all handlers have completed and all synchronous
  handle data has been pushed.
- **Fresh path (streaming, `loading()`)**: the barrier still resolves after
  `resolveAllSegments()`, but `loading()` handlers are still in flight then.
  Their async execution is tracked in the handle store (`trackHandler` →
  `store.track`), so `rendered()` additionally seals the store and `await`s
  `handleStore.settled` before resolving — every tracked handler, streaming
  included, has finished pushing. `ctx.use(handle)` then builds a fresh,
  complete snapshot. The loader's own segment streams in after, so this does
  not block the shell; the deadlock guard keeps a handler from depending on
  the loader. Promise-valued handle pushes may still be unresolved.
- **Cache hit path**: Resolved after handle data is replayed from cache.
  Handles are immediately available.
- **Prerender path**: Resolved after handle data is replayed from build
  artifacts. Same as cache hit.
- **PPR shell capture (bake lane)**: the capture's derived context gets its
  OWN barrier, wired to the capture's fresh handle store
  (`wireRenderBarrier` in `server/request-context.ts`, called from
  `deriveShellCaptureContext` in `rsc/shell-capture.ts`). This is scar
  tissue (issue #684, plan 009): the derived context is
  `Object.create(reqCtx)`, and before the explicit wiring every
  `_renderBarrier*` read fell through the prototype to the foreground
  request's barrier — closure-bound to the foreground context and store,
  already resolved, resolver a no-op. A bake-lane loader's
  `await ctx.rendered()` resolved instantly and `ctx.use(handle)` returned
  the FOREGROUND's handle snapshot, so foreground per-request handle data
  could bake into the shared shell. With its own barrier the capture runs
  the same lifecycle as a fresh render: barrier resolves at the capture's
  segment resolution, `_treeHasStreaming` is recomputed for the capture's
  tree, and the snapshot is built from the capture's store. Pinned by
  `router/__tests__/shell-capture-barrier-isolation.test.ts`.

### Loader `use(handle)` After Barrier

After `rendered()` resolves, the loader's `ctx.use(handle)` reads from
the HandleStore. The data is collected using the handle's `collect`
function (same as `useHandle()` on the client), producing the same shape.

Segment order for collection follows the segment resolution order
(parent → child), captured when the barrier resolves.

### How Streaming Works

In a streaming tree, handlers behind `loading()` have not finished pushing
when `resolveAllSegments()` returns — only their _rendered output_ streams
behind Suspense; the handler function itself runs eagerly and its async
execution (including its `push()` calls) is tracked in the handle store
(`fresh.ts`: `trackHandler(handler(context))` → `store.track`). So the signal
"all handlers have pushed" already exists: `handleStore.settled` (sealed AND no
in-flight tracked promises).

`rendered()` uses it. For a streaming tree it does not trust the eager snapshot
built when the barrier resolves (incomplete — the `loading()` handlers were
still in flight); instead it seals the store and `await`s `handleStore.settled`,
then `ctx.use(handle)` builds a fresh, complete snapshot. The seal is safe
because every handler is tracked during `resolveAllSegments`, so by barrier time
none is unregistered; pushes happen _within_ those tracked promises (before
`settled`); and the payload's later `stream()` auto-seal is idempotent.

The one thing this does NOT do is wait for promise _values_ inside pushes (see
Known Limitations) — `settled` waits for the handler to push, not for a pushed
`Promise` to resolve.

## Stop Conditions

- Broad changes across render, cache, prerender, and streaming to support
  the basic case.
- Guard logic that is hard to explain in one sentence.
- `ctx.use(handle)` having "write in handlers, read in loaders" is too
  magical in practice.
- Tests need too many semantic exceptions.
