---
title: Static Params with getParams
excerpt: Define which parameter combinations to pre-render at build time.
author: Docs Team
publishedAt: 2025-07-01
---

For dynamic routes like `/articles/:slug`, the pre-render handler needs to know which slugs to render. The `getParams` function returns the list of parameter objects.

## Basic Usage

```typescript
export const ArticlePage = Prerender(
  // First arg: getParams — returns all slugs to pre-render
  async () => [
    { slug: "what-is-prerendering" },
    { slug: "prerender-vs-cache" },
  ],
  // Second arg: handler — runs once per param set
  async (ctx) => {
    const content = readFileSync(`content/${ctx.params.slug}.md`, "utf-8");
    return <Article content={content} />;
  }
);
```

## Auto-discovery

In practice you can scan the content directory to discover all slugs automatically:

```typescript
async () => {
  const files = readdirSync("content/articles");
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ slug: f.replace(".md", "") }));
};
```

At build time, each parameter set produces a separate Flight payload. At runtime, the correct payload is served based on the URL — no file system access needed.
