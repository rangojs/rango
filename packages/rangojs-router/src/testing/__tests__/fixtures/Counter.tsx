"use client";
import { type ReactElement, type ReactNode, useState } from "react";

// A real client island. renderServerTree never executes it (deserialize-only),
// so the hook is never called; it exists to be registered as a client reference
// and to prove its props survive the serialize -> deserialize round trip.
export function Counter(props: {
  start: number;
  when: Date;
  tags: Map<string, number>;
  "data-testid"?: string;
  children?: ReactNode;
}): ReactElement {
  const [n, setN] = useState(props.start);
  return (
    <button
      data-testid={props["data-testid"] ?? "counter"}
      onClick={() => setN(n + 1)}
    >
      count: {n}
    </button>
  );
}
