import { Outlet, Link } from "@rangojs/router/client";

export function BlogLayout() {
  return (
    <div data-testid="blog-layout">
      <h2>Blog Section</h2>
      <nav data-testid="blog-nav">
        <Link to="/blog" data-testid="blog-index-link">
          Blog Home
        </Link>
      </nav>
      <div data-testid="blog-content">
        <Outlet />
      </div>
    </div>
  );
}
