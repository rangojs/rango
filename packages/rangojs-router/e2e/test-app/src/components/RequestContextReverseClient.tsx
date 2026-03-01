"use client";

import { useState } from "react";
import { testRequestContextReverse } from "../actions.js";

export function RequestContextReverseClient() {
  const [result, setResult] = useState<{
    blogIndex: string;
    blogPost: string;
    hrefIndex: string;
  } | null>(null);

  return (
    <div data-testid="request-context-reverse-section">
      <button
        data-testid="request-context-reverse-btn"
        onClick={async () => {
          const data = await testRequestContextReverse();
          setResult(data);
        }}
      >
        Test reverse()
      </button>
      {result && (
        <ul>
          <li data-testid="action-reverse-blog-index">{result.blogIndex}</li>
          <li data-testid="action-reverse-blog-post">{result.blogPost}</li>
          <li data-testid="action-reverse-href-index">{result.hrefIndex}</li>
        </ul>
      )}
    </div>
  );
}
