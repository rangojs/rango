# SSR Streaming Policy

## Summary

`ssr.resolveStreaming` controls whether HTML SSR responses stream
progressively or wait for all Suspense boundaries before flushing.

## API

```typescript
createRouter({
  ssr: {
    resolveStreaming: (context: { request: Request; env: TEnv; url: URL }) =>
      SSRStreamMode | Promise<SSRStreamMode>,
  },
});
```

`SSRStreamMode = "stream" | "allReady"`

## Semantics

- **Default**: `"stream"` when `resolveStreaming` is not configured.
- **Scope**: only HTML SSR paths. RSC partials (`__rsc`), prefetch,
  response routes (`path.json` etc.) are unaffected.
- **Timing**: the resolver runs once per HTML request, before the
  SSR render call. Its result is passed to `renderHTML({ streamMode })`.
- **Error handling**: if the resolver throws, the error propagates
  through the normal request error path (onError callback, 500).

## Implementation

The resolver is called in `handler.ts` (the RSC handler factory)
and the result flows through `HandlerContext.resolveStreamMode` to
all HTML SSR code paths:

1. `rsc-rendering.ts` — main HTML render
2. `progressive-enhancement.ts` — PE render and PE error boundary
3. `handler.ts` — 404 HTML fallback

In the SSR handler (`ssr/index.tsx`), `streamMode === "allReady"`
awaits `htmlStream.allReady` before piping through `injectRSCPayload`.

## Design decisions

- No built-in bot list. Users bring their own detection logic.
- No automatic `Vary: User-Agent`. Adding it would disable CDN
  caching for most deployments. Users can add it in middleware.
- The resolver receives the full request, so custom header checks
  or allowlisting by IP/cookie are possible.
