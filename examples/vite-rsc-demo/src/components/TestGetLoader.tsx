"use client";

import { useEffect } from "react";
import { useFetchLoader } from "@rangojs/router/client";
import { TestGetLoader } from "../loaders/test-get-loader";

export function TestGetLoaderComponent() {
  const { data, isLoading, error, load } = useFetchLoader(TestGetLoader);

  useEffect(() => {
    // Test GET-based fetching (uses loader registry on server)
    load({ params: { id: "123", name: "test" } })
      .then((result) => {
        console.log("[TestGetLoaderComponent] GET result:", result);
      })
      .catch((err) => {
        console.error("[TestGetLoaderComponent] GET error:", err);
      });
  }, [load]);

  return (
    <div
      style={{
        border: "1px solid #ccc",
        padding: "1rem",
        margin: "1rem 0",
        borderRadius: "4px",
      }}
    >
      <h3>GET-based Loader Test (Registry)</h3>

      {isLoading && <p>Loading...</p>}

      {error && (
        <p style={{ color: "red" }}>Error: {error.message}</p>
      )}

      {data && (
        <div>
          <p>Message: {data.message}</p>
          <p>Method: {data.method}</p>
          <p>Params: {JSON.stringify(data.params)}</p>
          <p>Timestamp: {data.timestamp}</p>
        </div>
      )}

      <button
        onClick={() => load({ params: { id: "456", name: "refresh" } })}
        style={{ marginTop: "0.5rem" }}
      >
        Refetch with new params
      </button>
    </div>
  );
}
