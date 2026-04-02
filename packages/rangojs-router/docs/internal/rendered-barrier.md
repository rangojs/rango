# Rendered Barrier (Experimental)

**Status**: Phase 1 — experimental, non-streaming only.

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
- Non-streaming render trees: no `loading()` on any entry in the matched tree.
- Fresh SSR (full and partial match).
- Cache hit replay (runtime cache): handles are replayed from cache, barrier
  resolves immediately.
- Prerender replay: handles are replayed from build artifacts, barrier
  resolves immediately.

### Not Supported (Phase 1)

- Handler-invoked loaders (`ctx.use(Loader)` inside a route/layout handler).
  Calling `rendered()` from a handler-invoked loader throws immediately.
- Streaming trees: any entry with a `loading()` fallback causes `rendered()`
  to throw. `loading(false)` (streaming explicitly disabled) is fine.
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

| Condition                                        | Behavior                       |
| ------------------------------------------------ | ------------------------------ |
| `rendered()` in DSL loader, no streaming         | Resolves after handlers settle |
| `rendered()` in DSL loader, tree has `loading()` | Throws `RenderedBarrierError`  |
| `rendered()` in handler-invoked loader           | Throws `RenderedBarrierError`  |
| `ctx.use(handle)` before `await ctx.rendered()`  | Throws                         |
| `ctx.use(handle)` after `await ctx.rendered()`   | Returns collected handle data  |

## Implementation Notes

### Render Barrier Lifecycle

The render barrier is a deferred promise on the request context:

- **Fresh path**: Resolved after `resolveAllSegments()` returns. At that
  point all handlers have completed (non-streaming guarantee) and all
  synchronous handle data has been pushed. The HandleStore is NOT sealed
  here — sealing stays in the existing lifecycle (rsc-rendering.ts,
  cache-scope.ts). Promise-valued handle pushes may still be unresolved.
- **Cache hit path**: Resolved after handle data is replayed from cache.
  Handles are immediately available.
- **Prerender path**: Resolved after handle data is replayed from build
  artifacts. Same as cache hit.

### Loader `use(handle)` After Barrier

After `rendered()` resolves, the loader's `ctx.use(handle)` reads from
the HandleStore. The data is collected using the handle's `collect`
function (same as `useHandle()` on the client), producing the same shape.

Segment order for collection follows the segment resolution order
(parent → child), captured when the barrier resolves.

### Why Not Streaming (Phase 1)

In a streaming tree, handlers behind `loading()` may not have settled when
`resolveAllSegments()` returns — their components are promises that resolve
during RSC serialization. Handle data from those handlers would be
incomplete at barrier resolution time.

Supporting streaming requires tracking which handles come from settled vs
unsettled handlers and either:

- Waiting for full settlement (defeating streaming's purpose), or
- Providing a partial snapshot with explicit "may be incomplete" semantics.

Both add complexity with unclear value. Phase 1 avoids this entirely.

## Stop Conditions

- Broad changes across render, cache, prerender, and streaming to support
  the basic case.
- Guard logic that is hard to explain in one sentence.
- `ctx.use(handle)` having "write in handlers, read in loaders" is too
  magical in practice.
- Tests need too many semantic exceptions.
