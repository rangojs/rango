"use client";

import { useTheme } from "fake-context-lib";

export function ContextDedupConsumer() {
  const theme = useTheme();
  return <p data-testid="context-dedup-value">{theme ?? "NOT_FOUND"}</p>;
}
