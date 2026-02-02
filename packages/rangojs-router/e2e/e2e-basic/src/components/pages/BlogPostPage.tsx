import { Link } from "@rangojs/router/client";
import type { HandlerContext } from "@rangojs/router";

interface BlogPostProps {
  params: { slug: string };
}

export function BlogPostPage({ params }: BlogPostProps) {
  return (
    <div data-testid="blog-post-page">
      <h1 data-testid="post-title">Post: {params.slug}</h1>
      <p data-testid="post-content">Content for {params.slug}</p>
      <Link to="/blog" data-testid="back-to-blog">
        ← Back to Blog
      </Link>
    </div>
  );
}
