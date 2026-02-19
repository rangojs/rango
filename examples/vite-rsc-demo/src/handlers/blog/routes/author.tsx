import type { Author, BlogPostMeta } from "../data/mock-data.js";
import { Link } from "@rangojs/router/client";

export function AuthorPage({
  author,
  posts,
}: {
  author: Author;
  posts: BlogPostMeta[];
}) {
  return (
    <div data-testid="author-page">
      <h2>{author.name}</h2>
      <p style={{ color: "#475569", lineHeight: 1.6 }}>{author.bio}</p>

      <h3>
        Posts ({posts.length})
      </h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {posts.map((post) => (
          <li key={post.slug} style={{ marginBottom: "0.75rem" }}>
            <Link
              to={`/blog/${post.slug}`}
              style={{ color: "#3b82f6", textDecoration: "none", fontWeight: 500 }}
            >
              {post.title}
            </Link>
            <span style={{ color: "#94a3b8", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
              {post.date}
            </span>
          </li>
        ))}
      </ul>

      <p>
        <Link
          to={`/blog/author/${author.slug}/posts`}
          style={{ color: "#3b82f6" }}
        >
          View all posts by {author.name}
        </Link>
      </p>

      <p style={{ marginTop: "1rem" }}>
        <Link to="/blog" style={{ color: "#0066cc", textDecoration: "none" }}>
          Back to blog
        </Link>
      </p>
    </div>
  );
}
