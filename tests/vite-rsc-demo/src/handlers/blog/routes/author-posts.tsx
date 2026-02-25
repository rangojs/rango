import type { Author, BlogPostMeta } from "../data/mock-data.js";
import { Link } from "@rangojs/router/client";

export function AuthorPostsPage({
  author,
  posts,
}: {
  author: Author;
  posts: BlogPostMeta[];
}) {
  return (
    <div data-testid="author-posts-page">
      <h2>Posts by {author.name}</h2>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {posts.map((post) => (
          <li
            key={post.slug}
            style={{
              marginBottom: "1rem",
              padding: "0.75rem",
              background: "#f8f9fa",
              borderRadius: "6px",
            }}
          >
            <Link
              to={`/blog/${post.slug}`}
              style={{
                color: "#3b82f6",
                textDecoration: "none",
                fontWeight: 500,
                fontSize: "1.1rem",
              }}
            >
              {post.title}
            </Link>
            <div
              style={{
                color: "#94a3b8",
                fontSize: "0.8rem",
                marginTop: "0.25rem",
              }}
            >
              {post.date}
            </div>
          </li>
        ))}
      </ul>

      <p>
        <Link
          to={`/blog/author/${author.slug}`}
          style={{ color: "#0066cc", textDecoration: "none" }}
        >
          Back to {author.name}
        </Link>
        {" | "}
        <Link to="/blog" style={{ color: "#0066cc", textDecoration: "none" }}>
          Back to blog
        </Link>
      </p>
    </div>
  );
}
