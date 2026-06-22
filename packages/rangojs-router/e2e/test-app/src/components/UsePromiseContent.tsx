"use client";

import { use } from "react";

/**
 * Client component that resolves a promise prop with use() — the consumer pattern
 * "create the promise in the handler, pass it to a client component that use()s
 * it" (NOT an RSC async server component). Used to repro deferred-meta + streaming
 * content where both derive from the same handler-created promise.
 */
export function UsePromiseContent({
  promise,
}: {
  promise: Promise<{ title: string }>;
}) {
  const data = use(promise);
  return <div data-testid="use-promise-content">{data.title}</div>;
}
