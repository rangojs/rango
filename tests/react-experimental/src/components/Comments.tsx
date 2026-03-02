"use client";

import { useRef } from "react";
import { useLoader } from "@rangojs/router/client";
import { CommentsLoader } from "../loaders/comments.js";

interface CommentsProps {
  slug: string;
}

export function Comments({ slug }: CommentsProps) {
  const { data: comments, isLoading, load } = useLoader(CommentsLoader);
  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = async (formData: FormData) => {
    await load({ method: "POST", body: formData });
    formRef.current?.reset();
  };

  return (
    <section
      data-testid="comments-section"
      style={{
        marginTop: "2rem",
        borderTop: "1px solid #e5e7eb",
        paddingTop: "1.5rem",
      }}
    >
      <h3
        style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}
      >
        Comments ({comments.length})
      </h3>

      <form
        ref={formRef}
        data-testid="comment-form"
        action={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          marginBottom: "1.5rem",
        }}
      >
        <input type="hidden" name="slug" value={slug} />
        <input
          data-testid="comment-name"
          name="name"
          placeholder="Your name"
          required
          style={{
            padding: "0.5rem 0.75rem",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            fontSize: "0.9rem",
          }}
        />
        <textarea
          data-testid="comment-text"
          name="text"
          placeholder="Write a comment..."
          rows={3}
          required
          style={{
            padding: "0.5rem 0.75rem",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            fontSize: "0.9rem",
            resize: "vertical",
          }}
        />
        <button
          type="submit"
          data-testid="comment-submit"
          disabled={isLoading}
          style={{
            padding: "0.5rem 1rem",
            background: isLoading ? "#9ca3af" : "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: isLoading ? "not-allowed" : "pointer",
            fontSize: "0.9rem",
            fontWeight: 500,
            alignSelf: "flex-start",
          }}
        >
          {isLoading ? "Posting..." : "Post Comment"}
        </button>
      </form>

      {comments.length === 0 ? (
        <p
          data-testid="no-comments"
          style={{ color: "#9ca3af", fontStyle: "italic" }}
        >
          No comments yet. Be the first!
        </p>
      ) : (
        <div
          data-testid="comments-list"
          style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
        >
          {comments.map((comment) => (
            <div
              key={comment.id}
              data-testid={`comment-${comment.id}`}
              style={{
                padding: "1rem",
                background: "#f9fafb",
                borderRadius: "8px",
                border: "1px solid #f3f4f6",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "0.5rem",
                }}
              >
                <strong style={{ fontSize: "0.9rem" }}>{comment.name}</strong>
                <time style={{ color: "#9ca3af", fontSize: "0.8rem" }}>
                  {new Date(comment.createdAt).toLocaleTimeString()}
                </time>
              </div>
              <p
                style={{
                  color: "#374151",
                  lineHeight: 1.5,
                  fontSize: "0.9rem",
                  margin: 0,
                }}
              >
                {comment.text}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
