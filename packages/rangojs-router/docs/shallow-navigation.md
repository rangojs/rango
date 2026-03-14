# Shallow Navigation

RFC for client-only URL updates that skip server RSC fetches.

## Problem

Some URL changes don't need a server round-trip. Examples:

- Toggling a filter: `/products?color=red` → `/products?color=blue`
- Pagination with client-side data: `/list?page=2` → `/list?page=3`
- Updating a tab: `/settings#billing` → `/settings#profile`
- Syncing ephemeral UI state to the URL for shareability / back-forward support

Today, every `router.push()` or `<Link>` click triggers a partial RSC fetch. For purely client-driven state this is wasteful — the server re-executes the handler and loaders only to produce identical output (or output the client already has).

## Proposed API

### `useRouter()`

```tsx
const router = useRouter();

// Full navigation (default — fetches RSC from server)
router.push("/products?color=blue");

// Shallow navigation (URL-only, no server fetch)
router.push("/products?color=blue", { shallow: true });
router.replace("/products?page=3", { shallow: true });
```

### `<Link>`

```tsx
<Link to="/products?color=blue" shallow>Blue</Link>
<Link to="/products?color=blue" shallow replace>Blue</Link>
```

### Hooks that react to shallow navigation

These hooks subscribe to the event controller and will re-render:

| Hook                | Updates on shallow nav?            |
| ------------------- | ---------------------------------- |
| `useSearchParams()` | Yes                                |
| `usePathname()`     | Yes                                |
| `useParams()`       | Yes (if path params change)        |
| `useNavigation()`   | No (state stays "idle" — no fetch) |

Server components do **not** re-render — the existing React tree stays as-is.

## Behavior

When `shallow: true`:

1. **No RSC fetch.** The server is not contacted.
2. **URL updates** via `history.pushState` / `replaceState`.
3. **Event controller notifies** subscribers (`setLocation`, `setParams`, `notify`).
4. **Hooks re-render** — `useSearchParams()`, `usePathname()`, `useParams()` reflect the new URL.
5. **Segments cached** — the current segments are copied to the new history key so back/forward restores them instantly.
6. **Server components unchanged** — no `onUpdate()` call, no tree re-render.

### Back/forward after shallow navigation

When the user presses back after a shallow navigation:

- The `popstate` handler checks the history cache.
- The cache contains the segments from the shallow entry (copied from the source page).
- The page restores instantly without a fetch — same behavior as any cached back navigation.

### Full navigation after shallow navigation

If the user does a full (non-shallow) navigation after a shallow one, the server receives the current URL as `X-RSC-Router-Client-Path` and renders normally. No special handling needed.

## Implementation outline

### 1. Types

Add `shallow?: boolean` to `NavigateOptions` and `LinkProps`.

### 2. Navigation bridge (`navigation-bridge.ts`)

In `navigate()`, insert an early return before the fetch:

```typescript
if (options?.shallow) {
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

  // Notify hooks
  const targetUrl = new URL(url, window.location.origin);
  eventController.setLocation(targetUrl);
  // Extract params from current segments (no server match available)
  // For search-only changes, params stay the same.
  return;
}
```

### 3. Link component (`Link.tsx`)

Pass `shallow` prop through to `ctx.navigate()`:

```tsx
// In click handler:
ctx.navigate(to, { replace, scroll, state, shallow });
```

### 4. Params extraction for shallow path changes

When the path changes during shallow nav (e.g., `/blog/post-1` → `/blog/post-2`), we need to extract route params client-side. Options:

- **Use the serialized trie** — it's already in the client bundle for prefetch matching. Call `tryTrieMatch()` on the new URL to get params.
- **Keep previous params** — simpler, correct for search-only changes. For path changes, the caller is responsible for knowing the params won't be server-validated.

Recommend: use the trie for correctness when available, fall back to previous params.

## Non-goals

- **Server component re-rendering** — shallow navigation explicitly skips this. Use full navigation when server data must change.
- **Loader re-execution** — loaders are server-side. Shallow nav skips them entirely.
- **Scroll restoration** — shallow nav does not scroll to top by default (can be opt-in via `scroll: true`).

## Open questions

1. Should `shallow` be allowed when the **route** changes (different path pattern), or only for same-route navigations (search param / hash changes)?
2. Should there be a `router.shallow(url)` convenience method, or is `{ shallow: true }` sufficient?
3. Should `useNavigation()` report a brief "loading" state for shallow nav, or stay "idle" throughout?
