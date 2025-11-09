import React from "react";
import { Outlet } from "rsc-router/client";
const articles = [
  { id: 1, title: "Getting Started with RSC", date: "2024-01-15" },
  { id: 2, title: "Building Nested Layouts", date: "2024-01-14" },
  { id: 3, title: "Partial Rendering Explained", date: "2024-01-13" },
];
export default function ArticlesLayout() {
  console.log("[ArticlesLayout] Rendering");

  return (
    <div>
      <div
        style={{
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          color: "white",
          padding: "2rem",
          borderRadius: "8px",
          marginBottom: "2rem",
        }}
      >
        <h1>Articles & Blog</h1>
        <p>Read our latest insights and tutorials</p>
        <ul>
          {articles.map((article) => (
            <li key={article.id}>
              <a href={`/articles/${article.id}`}>Read more {article.id} →</a>
            </li>
          ))}
        </ul>
      </div>
      <Outlet />
    </div>
  );
}
