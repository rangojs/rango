"use client";

import React, { useState, useTransition } from "react";
import { createFromFetch } from "@vitejs/plugin-rsc/browser";
import type { RscPayload } from "./framework/entry.rsc";

export function DynamicRscLoader() {
  const [path, setPath] = useState("/my-test");
  const [rscContent, setRscContent] = useState<React.ReactNode | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const loadRscContent = async () => {
    setError(null);
    startTransition(async () => {
      try {
        // Fetch RSC content from the specified path
        const payload = await createFromFetch<RscPayload>(
          fetch(path, {
            headers: {
              // Ensure we're requesting RSC format
              accept: "text/x-component",
            },
          })
        );
        setRscContent(payload.root);
      } catch (err) {
        setError(`Failed to load RSC content from ${path}`);
        console.error(err);
      }
    });
  };

  return (
    <div className="dynamic-rsc-loader">
      <h3>Dynamic RSC Content Loader</h3>

      <div className="loader-controls">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Enter path (e.g., /my-test)"
          className="path-input"
        />
        <button onClick={loadRscContent} disabled={isPending}>
          {isPending ? "Loading..." : "Load RSC Content"}
        </button>
      </div>

      <div className="loader-hints">
        <p>Try these paths:</p>
        <ul>
          <li>
            <code>/my-test</code> - Custom test page
          </li>
          <li>
            <code>/</code> - Home page
          </li>
          <li>
            <code>/?__rsc</code> - Raw RSC stream
          </li>
        </ul>
      </div>

      {error && <div className="error-message">{error}</div>}

      {rscContent && (
        <div className="loaded-content">
          <h4>Loaded RSC Content:</h4>
          <div className="content-frame">{rscContent}</div>
        </div>
      )}
    </div>
  );
}
