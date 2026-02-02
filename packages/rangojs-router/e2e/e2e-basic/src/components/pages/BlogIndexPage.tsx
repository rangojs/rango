import { Link } from "@rangojs/router/client";

export function BlogIndexPage() {
  return (
    <div data-testid="blog-index-page">
      <h1 data-testid="blog-title">Blog</h1>
      <ul data-testid="blog-posts">
        <li>
          <Link to="/blog/hello-world" data-testid="post-link-1">
            Hello World
          </Link>
        </li>
        <li>
          <Link to="/blog/getting-started" data-testid="post-link-2">
            Getting Started
          </Link>
        </li>
      </ul>
    </div>
  );
}
