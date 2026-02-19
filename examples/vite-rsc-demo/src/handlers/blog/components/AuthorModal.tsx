"use client";

import { Outlet, useLoader, Link } from "@rangojs/router/client";
import { BlogAuthorLoader } from "../loaders/author.js";

const styles = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "white",
    borderRadius: "12px",
    width: "90%",
    maxWidth: "500px",
    maxHeight: "80vh",
    overflow: "auto",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
  },
  header: {
    padding: "1.5rem",
    background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
    borderRadius: "12px 12px 0 0",
  },
  title: {
    margin: 0,
    color: "white",
    fontSize: "1.25rem",
  },
  body: {
    padding: "1.5rem",
  },
  bio: {
    color: "#475569",
    lineHeight: 1.6,
    marginBottom: "1.5rem",
  },
  actions: {
    display: "flex",
    gap: "0.75rem",
  },
  primaryButton: {
    flex: 1,
    background: "#3b82f6",
    color: "white",
    border: "none",
    padding: "0.75rem 1.5rem",
    borderRadius: "6px",
    cursor: "pointer",
    textDecoration: "none",
    textAlign: "center" as const,
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  closeButton: {
    background: "#f1f5f9",
    color: "#64748b",
    border: "none",
    padding: "0.75rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
};

export function AuthorModalWrapper() {
  function handleClose() {
    window.history.back();
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  return (
    <div style={styles.overlay} onClick={handleOverlayClick}>
      <div style={styles.modal}>
        <Outlet />
      </div>
    </div>
  );
}

export function AuthorModalContent() {
  const { data } = useLoader(BlogAuthorLoader);
  const author = data.author;
  const posts = data.posts;

  function handleClose() {
    window.history.back();
  }

  if (!author) {
    return (
      <div style={styles.body}>
        <p>Author not found.</p>
        <button style={styles.closeButton} onClick={handleClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <>
      <div style={styles.header}>
        Intercepted
        <h2 style={styles.title}>{author.name}</h2>
      </div>
      <div style={styles.body}>
        <p style={styles.bio}>{author.bio}</p>

        <div style={{ marginBottom: "1rem", color: "#64748b", fontSize: "0.875rem" }}>
          {posts.length} {posts.length === 1 ? "post" : "posts"} published
        </div>

        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1.5rem 0" }}>
          {posts.map((post) => (
            <li key={post.slug} style={{ marginBottom: "0.5rem" }}>
              <Link
                to={`/blog/${post.slug}`}
                style={{ color: "#3b82f6", textDecoration: "none" }}
              >
                {post.title}
              </Link>
              <span style={{ color: "#94a3b8", fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                {post.date}
              </span>
            </li>
          ))}
        </ul>

        <div style={styles.actions}>
          <Link
            to={`/blog/author/${author.slug}`}
            style={styles.primaryButton}
          >
            View Full Details
          </Link>
          <button style={styles.closeButton} onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

const skeletonStyle = {
  background:
    "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
  backgroundSize: "200% 100%",
  animation: "shimmer 1.5s infinite",
  borderRadius: "4px",
};

export function AuthorModalContentSkeleton() {
  return (
    <>
      <div style={styles.header}>
        <div
          style={{
            ...skeletonStyle,
            height: "24px",
            width: "60%",
            background: "rgba(255,255,255,0.3)",
          }}
        />
      </div>
      <div style={styles.body}>
        <div style={{ ...skeletonStyle, height: "16px", width: "100%", marginBottom: "0.5rem" }} />
        <div style={{ ...skeletonStyle, height: "16px", width: "90%", marginBottom: "0.5rem" }} />
        <div style={{ ...skeletonStyle, height: "16px", width: "75%", marginBottom: "1.5rem" }} />
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <div style={{ ...skeletonStyle, height: "44px", flex: 1 }} />
          <div style={{ ...skeletonStyle, height: "44px", width: "60px" }} />
        </div>
      </div>
    </>
  );
}
