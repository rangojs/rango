import { createLoader } from "@rangojs/router";

/**
 * Blog post data structure
 */
export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  author: string;
  publishedAt: string;
  tags: string[];
}

/**
 * Static blog posts data (simulates database/CMS)
 * Exported so route handlers can read directly (gets cached with RSC output)
 */
export const blogPosts: BlogPost[] = [
  {
    slug: "getting-started-with-rsc",
    title: "Getting Started with React Server Components",
    excerpt: "Learn how to build modern web applications with RSC.",
    content: `
React Server Components (RSC) represent a paradigm shift in how we build React applications.
Unlike traditional client-side React, RSC allows components to render on the server,
reducing bundle size and improving performance.

## Key Benefits

1. **Zero Bundle Size**: Server components don't add to your JavaScript bundle
2. **Direct Backend Access**: Query databases directly without API layers
3. **Automatic Code Splitting**: Only ship the code clients actually need

## Getting Started

To use RSC with rsc-router, simply create your components as regular React components.
By default, all components are server components unless marked with "use client".

\`\`\`tsx
// This is a Server Component by default
export function BlogPost({ slug }: { slug: string }) {
  // Can directly access database here
  const post = await db.posts.findBySlug(slug);
  return <article>{post.content}</article>;
}
\`\`\`
    `.trim(),
    author: "RSC Team",
    publishedAt: "2024-01-15",
    tags: ["react", "rsc", "tutorial"],
  },
  {
    slug: "cloudflare-workers-deployment",
    title: "Deploying RSC to Cloudflare Workers",
    excerpt: "A guide to deploying your RSC application on the edge.",
    content: `
Cloudflare Workers provides an excellent platform for RSC applications.
With edge deployment, your server components render close to your users,
resulting in minimal latency.

## Why Cloudflare Workers?

- **Global Edge Network**: 300+ data centers worldwide
- **Low Latency**: ~50ms cold starts
- **Cost Effective**: Generous free tier

## Setting Up

1. Install wrangler: \`npm install -g wrangler\`
2. Configure wrangler.json
3. Deploy: \`wrangler deploy\`

## Caching with CF Cache API

The CF Cache API allows you to cache RSC responses at the edge:

\`\`\`typescript
import { CFCacheStore } from "@rangojs/router/cache";

const cacheStore = new CFCacheStore({
  defaults: { ttl: 60, swr: 300 }
});
\`\`\`

This gives you stale-while-revalidate behavior automatically!
    `.trim(),
    author: "Edge Team",
    publishedAt: "2024-02-01",
    tags: ["cloudflare", "deployment", "edge"],
  },
  {
    slug: "understanding-caching-strategies",
    title: "Understanding RSC Caching Strategies",
    excerpt: "Deep dive into cache patterns for optimal performance.",
    content: `
Caching is crucial for RSC performance. This guide covers the different
caching strategies available in rsc-router.

## Cache Types

### 1. Route-Level Caching

Wrap routes in \`cache()\` to cache entire route segments:

\`\`\`typescript
cache({ ttl: 60 }, () => [
  route("blog.index", <BlogIndex />)
])
\`\`\`

### 2. Stale-While-Revalidate (SWR)

SWR serves stale content while refreshing in the background:

\`\`\`typescript
cache({ ttl: 60, swr: 300 }, () => [...])
\`\`\`

- First 60s: Fresh content served
- 60s-360s: Stale content served, background refresh triggered
- After 360s: Cache miss, fresh fetch required

### 3. Loader Exclusion

By design, loaders are NOT cached with route segments.
This ensures dynamic data stays fresh while static UI is cached.

## Best Practices

1. Cache static layouts and UI components
2. Keep loaders fresh for dynamic data
3. Use SWR for content that changes occasionally
4. Set appropriate TTLs based on content update frequency
    `.trim(),
    author: "Cache Team",
    publishedAt: "2024-02-15",
    tags: ["caching", "performance", "swr"],
  },
];

/**
 * Get all blog posts (for index page)
 * Direct function call - gets cached with RSC output via cache() wrapper
 */
export function getBlogPosts() {
  console.log("[getBlogPosts] Reading blog posts list");
  return blogPosts.map(
    ({ slug, title, excerpt, author, publishedAt, tags }) => ({
      slug,
      title,
      excerpt,
      author,
      publishedAt,
      tags,
    }),
  );
}

/**
 * Get a single blog post by slug
 * Direct function call - gets cached with RSC output via cache() wrapper
 */
export function getBlogPost(slug: string): BlogPost | null {
  console.log(`[getBlogPost] Reading post: ${slug}`);
  return blogPosts.find((p) => p.slug === slug) ?? null;
}

/**
 * Sidebar data loader - simulates slow async fetch for streaming demo
 * Returns recent posts and popular tags
 */
export const BlogSidebarLoader = createLoader(async () => {
  console.log("[BlogSidebarLoader] Fetching sidebar data...");

  // Simulate slow database query to demonstrate streaming
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Get recent posts (first 3)
  const recentPosts = blogPosts.slice(0, 3).map(({ slug, title }) => ({
    slug,
    title,
  }));

  // Collect all unique tags
  const allTags = blogPosts.flatMap((p) => p.tags);
  const popularTags = [...new Set(allTags)].slice(0, 6);

  console.log("[BlogSidebarLoader] Sidebar data loaded");

  return {
    recentPosts,
    popularTags,
    loadedAt: new Date().toISOString(),
  };
});

export type BlogListData = ReturnType<typeof getBlogPosts>;
export type BlogPostData = BlogPost;

export interface BlogSidebarData {
  recentPosts: { slug: string; title: string }[];
  popularTags: string[];
  loadedAt: string;
}
