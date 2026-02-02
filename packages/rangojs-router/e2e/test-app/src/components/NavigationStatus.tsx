"use client";

import { useNavigation } from "@rangojs/router/client";
import { useState, useEffect } from "react";

/**
 * Displays navigation state for testing useNavigation hook
 * Uses useEffect to avoid hydration mismatch for pathname
 */
export function NavigationStatus({ testId }: { testId: string }) {
  const nav = useNavigation();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div data-testid={testId}>
      <span data-testid={`${testId}-state`}>state:{nav.state}</span>
      <span data-testid={`${testId}-streaming`}>
        streaming:{nav.isStreaming ? "true" : "false"}
      </span>
      <span data-testid={`${testId}-pathname`}>
        path:{mounted ? nav.location.pathname : ""}
      </span>
    </div>
  );
}

/**
 * Displays navigation state with selector for testing
 */
export function NavigationStateOnly({ testId }: { testId: string }) {
  const state = useNavigation((nav) => nav.state);
  return <span data-testid={testId}>nav-state:{state}</span>;
}

/**
 * Displays isStreaming with selector for testing
 */
export function NavigationStreamingOnly({ testId }: { testId: string }) {
  const isStreaming = useNavigation((nav) => nav.isStreaming);
  return (
    <span data-testid={testId}>nav-streaming:{isStreaming ? "true" : "false"}</span>
  );
}
