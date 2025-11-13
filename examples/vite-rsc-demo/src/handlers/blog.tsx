import { map, revalidate } from "rsc-router";
import type { blogRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { BlogLayout } from "../layouts/BlogLayout.js";
import { SegmentTimer } from "../components/SegmentTimer.js";

/**
 * Blog handlers using shorthand string syntax (no helpers)
 * Demonstrates simple revalidation
 */
export default map<typeof blogRoutes>({
  // Global layouts - apply to all blog routes
  "$layout.*.root": <RootLayout />,
  "$layout.*.blog": <BlogLayout />,

  // Global middleware - apply to all blog routes
  "$middleware.*.logger": [
    (_ctx, next) => {
      console.log("Blog route accessed");
      next();
    },
  ],

  // Revalidation - demonstrates default behavior
  // Only revalidate blog post if slug actually changes
  [revalidate("post")]: ({ currentParams, nextParams, defaultShouldRevalidate }) => {
    console.log(`[Blog] Checking revalidation: ${currentParams.slug} → ${nextParams.slug}`);
    // Defer to default: true if slug changed, false otherwise
    return defaultShouldRevalidate;
  },

  // Route handlers - using shorthand string syntax
  index: () => (
    <div>
      <h2>Blog Posts</h2>
      <p className="segment-id">Segment: Blog Index Route</p>
      <ul>
        <li>
          <a href="/blog/hello-world">Hello World</a>
        </li>
        <li>
          <a href="/blog/react-server-components">React Server Components</a>
        </li>
        <li>
          <a href="/blog/router-design">Router Design</a>
        </li>
      </ul>
    </div>
  ),

  post: (ctx) => {
    const renderTime = new Date().toISOString();
    const queryParams = Array.from(ctx.searchParams.entries());

    return (
      <div>
        <h2>
          {ctx.params.slug
            .split("-")
            .map((w: string) => w[0].toUpperCase() + w.slice(1))
            .join(" ")}
        </h2>
        <p className="segment-id">Segment: Blog Post Route</p>
        <p>
          <strong>Slug (route param):</strong> <code>{ctx.params.slug}</code>
        </p>
        <div style={{
          background: '#f0f9ff',
          padding: '0.75rem',
          borderRadius: '4px',
          marginTop: '0.5rem',
        }}>
          <strong>Query Params (read from searchParams):</strong>{' '}
          {queryParams.length > 0 ? (
            <code>{queryParams.map(([k, v]) => `${k}=${v}`).join('&')}</code>
          ) : (
            <em style={{ color: '#666' }}>none</em>
          )}
        </div>
        <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.5rem' }}>
          ⚠️ Note: Query params are rendered from <code>ctx.searchParams</code> at render time.
          If segment doesn't re-render (revalidation = false), query display won't update!
        </p>

        <SegmentTimer
          segmentId="R2.1 (Blog Post)"
          serverRenderTime={renderTime}
        />

        <div style={{ marginTop: '1rem', padding: '1rem', background: '#f8f9fa', borderRadius: '4px' }}>
          <h4 style={{ marginTop: 0 }}>Test Revalidation:</h4>
          <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
            <li>
              <a href="/blog/hello-world">Navigate to hello-world</a> (slug changes → timer resets)
            </li>
            <li>
              <a href={`/blog/${ctx.params.slug}?tab=1`}>Add ?tab=1</a> (query only → timer keeps running)
            </li>
            <li>
              <a href={`/blog/${ctx.params.slug}?tab=2`}>Change to ?tab=2</a> (query change → timer keeps running)
            </li>
          </ul>
          <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.5rem', marginBottom: 0 }}>
            <strong>Expected:</strong> Timer resets only when slug changes, not when query params change.
          </p>
        </div>

        <p style={{ marginTop: '1rem' }}>
          <a href="/blog">← Back to blog</a>
        </p>
      </div>
    );
  },
});
