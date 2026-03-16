# Shallow Navigation

RFC for client-only URL updates that skip server RSC revalidation.

## Problem

Some URL changes don't need a server round-trip. Examples:

- Toggling a filter: `/products?color=red` → `/products?color=blue`
- Pagination with client-side data: `/list?page=2` → `/list?page=3`
- Updating a tab: `/settings#billing` → `/settings#profile`
- Syncing ephemeral UI state to the URL for shareability / back-forward support

Today, every `router.push()` or `<Link>` click triggers a partial RSC fetch. For purely client-driven state this is wasteful — the server re-executes the handler and loaders only to produce identical output (or output the client already has).

## Proposed API

### `<Link>`

```tsx
// Full navigation (default — fetches RSC from server)
<Link to="/products?color=blue">Blue</Link>

// Skip revalidation (URL-only, no server fetch)
<Link to="/products?color=blue" revalidate={false}>Blue</Link>
<Link to="/products?color=blue" revalidate={false} replace>Blue</Link>
```

### `useRouter()`

```tsx
const router = useRouter();

// Full navigation (default)
router.push("/products?color=blue");

// Skip revalidation
router.push("/products?color=blue", { revalidate: false });
router.replace("/products?page=3", { revalidate: false });
```

### Same-pathname constraint

`revalidate: false` only takes effect when the **pathname stays the same**. If the pathname changes, the option is silently ignored and a full navigation occurs. This keeps the API safe — path changes imply different server data, and there's no need for client-side param extraction or trie matching.

```tsx
// Same pathname — revalidate: false takes effect
// /products?color=red → /products?color=blue  ✓ no server fetch

// Different pathname — revalidate: false ignored, full navigation
// /products?color=red → /categories?color=blue  ✗ full fetch
```

### Hooks that react to shallow navigation

All location-aware hooks re-render with the new URL. The navigation is real — only the server fetch is skipped.

| Hook                | Updates?                                                         |
| ------------------- | ---------------------------------------------------------------- |
| `useSearchParams()` | Yes — reflects new search params                                 |
| `usePathname()`     | Yes (unchanged since pathname must be the same)                  |
| `useParams()`       | Yes (unchanged since pathname must be the same)                  |
| `useNavigation()`   | `location` updates to new URL; `state` stays `"idle"` (no fetch) |

Server components do **not** re-render — the existing React tree stays as-is.

## Behavior

When `revalidate: false` and the pathname matches:

1. **No RSC fetch.** The server is not contacted.
2. **URL updates** via `history.pushState` / `replaceState`.
3. **Event controller notifies** subscribers (`setLocation`, `notify`).
4. **Hooks re-render** — all location-aware hooks reflect the new URL.
5. **Segments cached** — the current segments are copied to the new history key so back/forward restores them instantly.
6. **Server components unchanged** — no `onUpdate()` call, no tree re-render.

### Back/forward after shallow navigation

When the user presses back after a shallow navigation:

- The `popstate` handler checks the history cache.
- The cache contains the segments from the shallow entry (copied from the source page).
- The page restores instantly without a fetch — same behavior as any cached back navigation.

### Full navigation after shallow navigation

If the user does a full navigation after a shallow one, the server receives the current URL as `X-RSC-Router-Client-Path` and renders normally. No special handling needed.

## Implementation outline

### 1. Types

Add `revalidate?: boolean` to `NavigateOptions` and `LinkProps`.

### 2. Navigation bridge (`navigation-bridge.ts`)

In `navigate()`, insert an early return before the fetch when `revalidate === false` and the pathname hasn't changed:

```typescript
if (options?.revalidate === false) {
  const targetUrl = new URL(url, window.location.origin);
  const currentUrl = new URL(window.location.href);

  // Only skip revalidation for same-pathname navigations
  if (targetUrl.pathname === currentUrl.pathname) {
    const resolvedState = resolveNavigationState(options.state);
    const historyKey = generateHistoryKey(url);

    // Copy current segments to the new history key
    const currentKey = store.getHistoryKey();
    const currentCache = store.getCachedSegments(currentKey);
    if (currentCache?.segments) {
      store.cacheSegmentsForHistory(
        historyKey,
        currentCache.segments,
        currentCache.handleData,
      );
    }

    // Update browser URL
    const historyState = buildHistoryState(resolvedState, {}, {});
    if (options.replace) {
      window.history.replaceState(historyState, "", url);
    } else {
      window.history.pushState(historyState, "", url);
    }

    // Notify hooks — location updates, state stays idle
    eventController.setLocation(targetUrl);
    return;
  }

  // Pathname changed — fall through to full navigation
}
```

### 3. Link component (`Link.tsx`)

Pass `revalidate` prop through to `ctx.navigate()`:

```tsx
// In click handler:
ctx.navigate(to, { replace, scroll, state, revalidate });
```

## Non-goals

- **Server component re-rendering** — shallow navigation explicitly skips this. Use full navigation when server data must change.
- **Loader re-execution** — loaders are server-side. Shallow nav skips them entirely.
- **Cross-pathname shallow navigation** — if the path changes, you need server data. No client-side route matching or param extraction.
- **Scroll restoration** — shallow nav does not scroll to top by default (can be opt-in via `scroll: true`).
