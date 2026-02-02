import { urls } from "@rangojs/router";
import { Meta, notFound } from "@rangojs/router/server";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { AppShell } from "./components/AppShell.js";
import { RootLayout } from "./components/SlowRootLayout.js";
import { Counter } from "./components/Counter.js";
import { FeatureLoading } from "./components/FeatureLoading.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { Breadcrumbs } from "./handles/breadcrumbs.js";
import { FeatureLocationState } from "./location-states.js";
import {
  getBlogPosts,
  getBlogPost,
  BlogSidebarLoader,
  type BlogSidebarData,
} from "./loaders/blog.js";
import { getCounter } from "./actions/counter.js";

// Features data
const features = [
  {
    slug: "server-components",
    name: "Server Components",
    description: "React components that render on the server",
  },
  {
    slug: "server-actions",
    name: "Server Actions",
    description: "Functions that run on the server",
  },
  {
    slug: "streaming",
    name: "Streaming",
    description: "Progressive rendering with Suspense",
  },
];

const featuresDetail: Record<string, { name: string; description: string; details: string }> = {
  "server-components": {
    name: "Server Components",
    description: "React components that render on the server",
    details: "Server Components allow you to write UI that can be rendered and optionally cached on the server. They run only on the server, reducing bundle size and improving performance.",
  },
  "server-actions": {
    name: "Server Actions",
    description: "Functions that run on the server",
    details: "Server Actions are async functions that run on the server. They can be called from Client Components and provide a simple way to handle form submissions and mutations.",
  },
  streaming: {
    name: "Streaming",
    description: "Progressive rendering with Suspense",
    details: "RSC streaming allows you to progressively render UI as data becomes available. Combined with Suspense boundaries, you can show loading states while content streams in.",
  },
};

// Blog components
function BlogLayout() {
  return (
    <div data-testid="blog-layout" style={{ display: "flex", gap: "2rem" }}>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
      <aside style={{ width: "280px", flexShrink: 0 }}>
        <ParallelOutlet name="@sidebar" />
      </aside>
    </div>
  );
}

function BlogSidebar({ data }: { data: BlogSidebarData }) {
  return (
    <div
      data-testid="blog-sidebar"
      style={{ padding: "1rem", background: "#f9f9f9", borderRadius: "8px" }}
    >
      <h3 style={{ marginBottom: "1rem", fontSize: "1rem" }}>Recent Posts</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {data.recentPosts.map((post) => (
          <li key={post.slug} style={{ marginBottom: "0.75rem" }}>
            <Link
              to={`/blog/${post.slug}`}
              style={{
                color: "#0070f3",
                textDecoration: "none",
                fontSize: "0.875rem",
              }}
              data-testid={`sidebar-link-${post.slug}`}
            >
              {post.title}
            </Link>
          </li>
        ))}
      </ul>
      <h3 style={{ marginTop: "1.5rem", marginBottom: "1rem", fontSize: "1rem" }}>
        Popular Tags
      </h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {data.popularTags.map((tag) => (
          <span
            key={tag}
            style={{
              fontSize: "0.75rem",
              padding: "0.25rem 0.5rem",
              background: "#e0e0e0",
              borderRadius: "4px",
            }}
            data-testid={`sidebar-tag-${tag}`}
          >
            {tag}
          </span>
        ))}
      </div>
      <p
        data-testid="sidebar-rendered-at"
        style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#999" }}
      >
        Sidebar rendered at:
        <br />
        {data.loadedAt}
      </p>
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div
      data-testid="sidebar-skeleton"
      style={{ padding: "1rem", background: "#f5f5f5", borderRadius: "8px" }}
    >
      <div style={{ height: "1.25rem", background: "#ddd", borderRadius: "4px", marginBottom: "1rem", width: "60%" }} />
      <div style={{ height: "0.875rem", background: "#ddd", borderRadius: "4px", marginBottom: "0.75rem", width: "90%" }} />
      <div style={{ height: "0.875rem", background: "#ddd", borderRadius: "4px", marginBottom: "0.75rem", width: "75%" }} />
      <div style={{ height: "0.875rem", background: "#ddd", borderRadius: "4px", marginBottom: "1.5rem", width: "85%" }} />
      <div style={{ height: "1.25rem", background: "#ddd", borderRadius: "4px", marginBottom: "1rem", width: "50%" }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ height: "1.5rem", width: "3rem", background: "#ddd", borderRadius: "4px" }} />
        <div style={{ height: "1.5rem", width: "4rem", background: "#ddd", borderRadius: "4px" }} />
        <div style={{ height: "1.5rem", width: "3.5rem", background: "#ddd", borderRadius: "4px" }} />
      </div>
      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#999" }}>Loading sidebar...</p>
    </div>
  );
}

// Slow data table component
async function DataTable() {
  const renderTime = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const data = Array.from({ length: 50 }, (_, i) => ({
    id: `item-${i + 1}`,
    name: `Item ${i + 1}`,
    value: (i * 17 + 42) % 1000,
    status: ["Active", "Pending", "Completed"][i % 3],
  }));

  return (
    <div data-testid="slow-data-table">
      <p data-testid="render-time" style={{ color: "#666", marginBottom: "1rem" }}>
        Rendered at: {renderTime}
      </p>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        This component has a 2s delay. Cached requests show the same render time.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f5f5f5" }}>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>ID</th>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>Name</th>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>Value</th>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.id}>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.id}</td>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.name}</td>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.value}</td>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Slow page components
async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function SlowContent({ name, delayMs }: { name: string; delayMs: number }) {
  const start = Date.now();
  await delay(delayMs);
  const elapsed = Date.now() - start;

  return (
    <div>
      <h1>Slow Page {name}</h1>
      <p>This page took {elapsed}ms to load (simulated {delayMs}ms delay).</p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        Navigate between pages to see the loading indicator appear after 400ms.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to="/slow/1" style={{ color: "#0070f3" }}>Slow 1</Link>
        <Link to="/slow/2" style={{ color: "#0070f3" }}>Slow 2</Link>
        <Link to="/slow/fast" style={{ color: "#22c55e" }}>Fast</Link>
        <Link to="/" style={{ color: "#666" }}>Home</Link>
      </nav>
    </div>
  );
}

function FastContent() {
  return (
    <div>
      <h1>Fast Page</h1>
      <p>This page loads instantly (no delay).</p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        The progress bar should NOT appear when navigating here.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to="/slow/1" style={{ color: "#0070f3" }}>Slow 1</Link>
        <Link to="/slow/2" style={{ color: "#0070f3" }}>Slow 2</Link>
        <Link to="/slow/fast" style={{ color: "#22c55e" }}>Fast</Link>
        <Link to="/" style={{ color: "#666" }}>Home</Link>
      </nav>
    </div>
  );
}

/**
 * Main URL patterns - Django-style routing API
 */
export const urlpatterns = urls(({ path, layout, include, parallel, loader, loading, cache }) => [
  // Home route
  path("/", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Home - RSC Router Cloudflare" });
    meta({ name: "description", content: "A minimal RSC Router example running on Cloudflare Workers" });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });

    return (
      <main data-testid="home-page">
        <h1 data-testid="home-title">Welcome to RSC Router</h1>
        <p>This is a minimal example running on Cloudflare Workers.</p>
        <p>It demonstrates:</p>
        <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
          <li>React Server Components with RSC streaming</li>
          <li>Client-side navigation with partial rendering</li>
          <li>Server Actions (see the Counter page)</li>
          <li>Cloudflare Workers deployment</li>
        </ul>
        <h2 style={{ marginTop: "2rem" }}>Features</h2>
        <p style={{ marginBottom: "1rem" }}>
          Click a feature to see details (with location state for instant loading preview):
        </p>
        <ul style={{ marginLeft: "1.5rem" }} data-testid="feature-links">
          {features.map((feature) => (
            <li key={feature.slug} style={{ marginBottom: "0.5rem" }}>
              <Link
                to={`/features/${feature.slug}`}
                state={[FeatureLocationState({ name: feature.name, description: feature.description })]}
                data-testid={`feature-link-${feature.slug}`}
                style={{ color: "#0070f3", textDecoration: "none" }}
              >
                {feature.name}
              </Link>
              {" - "}
              <span style={{ color: "#666" }}>{feature.description}</span>
            </li>
          ))}
        </ul>
      </main>
    );
  }, { name: "home" }),

  // About route
  path("/about", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "About - RSC Router Cloudflare" });
    meta({ name: "description", content: "Learn about RSC Router - a code-first, type-safe router for React Server Components" });
    meta({ property: "og:title", content: "About RSC Router" });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });
    breadcrumb({ label: "About", href: "/about" });

    return (
      <main data-testid="about-page">
        <h1 data-testid="about-title">About</h1>
        <p>RSC Router is a code-first, type-safe router for React Server Components.</p>
        <p style={{ marginTop: "1rem" }}>
          Built for serverless deployments like Cloudflare Workers, it provides:
        </p>
        <ul style={{ marginTop: "1rem", marginLeft: "1.5rem" }}>
          <li>Nested routes with layout composition</li>
          <li>Type-safe params extraction</li>
          <li>Partial rendering optimization</li>
          <li>Server Actions with automatic revalidation</li>
          <li>Middleware support</li>
        </ul>
      </main>
    );
  }, { name: "about" }),

  // Counter route
  path("/counter", async (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Counter - RSC Router Cloudflare" });
    meta({ name: "description", content: "Interactive counter demo with Server Actions on Cloudflare Workers" });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });
    breadcrumb({ label: "Counter", href: "/counter" });

    const initialCount = await getCounter();

    return (
      <main data-testid="counter-page">
        <h1 data-testid="counter-title">Counter Demo</h1>
        <p style={{ marginBottom: "1rem" }}>
          This demonstrates Server Actions with client-side state management.
        </p>
        <Counter initialCount={initialCount} />
        <div style={{ marginTop: "2rem", color: "#666", fontSize: "0.9rem" }}>
          <p>How it works:</p>
          <ul style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
            <li>Counter state lives on the client (useState)</li>
            <li>Increment/decrement call Server Actions</li>
            <li>Server Actions run on Cloudflare Workers</li>
            <li>useTransition provides pending state</li>
          </ul>
        </div>
      </main>
    );
  }, { name: "counter" }),

  // Features route
  path("/features/:slug", async (ctx) => {
    const slug = ctx.params.slug;
    const feature = featuresDetail[slug];

    if (!feature) {
      throw new Error(`Feature not found: ${slug}`);
    }

    const meta = ctx.use(Meta);
    meta({ title: `${feature.name} - RSC Router Cloudflare` });
    meta({ name: "description", content: feature.description });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });
    breadcrumb({ label: feature.name, href: `/features/${slug}` });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    return (
      <main data-testid="feature-page">
        <h1 data-testid="feature-title">{feature.name}</h1>
        <p data-testid="feature-description" style={{ marginBottom: "1rem", color: "#666" }}>
          {feature.description}
        </p>
        <p data-testid="feature-details">{feature.details}</p>
      </main>
    );
  }, { name: "featuresDetail" }, () => [loading(<FeatureLoading />)]),

  // Blog routes
  layout((ctx) => {
    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });
    breadcrumb({ label: "Blog", href: "/blog" });
    return <BlogLayout />;
  }, () => [
    parallel({
      "@sidebar": async (ctx) => {
        const data = await ctx.use(BlogSidebarLoader);
        return <BlogSidebar data={data} />;
      },
    }, () => [
      loader(BlogSidebarLoader, () => [cache()]),
      loading(<SidebarSkeleton />),
    ]),

    cache({ ttl: 60, swr: 300 }, () => [
      path("/blog", (ctx) => {
        ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

        const meta = ctx.use(Meta);
        meta({ title: "Blog - RSC Router Cloudflare" });
        meta({ name: "description", content: "Read our latest articles about RSC, Cloudflare, and web development" });

        const posts = getBlogPosts();

        return (
          <div data-testid="blog-index">
            <h1 data-testid="blog-title">Blog</h1>
            <p style={{ color: "#666", marginBottom: "2rem" }}>
              Articles about RSC, Cloudflare Workers, and modern web development.
            </p>
            <div data-testid="blog-posts-list">
              {posts.map((post) => (
                <article
                  key={post.slug}
                  style={{ marginBottom: "2rem", paddingBottom: "1.5rem", borderBottom: "1px solid #eee" }}
                  data-testid={`blog-post-${post.slug}`}
                >
                  <h2 style={{ marginBottom: "0.5rem" }}>
                    <Link to={`/blog/${post.slug}`} style={{ color: "#0070f3", textDecoration: "none" }} data-testid={`blog-link-${post.slug}`}>
                      {post.title}
                    </Link>
                  </h2>
                  <p style={{ color: "#666", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                    By {post.author} on {post.publishedAt}
                  </p>
                  <p style={{ marginBottom: "0.5rem" }}>{post.excerpt}</p>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    {post.tags.map((tag) => (
                      <span key={tag} style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", background: "#f0f0f0", borderRadius: "4px" }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <p data-testid="cache-info" style={{ marginTop: "2rem", fontSize: "0.875rem", color: "#999" }}>
              This page is cached at the edge with TTL=60s, SWR=300s.
              <br />
              Rendered at: {new Date().toISOString()}
            </p>
          </div>
        );
      }, { name: "blog" }),

      path("/blog/:slug", (ctx) => {
        ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
        const post = getBlogPost(ctx.params.slug);

        if (!post) {
          notFound();
        }

        const meta = ctx.use(Meta);
        meta({ title: `${post.title} - Blog - RSC Router` });
        meta({ name: "description", content: post.excerpt });

        const breadcrumb = ctx.use(Breadcrumbs);
        breadcrumb({ label: post.title, href: `/blog/${post.slug}` });

        return (
          <article data-testid="blog-post-detail">
            <nav style={{ marginBottom: "1rem", paddingBottom: "0.5rem", borderBottom: "1px solid #eee" }}>
              <Link to="/blog" style={{ color: "#0070f3", textDecoration: "none" }}>&larr; Back to Blog</Link>
            </nav>
            <header style={{ marginBottom: "2rem" }}>
              <h1 data-testid="post-title">{post.title}</h1>
              <p style={{ color: "#666", fontSize: "0.875rem" }}>
                By <span data-testid="post-author">{post.author}</span> on <span data-testid="post-date">{post.publishedAt}</span>
              </p>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                {post.tags.map((tag) => (
                  <span key={tag} style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", background: "#f0f0f0", borderRadius: "4px" }}>
                    {tag}
                  </span>
                ))}
              </div>
            </header>
            <div data-testid="post-content" style={{ lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
              {post.content}
            </div>
            <footer data-testid="cache-info" style={{ marginTop: "3rem", paddingTop: "1rem", borderTop: "1px solid #eee", fontSize: "0.875rem", color: "#999" }}>
              This page is cached at the edge with TTL=60s, SWR=300s.
              <br />
              Rendered at: {new Date().toISOString()}
            </footer>
          </article>
        );
      }, { name: "blogPost" }),
    ]),
  ]),

  // Proactive cache routes
  cache({ ttl: 600 }, () => [
    layout(() => (
      <div data-testid="proactive-cache-layout">
        <h2 data-testid="proactive-layout-title">Proactive Cache Layout</h2>
        <p data-testid="proactive-layout-rendered">Layout rendered at: {new Date().toISOString()}</p>
        <nav data-testid="proactive-nav">
          <Link to="/" data-testid="proactive-back-home">Home</Link>
          {" | "}
          <Link to="/proactive-cache" data-testid="proactive-nav-index">Index</Link>
          {" | "}
          <Link to="/proactive-cache/item-a" data-testid="proactive-nav-a">Item A</Link>
          {" | "}
          <Link to="/proactive-cache/item-b" data-testid="proactive-nav-b">Item B</Link>
        </nav>
        <Outlet />
      </div>
    ), () => [
      path("/proactive-cache", () => (
        <div data-testid="proactive-index-page">
          <h3>Proactive Cache Index</h3>
          <p data-testid="proactive-index-rendered">Index rendered at: {new Date().toISOString()}</p>
        </div>
      ), { name: "proactiveCache" }),

      path("/proactive-cache/item-a", () => (
        <div data-testid="proactive-item-a-page">
          <h3>Item A</h3>
          <p data-testid="proactive-item-a-rendered">Item A rendered at: {new Date().toISOString()}</p>
        </div>
      ), { name: "proactiveCacheItemA" }),

      path("/proactive-cache/item-b", () => (
        <div data-testid="proactive-item-b-page">
          <h3>Item B</h3>
          <p data-testid="proactive-item-b-rendered">Item B rendered at: {new Date().toISOString()}</p>
        </div>
      ), { name: "proactiveCacheItemB" }),
    ]),
  ]),

  // Document cache route
  path("/document-cache", (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Document Cache Test - RSC Router" });
    ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return (
      <main data-testid="document-cache-page">
        <h1>Document Cache Test</h1>
        <p>Rendered at: {new Date().toISOString()}</p>
        <p>Check response headers for <code>x-document-cache-status</code></p>
      </main>
    );
  }, { name: "documentCache" }),

  // Slow cache route
  cache({ ttl: 60, swr: 300 }, () => [
    layout(<RootLayout />),
    path("/slow-cache", (ctx) => {
      const meta = ctx.use(Meta);
      meta({ title: "Slow Cache Test - RSC Router" });

      return (
        <main data-testid="slow-cache-page">
          <h1>Cache Test</h1>
          <p style={{ marginBottom: "1rem" }}>This page tests edge caching behavior.</p>
          <DataTable />
        </main>
      );
    }, { name: "slowCache" }),
  ]),

  // Theme route
  layout(<RootLayout />, () => [
    path("/theme", (ctx) => (
      <div className="theme-page">
        <h1>Theme Demo</h1>
        <p>
          This page demonstrates the theme system with <code>useTheme</code> hook and server-side <code>ctx.theme</code>.
        </p>
        <div className="server-info">
          <h2>Server-Side Theme</h2>
          <p>Current theme from server: <strong>{ctx.theme}</strong></p>
          <p className="note">The server reads the theme from cookies to avoid flash of unstyled content (FOUC).</p>
        </div>
        <div className="client-info">
          <h2>Client-Side Theme Toggle</h2>
          <ThemeToggle />
        </div>
        <div className="features">
          <h2>Features</h2>
          <ul>
            <li><strong>No FOUC</strong> - Theme is applied before paint via inline script</li>
            <li><strong>System detection</strong> - Automatically detects <code>prefers-color-scheme</code></li>
            <li><strong>Persistence</strong> - Theme saved in localStorage and cookies</li>
            <li><strong>SSR support</strong> - Server reads theme from cookies</li>
            <li><strong>Cross-tab sync</strong> - Theme changes sync across tabs</li>
          </ul>
        </div>
        <Link to="/">Back to Home</Link>
        <style dangerouslySetInnerHTML={{ __html: `
          .theme-page h1 { margin-bottom: 1rem; }
          .theme-page h2 { margin: 1.5rem 0 0.5rem; font-size: 1.25rem; }
          .server-info, .client-info, .features { padding: 1rem; margin: 1rem 0; border: 1px solid var(--border-color, #eee); border-radius: 8px; }
          .note { font-size: 0.875rem; color: #666; font-style: italic; }
          .features ul { margin-left: 1.5rem; }
          .features li { margin: 0.5rem 0; }
          code { background: #f0f0f0; padding: 0.125rem 0.25rem; border-radius: 4px; font-size: 0.875rem; }
          .dark .server-info, .dark .client-info, .dark .features { border-color: #444; }
          .dark .note { color: #999; }
          .dark code { background: #333; }
        `}} />
      </div>
    ), { name: "theme" }),
  ]),

  // Slow routes
  layout(<RootLayout />, () => [
    path("/slow/1", () => <SlowContent name="1" delayMs={5000} />, { name: "slow1" }),
    path("/slow/2", () => <SlowContent name="2" delayMs={5000} />, { name: "slow2" }),
    path("/slow/fast", () => <FastContent />, { name: "fast" }),
  ]),

  // Inline routes demo
  layout(<RootLayout />, () => [
    path("/inline", () => (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-4">Inline Routes Demo</h1>
        <p className="text-gray-600 mb-6">This page is defined inline in urls.tsx</p>
        <nav className="flex gap-4">
          <Link to="/inline/docs" className="text-blue-600 hover:underline">Docs</Link>
          <Link to="/inline/pricing" className="text-blue-600 hover:underline">Pricing</Link>
        </nav>
      </div>
    ), { name: "index" }),
    path("/inline/docs", () => (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-4">Documentation</h1>
        <Link to="/inline" className="text-blue-600 hover:underline">&larr; Back</Link>
      </div>
    ), { name: "docs" }),
    path("/inline/pricing", () => (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-4">Pricing</h1>
        <Link to="/inline" className="text-blue-600 hover:underline">&larr; Back</Link>
      </div>
    ), { name: "pricing" }),
  ]),
]);
