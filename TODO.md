# TODO

## SSR Location - Use Actual Request URL

During SSR, `useNavigation()` returns a hardcoded `http://localhost` URL instead of the actual request URL.

**Current state:**

- `SSR_DEFAULT_STATE` in `use-navigation.ts:39` hardcodes `http://localhost`
- `navigation-store.ts:67` also falls back to `http://localhost` during SSR

**Fix:**

1. Add `url` (full URL string) to RSC payload metadata
2. Create `SSRLocationContext` to pass the URL to client components during SSR
3. Update `useNavigation` to use this context when rendering on the server
4. Wrap the SSR root with the context provider in `entry.ssr.tsx`

**Files involved:**

- `packages/rsc-router/src/browser/types.ts`
- `packages/rsc-router/src/browser/react/use-navigation.ts`
- `examples/vite-rsc-demo/src/entry.rsc.tsx`
- `examples/vite-rsc-demo/src/entry.ssr.tsx`

## Preconnect on User Activity (Connection Warming)

When a page has been idle beyond the Keep-Alive timeout (~60-120s), the TCP/TLS connection to the server is likely closed. Re-establishing costs 150-450ms (DNS + TCP + TLS handshakes).

**Optimization:**
Detect user activity after idle periods and preconnect to warm the connection before navigation.

**Triggers:**

- `visibilitychange` (tab becomes visible after being hidden)
- `mousemove`, `keydown`, `scroll`, `touchstart` after idle threshold

**Implementation options:**

1. Inject `<link rel="preconnect" href={origin}>` dynamically
2. Fire a lightweight `fetch('/ping', { method: 'HEAD', priority: 'low' })`

**Considerations:**

- TLS session resumption may already reduce TLS cost (cached 5-10 min)
- HTTP/2 multiplexing makes single warm connection more valuable
- Don't be too aggressive - each preconnect holds a server connection slot
- Could integrate with router's link prefetch/hover logic
