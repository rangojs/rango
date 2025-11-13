import { map } from "rsc-router";
import type { blogRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { BlogLayout } from "../layouts/BlogLayout.js";

/**
 * Blog handlers using shorthand string syntax (no helpers)
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

  post: (ctx) => (
    <div>
      <h2>
        {ctx.params.slug
          .split("-")
          .map((w: string) => w[0].toUpperCase() + w.slice(1))
          .join(" ")}
      </h2>
      <p className="segment-id">Segment: Blog Post Route</p>
      <p>
        <strong>Slug:</strong> <code>{ctx.params.slug}</code>
      </p>
      <p>This is a blog post about {ctx.params.slug}.</p>
      <p>
        <a href="/blog">← Back to blog</a>
      </p>
    </div>
  ),
});
