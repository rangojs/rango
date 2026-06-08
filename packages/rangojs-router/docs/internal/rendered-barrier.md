# Rendered Barrier (Experimental)

**Status**: Experimental. Works in DSL loaders, including streaming trees that use `loading()` (the barrier waits for the streaming handlers to settle).

If you're about to touch how loaders read handle data — or you just hit
`ctx.rendered()` in a loader and want to know what it actually promises —
start here. This is a small feature with a sharp edge, and the edge is exactly
where the scar tissue lives.

## The problem it solves

Loaders run before handlers. That ordering is fine until a loader needs to know
what the handler tree produced — say, which product IDs ended up rendered. With
nothing to lean on, that loader has two bad options: duplicate the fetch the
handler already did, or chain itself behind another loader and create a
loader-to-loader waterfall. Neither is something you want to write twice.

Handles look like the natural answer — they exist precisely to accumulate data
from handlers and layouts for downstream consumption. But there's a timing
mismatch: handles are populated _after_ loaders start, so a loader that reads a
handle reads it empty. The data it wants hasn't been written yet.

## The fix

Give the loader a way to wait. `await ctx.rendered()` is that wait: once the
promise resolves, the non-loader render tree has settled and all handle data is
in place. From there the loader can read handles via `ctx.use(handle)` and get
real values.

```ts
const PricesLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  const products = ctx.use(Products); // reads handle data
  return pricing.getLive(products.map((p) => p.id));
});
```

## Semantics

This is the contract you can rely on:

- `rendered()` returns a `Promise<void>` that resolves when all non-loader
  segments in the matched tree have settled and handle data is available.
- After `await ctx.rendered()`, `ctx.use(handle)` returns the accumulated
  handle data (the collected value, same shape as `useHandle()` on client).
- Before `await ctx.rendered()`, `ctx.use(handle)` throws. (The handle isn't
  populated yet, so there's nothing correct to hand back — better to throw than
  to lie.)
- `ctx.use(loader)` continues to work normally at any point.
- `rendered()` is idempotent — multiple calls return the same promise.

## Phase 1 scope

This is the first cut, so the supported surface is deliberately narrow. Here's
what's in.

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

### Not supported (Phase 1)

And here's what's intentionally out — each of these is a case we either couldn't
make correct yet or chose not to chase:

- Handler-invoked loaders (`ctx.use(Loader)` inside a route/layout handler).
  Calling `rendered()` from a handler-invoked loader throws immediately.
- Partial/revalidation special cases: no special handling beyond what falls
  out naturally from the cache-hit path.
- Nested `rendered()` dependencies (loader A awaits rendered, loader B
  depends on loader A via `ctx.use(A)` — this works but is not optimized).

### Known limitations

Two sharp edges to keep in mind. Both are real and both can bite quietly, so
they're worth reading before you build on this:

- **Promise handle values**: `rendered()` guarantees the handler has
  executed and called `push()`, but does NOT guarantee that promise values
  inside pushes have resolved. If a handler does `push(fetchSomething())`,
  the loader will see the unresolved Promise object. Push synchronous
  values for Phase 1 correctness.
- **Deadlock with handler ctx.use()**: If a loader calls `rendered()`, a
  handler must not `await ctx.use(thatSameLoader)` — the handler would block
  segment resolution, which blocks the barrier, which blocks the loader. The
  runtime guard catches this bidirectionally (whichever side runs first), and on
  streaming trees it stays live until `handleStore.settled`, so a `loading()`
  handler that resumes after the barrier is still caught. The cycle surfaces as
  an error instead of hanging.

## Guard rules

When the guards fire and when they don't, in one table:

| Condition                                        | Behavior                                              |
| ------------------------------------------------ | ----------------------------------------------------- |
| `rendered()` in DSL loader, no streaming         | Resolves after handlers settle                        |
| `rendered()` in DSL loader, tree has `loading()` | Waits for streaming handlers to settle, then resolves |
| `rendered()` in handler-invoked loader           | Throws `RenderedBarrierError`                         |
| `rendered()` while a handler awaits this loader  | Throws (deadlock guard)                               |
| `ctx.use(handle)` before `await ctx.rendered()`  | Throws                                                |
| `ctx.use(handle)` after `await ctx.rendered()`   | Returns collected handle data                         |

## Implementation notes

### Render barrier lifecycle

Under the hood the render barrier is a deferred promise on the request context.
What resolves it depends on which path the request took:

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

### Loader `use(handle)` after barrier

After `rendered()` resolves, the loader's `ctx.use(handle)` reads from
the HandleStore. The data is collected using the handle's `collect`
function (same as `useHandle()` on the client), producing the same shape.

Segment order for collection follows the segment resolution order
(parent → child), captured when the barrier resolves.

### How streaming works

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
Known limitations) — `settled` waits for the handler to push, not for a pushed
`Promise` to resolve.

## Stop conditions

If you're extending this, these are the lines that should make you stop and
reconsider rather than push through — the points where the feature stops earning
its complexity:

- Broad changes across render, cache, prerender, and streaming to support
  the basic case.
- Guard logic that is hard to explain in one sentence.
- `ctx.use(handle)` having "write in handlers, read in loaders" is too
  magical in practice.
- Tests need too many semantic exceptions.
