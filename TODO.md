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
