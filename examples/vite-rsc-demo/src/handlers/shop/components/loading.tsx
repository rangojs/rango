"use client";
import { useNavigation } from "rsc-router/browser";

export const LoadingSpinner = () => {
  const state = useNavigation((nav) => nav.state);
  const isStreaming = useNavigation((nav) => nav.isStreaming);
  const isLoading = state === "loading";

  console.log("loading:", { isLoading, isStreaming });

  return (
    <div
      style={{
        marginTop: "1rem",
        fontSize: "0.9rem",
        color: "#555",
        height: "1.5rem",
      }}
    >
      {isLoading && <span>Loading...</span>}
      {isStreaming && <span>Streaming...</span>}
    </div>
  );
};
