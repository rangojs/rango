---
title: Pre-rendering vs Caching
excerpt: Both store RSC output, but pre-rendering happens at build time while caching happens at request time.
author: Docs Team
publishedAt: 2025-06-15
---

Caching and pre-rendering both store RSC Flight payloads to avoid re-executing handlers. The key difference is *when* the payload is produced.

## Caching

The first request triggers rendering, the result is stored for subsequent requests. Good for dynamic pages with predictable traffic patterns.

```typescript
cache({ ttl: 60, swr: 300 }, () => [
  path("/blog", BlogIndex, { name: "blog" }),
])
```

## Pre-rendering

The payload is produced during `vite build`. No first-request cost, and build-only code (markdown parsers, file system reads) can be excluded from the production bundle entirely.

```typescript
export const DocsPage = Prerender(async (ctx) => {
  const md = readFileSync("content/docs.md", "utf-8");
  return <Markdown content={md} />;
});
```

## When to Use Which

Use **caching** for pages that depend on runtime data (user sessions, real-time prices).

Use **pre-rendering** for pages whose content is fully known at build time (documentation, marketing, changelogs).
