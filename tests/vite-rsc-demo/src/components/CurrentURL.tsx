"use client";

import { useEffect, useState } from "react";

/**
 * Client component that displays the CURRENT browser URL
 * Updates even when the parent segment doesn't re-render
 *
 * This demonstrates the difference between:
 * - Server state (frozen when segment not revalidated)
 * - Client state (always reflects current URL)
 */
export function CurrentURL() {
  const [url, setUrl] = useState("");
  const [queryParams, setQueryParams] = useState<[string, string][]>([]);

  useEffect(() => {
    const updateURL = () => {
      const currentUrl = new URL(window.location.href);
      setUrl(currentUrl.href);
      setQueryParams(Array.from(currentUrl.searchParams.entries()));
    };

    // Initial update
    updateURL();

    // Listen for URL changes (from our navigation system)
    const observer = new MutationObserver(updateURL);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-url-changed"],
    });

    // Also listen for popstate
    window.addEventListener("popstate", updateURL);

    // Fallback: poll every 100ms (catches manual history.pushState)
    const interval = setInterval(updateURL, 100);

    return () => {
      observer.disconnect();
      window.removeEventListener("popstate", updateURL);
      clearInterval(interval);
    };
  }, []);

  return (
    <div
      style={{
        background: "#e8f4f8",
        padding: "0.75rem",
        borderRadius: "4px",
        border: "2px solid #0066cc",
      }}
    >
      <div
        style={{
          marginBottom: "0.5rem",
          fontSize: "0.85rem",
          fontWeight: "bold",
          color: "#0066cc",
        }}
      >
        🌐 CURRENT Browser URL (Client Component)
      </div>
      <div style={{ fontSize: "0.8rem", marginBottom: "0.25rem" }}>
        <strong>Full URL:</strong>{" "}
        <code style={{ fontSize: "0.75rem" }}>{url}</code>
      </div>
      <div style={{ fontSize: "0.8rem" }}>
        <strong>Query Params:</strong>{" "}
        {queryParams.length > 0 ? (
          <code>{queryParams.map(([k, v]) => `${k}=${v}`).join("&")}</code>
        ) : (
          <em style={{ color: "#666" }}>none</em>
        )}
      </div>
      <p
        style={{
          fontSize: "0.7rem",
          color: "#0066cc",
          marginTop: "0.5rem",
          marginBottom: 0,
          fontStyle: "italic",
        }}
      >
        ↑ This updates on EVERY navigation (client-side, always current)
      </p>
    </div>
  );
}
