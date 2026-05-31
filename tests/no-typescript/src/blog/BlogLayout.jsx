import { Outlet, Link } from "@rangojs/router/client";

export function BlogLayout() {
  return (
    <div data-testid="blog-layout">
      <h2>Blog</h2>
      <nav>
        <Link to="/blog" data-testid="blog-home-link">
          Blog Home
        </Link>
      </nav>
      <div data-testid="blog-content">
        <Outlet />
      </div>
    </div>
  );
}
