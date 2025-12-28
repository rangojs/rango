# Trailing Slash Configuration Research

Research for adding trailing slash handling to rsc-router.

## Current Behavior

rsc-router uses **strict exact matching**:
- `/blog` and `/blog/` are treated as completely different routes
- No normalization or redirection
- 3 failing e2e tests document this as a known limitation

## Framework Comparison

| Framework | Options | Default | Per-Route? |
|-----------|---------|---------|------------|
| **Next.js** | `true` / `false` | Redirect to no slash | Via middleware only |
| **Remix** | None built-in | Manual in loader | N/A |
| **SvelteKit** | `'never'` / `'always'` / `'ignore'` | `'never'` (redirect) | Yes, in `+layout.js` |

### Next.js

- Global config in `next.config.js`: `trailingSlash: true/false`
- Default removes trailing slash (`/about/` → 301 → `/about`)
- With `trailingSlash: true`: adds slash (`/about` → 301 → `/about/`)
- `skipTrailingSlashRedirect` allows custom middleware handling
- Community requests `"preserve"` option: https://github.com/vercel/next.js/discussions/23988

### Remix

- **No built-in configuration**
- Recommended: handle manually in root loader with redirect
- Known issues with redirect loops: https://github.com/remix-run/remix/issues/7529
- React Router discussion for normalization: https://github.com/remix-run/react-router/discussions/8022

### SvelteKit (Best API)

- Three options: `'never'`, `'always'`, `'ignore'`
- **Per-route control** via `+layout.js` exports
- Documentation warns that `'ignore'` harms SEO
- Source: https://svelte.dev/docs/kit/page-options

```js
// src/routes/+layout.js
export const trailingSlash = 'always';
```

---

## Why `"ignore"` Can Be Problematic

SvelteKit documentation explains:

> Ignoring trailing slashes is not recommended — the semantics of relative paths differ between the two cases (`./y` from `/x` is `/y`, but from `/x/` is `/x/y`), and `/x` and `/x/` are treated as separate URLs which is harmful to SEO.

**Relative path differences:**
```
Current URL: /blog
Link: ./post → /post

Current URL: /blog/
Link: ./post → /blog/post
```

**SEO implications:**
- Search engines treat `/blog` and `/blog/` as different pages
- Duplicate content issues if both are accessible
- Canonical URL confusion

---

## Proposed API for rsc-router

### Option Values

| Value | Behavior | Redirect? |
|-------|----------|-----------|
| `"strict"` | Match exactly as defined | No |
| `"never"` | Remove trailing slash | 301 redirect |
| `"always"` | Add trailing slash | 301 redirect |
| `"ignore"` | Match both, no redirect | No |

### Router-Level Configuration

```typescript
const router = createRSCRouter({
  trailingSlash: "never",  // default
});
```

### Per-Route Override

```typescript
map<typeof routes>(({ route, layout, trailingSlash }) => [
  layout(<AppLayout />),

  // Inherits router default ("never")
  route("blog", <BlogPage />),

  // Override: APIs often don't care about trailing slashes
  route("api.webhook", <WebhookHandler />, () => [
    trailingSlash("ignore"),
  ]),

  // Override: static file serving might want strict
  route("files", <FileServer />, () => [
    trailingSlash("strict"),
  ]),
]);
```

### Alternative: Layout-Level Scope (like SvelteKit)

```typescript
map<typeof routes>(({ route, layout, trailingSlash }) => [
  // All routes under this layout use "always"
  layout(<MarketingLayout />, () => [
    trailingSlash("always"),

    route("home", <HomePage />),      // /home/
    route("about", <AboutPage />),    // /about/
  ]),

  // API routes ignore trailing slash
  layout(<ApiLayout />, () => [
    trailingSlash("ignore"),

    route("api.users", <UsersApi />),
  ]),
]);
```

---

## Implementation

### Where to Implement

1. **`pattern-matching.ts:findMatch()`** - normalize pathname before matching
2. **`router.ts:match()`** - return redirect response when needed

### Pseudo-Implementation

```typescript
function findMatch(pathname: string, routes: RouteEntry[], config: RouterConfig) {
  const trailingSlash = config.trailingSlash ?? "never";

  // Normalize pathname based on config
  let normalizedPath = pathname;
  let shouldRedirect = false;

  if (trailingSlash === "never" && pathname.endsWith("/") && pathname !== "/") {
    normalizedPath = pathname.slice(0, -1);
    shouldRedirect = true;
  } else if (trailingSlash === "always" && !pathname.endsWith("/")) {
    normalizedPath = pathname + "/";
    shouldRedirect = true;
  }
  // "ignore" and "strict" don't normalize

  // Try matching
  const match = tryMatch(normalizedPath, routes);

  if (!match && trailingSlash === "ignore") {
    // Try opposite slash variant
    const altPath = pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname + "/";
    return tryMatch(altPath, routes);
  }

  return { match, shouldRedirect, redirectTo: normalizedPath };
}
```

### Redirect Handling

```typescript
// In RSC handler
const { match, shouldRedirect, redirectTo } = findMatch(pathname, routes, config);

if (shouldRedirect && match) {
  return Response.redirect(new URL(redirectTo, request.url), 301);
}
```

---

## Edge Cases

### Root Path
- `/` should never redirect (it's already canonical)
- Both "never" and "always" should treat `/` as valid

### Static Files
- Paths with extensions (`/image.png`) should skip trailing slash logic
- Only apply to "clean" URLs

### Query Strings and Hashes
- Preserve query string in redirects: `/blog/?page=2` → `/blog?page=2`
- Hash fragments handled by browser, not server

### Per-Route Override Precedence
1. Route-level `trailingSlash()` (most specific)
2. Parent layout `trailingSlash()` (inherited)
3. Router-level config (default)

---

## Testing

Current failing tests to fix:
- `blog index should resolve at /blog/ (with trailing slash)`
- `product detail should resolve with trailing slash`
- `blog post should resolve with trailing slash`

New tests to add:
- Redirect behavior for "never" and "always"
- No redirect for "ignore" and "strict"
- Per-route override
- Root path handling
- Query string preservation

---

## Decision

**Recommended default:** `"never"` (remove trailing slash)

Reasons:
1. Most common convention
2. Cleaner URLs
3. Next.js default
4. Avoids duplicate content SEO issues

**Must support:** Per-route override for APIs and special cases.
