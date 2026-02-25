import type { BlogSidebarData } from "../loaders/sidebar.js";

/**
 * Blog Sidebar component - displays recent posts, categories, and tags
 */
export function BlogSidebar({ data }: { data: BlogSidebarData }) {
  return (
    <aside
      style={{
        padding: "1rem",
        backgroundColor: "#f5f5f5",
        borderRadius: "8px",
        minWidth: "250px",
      }}
    >
      <p className="segment-id">Segment: BlogSidebar (parallel)</p>

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>
          Recent Posts
        </h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {data.recentPosts.map((post) => (
            <li key={post.slug} style={{ marginBottom: "0.5rem" }}>
              <a
                href={`/blog/${post.slug}`}
                style={{ color: "#0066cc", textDecoration: "none" }}
              >
                {post.title}
              </a>
              <div style={{ fontSize: "0.75rem", color: "#666" }}>
                {post.date}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>
          Categories
        </h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {data.categories.map((cat) => (
            <li
              key={cat.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "0.25rem",
              }}
            >
              <span>{cat.name}</span>
              <span
                style={{
                  backgroundColor: "#ddd",
                  borderRadius: "10px",
                  padding: "0 0.5rem",
                  fontSize: "0.75rem",
                }}
              >
                {cat.count}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>Tags</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {data.tags.map((tag) => (
            <span
              key={tag}
              style={{
                backgroundColor: "#e0e0e0",
                borderRadius: "4px",
                padding: "0.25rem 0.5rem",
                fontSize: "0.75rem",
              }}
            >
              #{tag}
            </span>
          ))}
        </div>
      </section>
    </aside>
  );
}

/**
 * Blog Sidebar Skeleton - shown during loading
 */
export function BlogSidebarSkeleton() {
  return (
    <aside
      style={{
        padding: "1rem",
        backgroundColor: "#f5f5f5",
        borderRadius: "8px",
        minWidth: "250px",
        animation: "pulse 1.5s ease-in-out infinite",
      }}
    >
      <p className="segment-id" style={{ color: "#999" }}>
        Loading Sidebar...
      </p>

      <section style={{ marginBottom: "1.5rem" }}>
        <div
          style={{
            height: "1rem",
            width: "100px",
            backgroundColor: "#ddd",
            borderRadius: "4px",
            marginBottom: "0.75rem",
          }}
        />
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ marginBottom: "0.5rem" }}>
            <div
              style={{
                height: "0.875rem",
                width: `${150 + i * 20}px`,
                backgroundColor: "#ddd",
                borderRadius: "4px",
                marginBottom: "0.25rem",
              }}
            />
            <div
              style={{
                height: "0.75rem",
                width: "70px",
                backgroundColor: "#e5e5e5",
                borderRadius: "4px",
              }}
            />
          </div>
        ))}
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <div
          style={{
            height: "1rem",
            width: "80px",
            backgroundColor: "#ddd",
            borderRadius: "4px",
            marginBottom: "0.75rem",
          }}
        />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "0.25rem",
            }}
          >
            <div
              style={{
                height: "0.875rem",
                width: `${60 + i * 10}px`,
                backgroundColor: "#ddd",
                borderRadius: "4px",
              }}
            />
            <div
              style={{
                height: "0.875rem",
                width: "24px",
                backgroundColor: "#e5e5e5",
                borderRadius: "10px",
              }}
            />
          </div>
        ))}
      </section>

      <section>
        <div
          style={{
            height: "1rem",
            width: "50px",
            backgroundColor: "#ddd",
            borderRadius: "4px",
            marginBottom: "0.75rem",
          }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              style={{
                height: "1.25rem",
                width: `${50 + i * 10}px`,
                backgroundColor: "#e0e0e0",
                borderRadius: "4px",
              }}
            />
          ))}
        </div>
      </section>
    </aside>
  );
}
