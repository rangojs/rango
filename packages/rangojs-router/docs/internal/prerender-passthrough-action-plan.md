# Prerender Passthrough Action Plan

**Status: Implemented**

## Goal

Add an explicit `ctx.passthrough()` outcome for `Prerender()` handlers so a
build-time prerender invocation can intentionally skip writing a local
prerender entry for a specific param set, while allowing runtime fallback on
routes declared with `{ passthrough: true }`.

## API Decision

Use `ctx.passthrough()` as the only new public API for this behavior.

```tsx
export const BlogPost = Prerender(
  async () => [{ slug: "a" }, { slug: "b" }],
  async (ctx) => {
    const post = await getPost(ctx.params.slug);
    if (!post) return ctx.passthrough();
    return <article>{post.content}</article>;
  },
  { passthrough: true },
);
```

## Semantic Rules

- JSX or `null` means normal prerender output and should be stored.
- `ctx.passthrough()` means do not create a local prerender entry for this
  param set.
- `ctx.passthrough()` is only valid on routes declared with
  `{ passthrough: true }`.
- Calling `ctx.passthrough()` on a non-passthrough route must throw an
  invariant error.
- Raw `undefined` or implicit fallthrough must not be treated as passthrough.
- `Skip` remains a separate build-time control flow mechanism.

## Implementation Steps

1. Extend prerender types in `src/prerender.ts`.
   Add a typed passthrough sentinel/result and expose `ctx.passthrough()` on
   prerender-capable contexts.

2. Wire the invariant into prerender context creation.
   `ctx.passthrough()` should throw immediately when the route definition did
   not opt into `{ passthrough: true }`.

3. Update the build-time prerender execution path.
   Detect the passthrough sentinel before serialization and treat it as a
   successful "no local artifact" outcome instead of a rendered result.

4. Update prerender collection in `src/vite/discovery/prerender-collection.ts`.
   Skip manifest insertion for params that returned `ctx.passthrough()`, log
   them distinctly, and continue the build.

5. Preserve runtime behavior.
   Runtime lookup should behave exactly like a prerender miss: if no stored
   entry exists and the route is passthrough-enabled, run the handler live.

## Testing Plan

- Add unit coverage for the sentinel/result typing and detection.
- Add coverage that `ctx.passthrough()` omits the prerender manifest entry for
  the affected params.
- Add dev and production e2e coverage that those params fall through to live
  rendering on `{ passthrough: true }` routes.
- Add coverage that `ctx.passthrough()` throws on routes without
  `{ passthrough: true }`.
- Add coverage that `return undefined` does not silently act as passthrough.

## Documentation Plan

- Update `docs/prerender-api-design.md` with the new handler outcome and the
  non-passthrough invariant.
- Add or update README/examples to show mixed prerendered and live-fallback
  params on the same route.
- Keep this plan internal until the feature lands.
